const ADMIN_KEY = process.env.ADMIN_API_KEY;

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // 1. TURSO DIAGNOSTIC TEST (GET ya POST dono me chalega)
  if (req.query?.test === 'turso' || req.method === 'GET') {
    const rawUrl = process.env.TURSO_DATABASE_URL || '';
    const rawToken = process.env.TURSO_AUTH_TOKEN || '';

    const cleanUrl = rawUrl.trim().replace(/^["']|["']$/g, '');
    const cleanToken = rawToken.trim().replace(/^["']|["']$/g, '').replace(/^Bearer\s+/i, '');

    const debugInfo = {
      urlPresent: Boolean(cleanUrl),
      urlPrefix: cleanUrl ? cleanUrl.substring(0, 15) + '...' : 'NONE',
      tokenPresent: Boolean(cleanToken),
      tokenLength: cleanToken.length,
      tokenFirst5Chars: cleanToken ? cleanToken.substring(0, 5) : 'NONE',
      tokenLast5Chars: cleanToken ? cleanToken.substring(cleanToken.length - 5) : 'NONE',
      hasQuotes: rawToken.includes('"') || rawToken.includes("'"),
    };

    let connectionResult = 'UNKNOWN';
    let rawErrorDetails = null;

    try {
      let mcqModule = await import('../../lib/mcq-generator.js');
      const db = mcqModule.getDb();
      await db.execute("SELECT 1");
      connectionResult = 'SUCCESS: Turso Connected!';
    } catch (err) {
      connectionResult = 'FAILED: Turso rejected connection';
      rawErrorDetails = {
        name: err.name,
        message: err.message,
        statusCode: err.status || err.statusCode || 401,
        fullError: String(err)
      };
    }

    return res.status(200).json({
      status: 'Diagnostic Mode Active',
      environmentDebug: debugInfo,
      connectionTest: connectionResult,
      errorDetails: rawErrorDetails
    });
  }

  // 2. NORMAL FLOW FOR POST REQUESTS
  if (ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  let mcqModule;
  try {
    mcqModule = await import('../../lib/mcq-generator.js');
  } catch (importErr) {
    return res.status(500).json({
      error: 'Failed to import lib/mcq-generator.js module',
      details: importErr.message
    });
  }

  const { generateAndStoreMCQs, retrieveEvidence, getDb } = mcqModule;

  try {
    const db = getDb();

    const tasksResult = await db.execute("SELECT * FROM generation_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1");
    const tasks = tasksResult?.rows || [];

    if (!tasks || tasks.length === 0) {
      return res.status(200).json({ message: 'No pending tasks' });
    }

    const task = tasks[0];

    await db.execute({ 
      sql: `UPDATE generation_tasks SET status = 'in_progress' WHERE id = ?`, 
      args: [task.id] 
    });

    let rawMCQs = [];
    const mcqData = task ? (task.raw_mcqs || task.payload || task.raw_data) : null;

    if (mcqData) {
      try {
        const parsed = typeof mcqData === 'string' ? JSON.parse(mcqData) : mcqData;
        if (parsed && Array.isArray(parsed)) {
          rawMCQs = parsed;
        } else if (parsed && typeof parsed === 'object') {
          rawMCQs = parsed.mcqs || parsed.questions || [parsed];
        }
      } catch (err) {
        console.warn('⚠️ Could not parse JSON payload:', err.message);
        rawMCQs = [];
      }
    }

    let evidenceText = task?.evidence || '';
    if (!evidenceText && task?.subject && task?.chapter) {
      try {
        evidenceText = await retrieveEvidence(task.subject, task.chapter);
      } catch (e) {
        console.warn('⚠️ Evidence retrieval failed:', e.message);
      }
    }

    const result = await generateAndStoreMCQs({
      subject: task?.subject || '',
      chapter: task?.chapter || '',
      rawMCQsInput: Array.isArray(rawMCQs) ? rawMCQs : [],
      evidenceText: evidenceText || ''
    });

    const nextStatus = result?.success ? 'completed' : 'failed';
    await db.execute({ 
      sql: `UPDATE generation_tasks SET status = ? WHERE id = ?`, 
      args: [nextStatus, task.id] 
    });

    return res.status(200).json({ success: true, taskId: task.id, result });

  } catch (e) {
    console.error('❌ Task Execution Error:', e);
    return res.status(500).json({ 
      error: e?.message || 'Internal server error',
      stack: e?.stack || 'No stack trace available'
    });
  }
}
