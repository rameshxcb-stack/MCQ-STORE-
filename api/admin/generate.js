const ADMIN_KEY = process.env.ADMIN_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (ADMIN_KEY && req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // ✅ Fix: api/admin/ folder ke liye ../../ (double dot) zaroori hai
  let mcqModule;
  try {
    mcqModule = await import('../../lib/mcq-generator.js');
  } catch (importErr) {
    return res.status(500).json({
      error: 'Failed to import lib/mcq-generator.js module from api/admin/',
      details: importErr.message
    });
  }

  const { generateAndStoreMCQs, retrieveEvidence, getDb } = mcqModule;

  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;

  if (!tursoUrl || !tursoToken) {
    return res.status(500).json({ error: 'Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN environment variable' });
  }

  try {
    const db = getDb();

    const { rows: tasks } = await db.execute({
      sql: `SELECT * FROM generation_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
    });

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
        console.warn('⚠️ Could not parse JSON from task payload:', err.message);
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
