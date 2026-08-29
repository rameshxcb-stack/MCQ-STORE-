// api/admin/generate.js - ✅ बिल्कुल HTML Demo वाला Code

const QUERY_REGISTRY = {
  'check_connection': {
    sql: 'SELECT 1 as is_active;',
    args: []
  },
};

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ✅ Environment Variables
  let rawUrl = process.env.TURSO_DATABASE_URL || '';
  let rawToken = process.env.TURSO_AUTH_TOKEN || '';

  if (!rawUrl || !rawToken) {
    return res.status(500).json({
      status: 'ERROR',
      error: 'MISSING_CREDENTIALS',
      message: 'Vercel Environment Variables set nahi hain.'
    });
  }

  // ✅ Sanitize Token & URL
  const cleanToken = rawToken.replace(/["'\s\r\n]/g, '').trim();
  const cleanUrl = rawUrl.replace('libsql://', 'https://').replace(/\/$/, '');
  const endpoint = `${cleanUrl}/v2/pipeline`;

  // ✅ Parse Body (बिल्कुल HTML Demo जैसा)
  const bodyData = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  const { action, queryType, args = [] } = bodyData;

  // ✅ अगर action: "query" या queryType मौजूद है – तो Query चलाएँ
  if (action === 'query' || queryType) {
    const finalQueryType = queryType || 'check_connection';
    const queryConfig = QUERY_REGISTRY[finalQueryType];

    if (!queryConfig) {
      return res.status(403).json({
        status: 'ERROR',
        error: 'INVALID_QUERY',
        message: `Query type "${finalQueryType}" allowed nahi hai.`
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
        })
      });

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
      return res.status(500).json({
        status: 'ERROR',
        error: 'SERVER_ERROR',
        message: err.message
      });
    }
  }

  // ✅ अगर कोई action नहीं है – तो Error दें
  return res.status(400).json({
    status: 'ERROR',
    error: 'MISSING_ACTION',
    message: 'Request body mein "action": "query" bhejna zaroori hai.'
  });
}
