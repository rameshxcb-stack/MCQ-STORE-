// api/admin/generate.js - ✅ Final Fix: Task Processor uses direct client, no cache issue

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const QUERY_REGISTRY = {
  'check_connection': { sql: 'SELECT 1 as is_active;', args: [] },
  'get_mcqs_by_chapter': { sql: 'SELECT * FROM mcqs WHERE chapter = ? ORDER BY RANDOM() LIMIT 25;', args: ['chapter'] },
};

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'ERROR', error: 'METHOD_NOT_ALLOWED', message: 'Only POST requests allowed.' });
  }

  const rawUrl = process.env.TURSO_DATABASE_URL || '';
  const rawToken = process.env.TURSO_AUTH_TOKEN || '';

  if (!rawUrl || !rawToken) {
    return res.status(500).json({ status: 'ERROR', error: 'MISSING_CREDENTIALS', message: 'Env vars missing.' });
  }

  const cleanToken = rawToken.replace(/["'\s\r\n]/g, '').trim();
  const cleanUrl = rawUrl.replace('libsql://', 'https://').replace(/\/$/, '');
  const endpoint = `${cleanUrl}/v2/pipeline`;

  const bodyData = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { action, queryType, args = [] } = bodyData;

  // ============================================================
  // 🚀 ACTION 1: QUERY EXECUTOR (Public – No Admin Key)
  // ============================================================
  if (action === 'query' || queryType) {
    const finalQueryType = queryType || 'check_connection';
    const queryConfig = QUERY_REGISTRY[finalQueryType];
    if (!queryConfig) {
      return res.status(403).json({ status: 'ERROR', error: 'INVALID_QUERY', message: `Query type "${finalQueryType}" not allowed.` });
    }
    const queryToExecute = queryConfig.sql;
    const expectedArgNames = queryConfig.args;
    if (args.length !== expectedArgNames.length) {
      return res.status(400).json({ status: 'ERROR', error: 'INVALID_ARGS', message: `Expected ${expectedArgNames.length} args, got ${args.length}.` });
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8500);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cleanToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [ { type: "execute", stmt: { sql: queryToExecute, args } }, { type: "close" } ] }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const data = await response.json();
      if (response.ok) {
        return res.status(200).json({ status: 'SUCCESS', message: '✅ Query executed!', data: data.results?.[0]?.response?.result || data });
      } else {
        console.error('Turso Error:', response.status, data);
        return res.status(response.status).json({ status: 'ERROR', error: 'TURSO_ERROR', details: data });
      }
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') return res.status(504).json({ status: 'ERROR', error: 'TIMEOUT' });
      return res.status(500).json({ status: 'ERROR', error: 'SERVER_ERROR', message: err.message });
    }
  }

  // ============================================================
  // ⚙️ ACTION 2: TASK PROCESSOR (Admin – Requires x-admin-key)
  // ============================================================
  if (action === 'processTask') {
    // Admin Key Check
    const reqAdminKey = req.headers['x-admin-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (!ADMIN_KEY || reqAdminKey !== ADMIN_KEY) {
      return res.status(403).json({ status: 'ERROR', error: 'UNAUTHORIZED', message: 'Invalid Admin Key.' });
    }

    try {
      // ✅ Create a brand new client DIRECTLY with sanitized token and original URL
      const { createClient } = await import('@libsql/client');
      const db = createClient({ url: rawUrl, authToken: cleanToken });

      // ✅ Execute a simple test query to confirm connection
      const { rows } = await db.execute({
        sql: 'SELECT 1 as connection_test;'
      });

      // If we reach here, token and URL are 100% valid
      return res.status(200).json({
        status: 'SUCCESS',
        message: '✅ Task Processor connected successfully!',
        data: rows
      });

    } catch (e) {
      console.error('❌ Task Processor Error:', e);
      return res.status(500).json({ status: 'ERROR', error: e.message || 'Internal server error' });
    }
  }

  // Default
  return res.status(400).json({ status: 'ERROR', error: 'INVALID_ACTION', message: 'Send "query" or "processTask".' });
}
