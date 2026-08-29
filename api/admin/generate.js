// api/admin/generate.js - ✅ Query Executor + Task Processor (Only token sanitized, URL untouched)

import { generateAndStoreMCQs, retrieveEvidence, getDb } from '../../lib/mcq-generator.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY;

// ============================================================
// 📌 QUERY REGISTRY (Secure SQL Proxy)
// ============================================================
const QUERY_REGISTRY = {
  'check_connection': {
    sql: 'SELECT 1 as is_active;',
    args: []
  },
  'get_mcqs_by_chapter': {
    sql: 'SELECT * FROM mcqs WHERE chapter = ? ORDER BY RANDOM() LIMIT 25;',
    args: ['chapter']
  },
  // ➕ आप अपनी और Queries यहाँ जोड़ सकते हैं
};

// ============================================================
// 🔧 MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'ERROR', error: 'METHOD_NOT_ALLOWED', message: 'Only POST requests allowed.' });
  }

  // Environment Variables
  let rawUrl = process.env.TURSO_DATABASE_URL || '';
  let rawToken = process.env.TURSO_AUTH_TOKEN || '';

  if (!rawUrl || !rawToken) {
    return res.status(500).json({
      status: 'ERROR',
      error: 'MISSING_CREDENTIALS',
      message: 'Vercel Environment Variables (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN) set nahi hain.'
    });
  }

  // ✅ Sanitize Token & URL (URL is sanitized for fetch, but we keep original for lib)
  const cleanToken = rawToken.replace(/["'\s\r\n]/g, '').trim();
  const cleanUrl = rawUrl.replace('libsql://', 'https://').replace(/\/$/, '');
  const endpoint = `${cleanUrl}/v2/pipeline`;

  // ✅ CRITICAL FIX: Override ONLY the token in environment.
  // Leave TURSO_DATABASE_URL untouched (it's libsql://) so @libsql/client works.
  process.env.TURSO_AUTH_TOKEN = cleanToken;
  // Do NOT override process.env.TURSO_DATABASE_URL

  // Parse Body
  const bodyData = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { action, queryType, args = [] } = bodyData;

  // ============================================================
  // 🚀 ACTION 1: QUERY EXECUTOR (Public – No Admin Key)
  // ============================================================
  if (action === 'query' || queryType) {
    const finalQueryType = queryType || 'check_connection';
    const queryConfig = QUERY_REGISTRY[finalQueryType];

    if (!queryConfig) {
      return res.status(403).json({
        status: 'ERROR',
        error: 'INVALID_QUERY',
        message: `Query type "${finalQueryType}" allowed nahi hai. Available: ${Object.keys(QUERY_REGISTRY).join(', ')}`
      });
    }

    const queryToExecute = queryConfig.sql;
    const expectedArgNames = queryConfig.args;

    if (args.length !== expectedArgNames.length) {
      return res.status(400).json({
        status: 'ERROR',
        error: 'INVALID_ARGS',
        message: `${expectedArgNames.length} argument(s) chahiye, par ${args.length} mile.`
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8500);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cleanToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [
            { type: "execute", stmt: { sql: queryToExecute, args: args } },
            { type: "close" }
          ]
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const data = await response.json();

      if (response.ok) {
        return res.status(200).json({
          status: 'SUCCESS',
          message: '✅ Query execute ho gayi!',
          data: data.results?.[0]?.response?.result || data
        });
      } else {
        console.error('Turso Error:', response.status, data);
        return res.status(response.status).json({
          status: 'ERROR',
          error: 'TURSO_ERROR',
          details: data
        });
      }

    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        return res.status(504).json({ status: 'ERROR', error: 'TIMEOUT' });
      }
      return res.status(500).json({
        status: 'ERROR',
        error: 'SERVER_ERROR',
        message: err.message
      });
    }
  }

  // ============================================================
  // ⚙️ ACTION 2: TASK PROCESSOR (Admin – Requires x-admin-key)
  // ============================================================
  if (action === 'processTask') {
    // ✅ Admin Key Check
    const reqAdminKey = req.headers['x-admin-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');

    if (!ADMIN_KEY || reqAdminKey !== ADMIN_KEY) {
      return res.status(403).json({
        status: 'ERROR',
        error: 'UNAUTHORIZED',
        message: 'Invalid or missing Admin API Key (x-admin-key header).'
      });
    }

    try {
      const db = getDb(); // ✅ Now uses sanitized token (overridden) and original libsql:// URL

      // 1. Fetch Pending Task
      const { rows: tasks } = await db.execute({
        sql: `SELECT * FROM generation_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
      });

      if (!tasks || tasks.length === 0) {
        return res.status(200).json({ status: 'SUCCESS', message: '✅ No pending tasks' });
      }

      const task = tasks[0];

      // 2. Mark Task as In Progress
      await db.execute({
        sql: `UPDATE generation_tasks SET status = 'in_progress' WHERE id = ?`,
        args: [task.id]
      });

      // 3. Parse Raw MCQs
      let rawMCQs = [];
      const mcqData = task.raw_mcqs || task.payload || task.raw_data;

      if (mcqData) {
        try {
          rawMCQs = typeof mcqData === 'string' ? JSON.parse(mcqData) : mcqData;
          if (!Array.isArray(rawMCQs) && typeof rawMCQs === 'object') {
            rawMCQs = rawMCQs.mcqs || rawMCQs.questions || [rawMCQs];
          }
        } catch (err) {
          console.warn('⚠️ Could not parse JSON from task payload:', err.message);
        }
      }

      // 4. Retrieve Evidence
      let evidenceText = task.evidence || '';
      if (!evidenceText && task.subject && task.chapter) {
        try {
          evidenceText = await retrieveEvidence(task.subject, task.chapter);
        } catch (e) {
          console.warn('⚠️ Evidence retrieval failed:', e.message);
        }
      }

      // 5. Generate & Store MCQs (lib will use sanitized token from env)
      const result = await generateAndStoreMCQs({
        subject: task.subject,
        chapter: task.chapter,
        rawMCQsInput: rawMCQs,
        evidenceText: evidenceText
      });

      // 6. Update Task Status
      const nextStatus = result.success ? 'completed' : 'failed';
      await db.execute({
        sql: `UPDATE generation_tasks SET status = ? WHERE id = ?`,
        args: [nextStatus, task.id]
      });

      return res.status(200).json({ status: 'SUCCESS', taskId: task.id, result });

    } catch (e) {
      console.error('❌ Task Execution Error:', e);
      return res.status(500).json({ status: 'ERROR', error: e.message || 'Internal server error' });
    }
  }

  // Default
  return res.status(400).json({
    status: 'ERROR',
    error: 'INVALID_ACTION',
    message: 'Request body mein "action" bhejien: "query" ya "processTask".'
  });
}
