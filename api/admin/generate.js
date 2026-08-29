// api/admin/generate.js - ✅ Robust Fallback Added

const QUERY_REGISTRY = {
  'check_connection': {
    sql: 'SELECT 1 as is_active;',
    args: []
  },
  // अपनी और Queries यहाँ जोड़ें...
};

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Environment Variables
  let rawUrl = process.env.TURSO_DATABASE_URL || '';
  let rawToken = process.env.TURSO_AUTH_TOKEN || '';

  if (!rawUrl || !rawToken) {
    return res.status(400).json({
      status: 'ERROR',
      error: 'MISSING_CREDENTIALS',
      message: 'Vercel Environment Variables set nahi hain.'
    });
  }

  const cleanToken = rawToken.replace(/["'\s\r\n]/g, '').trim();
  const cleanUrl = rawUrl.replace('libsql://', 'https://').replace(/\/$/, '');
  const endpoint = `${cleanUrl}/v2/pipeline`;

  // ✅ Robust Body Parsing + Multiple Key Support (आपका दिया हुआ Solution)
  const bodyData = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  
  // ✅ यहाँ queryType, query, type – तीनों को Support करता है
  const queryType = bodyData.queryType || bodyData.query || bodyData.type || 'check_connection';
  const args = bodyData.args || [];

  // अगर queryType अभी भी empty है, तो error दें
  if (!queryType) {
    return res.status(400).json({
      status: 'ERROR',
      error: 'MISSING_QUERY_TYPE',
      message: 'Payload mein queryType, query, ya type key bhejna zaroori hai.'
    });
  }

  const queryConfig = QUERY_REGISTRY[queryType];
  if (!queryConfig) {
    return res.status(403).json({
      status: 'ERROR',
      error: 'INVALID_QUERY',
      message: `Query type "${queryType}" allowed nahi hai. Available: ${Object.keys(QUERY_REGISTRY).join(', ')}`
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
