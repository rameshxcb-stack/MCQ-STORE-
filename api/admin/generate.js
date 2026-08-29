// api/admin/generate.js - ✅ Fully Fixed & Production Ready

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
};

// ============================================================
// 🔧 MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'ERROR', error: 'METHOD_NOT_ALLOWED', message: 'Only POST requests allowed.' });
  }

  // 🛠️ 1. URL and TOKEN SANITIZATION (Fixes 401 Unauthorized Issue)
  const rawUrl = (process.env.TURSO_DATABASE_URL || '').trim();
  const rawToken = (process.env.TURSO_AUTH_TOKEN || '').trim();

  if (!rawUrl || !rawToken) {
    return res.status(500).json({
      status: 'ERROR',
      error: 'MISSING_CREDENTIALS',
      message: 'Vercel Environment Variables (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN) set nahi hain.'
    });
  }

  // Token se extra quotes, spaces, aur "Bearer " prefix clean karein
  const cleanToken = rawToken
    .replace(/^Bearer\s+/i, '')
    .replace(/["'\s\r\n]/g, '')
    .trim();

  const cleanUrl = rawUrl.replace('libsql://', 'https://').replace(/\/$/, '');
  const endpoint = `${cleanUrl}/v2/pipeline`;

  // 🛡️ 2. Safe Body Parsing
  let bodyData = {};
  try {
    bodyData = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ status: 'ERROR', error: 'INVALID_JSON', message: 'Invalid JSON in request body.' });
  }

  const { action, queryType, args = [] } = bodyData;

  // ============================================================
  // 🚀 ACTION 1: QUERY EXECUTOR (Fast SQL Proxy)
  // ============================================================
  if (action === 'query' || queryType) {
    const finalQueryType = queryType || 'check_connection';
    const queryConfig = QUERY_REGISTRY[finalQueryType];

    if (!queryConfig) {
      return res.status(403).json({
        status: 'ERROR',
        error: 'INVALID_QUERY',
        message: `Query type "${finalQueryType}" is not allowed.`
      });
    }

    const queryToExecute = queryConfig.sql;
    const expectedArgNames = queryConfig.args;

    if (!Array.isArray(args) || args.length !== expectedArgNames.length) {
      return res.status(400).json({
        status: 'ERROR',
        error: 'INVALID_ARGS',
        message: `Expected ${expectedArgNames.length} argument(s) but received ${args.length}.`
      });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8500);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cleanToken}`, // ✅ Clean Token Used Here
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
          message: '✅ Query executed successfully!',
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
  // ⚙️ ACTION 2: TASK PROCESSOR (Background AI Generation)
  // ============================================================
  if (action === 'processTask') {
    const reqAdminKey = req.headers['x-admin-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');

    if (!ADMIN_KEY || reqAdminKey !== ADMIN_KEY) {
      return res.status(403).json({
        status: 'ERROR',
        error: 'UNAUTHORIZED',
        message: 'Invalid or missing Admin API Key (x-admin-key header).'
      });
    }

    try {
      const db = getDb();

      const { rows: tasks } = await db.execute({
        sql: `SELECT * FROM generation_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
      });

      if (!tasks || tasks.length === 0) {
        return res.status(200).json({ status: 'SUCCESS', message: '✅ No pending tasks' });
      }

      const task = tasks[0];

      await db.execute({
        sql: `UPDATE generation_tasks SET status = 'in_progress' WHERE id = ?`,
        args: [task.id]
      });

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

      let evidenceText = task.evidence || '';
      if (!evidenceText && task.subject && task.chapter) {
        try {
          evidenceText = await retrieveEvidence(task.subject, task.chapter);
        } catch (e) {
          console.warn('⚠️ Evidence retrieval failed:', e.message);
        }
      }

      const result = await generateAndStoreMCQs({
        subject: task.subject,
        chapter: task.chapter,
        rawMCQsInput: rawMCQs,
        evidenceText: evidenceText
      });

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

  return res.status(400).json({
    status: 'ERROR',
    error: 'INVALID_ACTION',
    message: 'Request body mein "action" bhejien: "query" ya "processTask".'
  });
}
