// api/admin/generate.js - ✅ Ultimate Secure Version (SQL Injection Proof)

// 🛡️ 1. Query Registry (सभी अनुमत Queries यहाँ Hardcoded हैं)
const QUERY_REGISTRY = {
  // Connection Test Query (बिना पैरामीटर)
  'check_connection': {
    sql: 'SELECT 1 as is_active;',
    args: []
  },
  
  // उदाहरण: ID से User ढूंढना (पैरामीटर के साथ)
  'get_user': {
    sql: 'SELECT * FROM users WHERE id = ?;',
    args: ['userId']
  },
  
  // उदाहरण: Active Users
  'get_active_users': {
    sql: 'SELECT * FROM users WHERE active = ?;',
    args: ['status']
  }
  
  // ➕ आप अपनी ज़रूरत की और Queries यहाँ जोड़ सकते हैं
  // 'your_query_name': { sql: 'SELECT ...', args: ['param1', 'param2'] }
};

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Handle CORS Preflight (OPTIONS request)
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 1. Environment Variables पढ़ें (ये Vercel Dashboard में सेव हैं)
  let rawUrl = process.env.TURSO_DATABASE_URL || '';
  let rawToken = process.env.TURSO_AUTH_TOKEN || '';

  if (!rawUrl || !rawToken) {
    return res.status(400).json({
      status: 'ERROR',
      error: 'MISSING_CREDENTIALS',
      message: 'Vercel Environment Variables (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN) set nahi hain.'
    });
  }

  // 2. Vercel Runtime Quirk Fix (Hidden Characters हटाएँ)
  const cleanToken = rawToken.replace(/["'\s\r\n]/g, '').trim();
  const cleanUrl = rawUrl.replace('libsql://', 'https://').replace(/\/$/, '');
  const endpoint = `${cleanUrl}/v2/pipeline`;

  // 3. 🛡️ Client से सिर्फ queryType और args लें (SQL नहीं!)
  const { queryType, args = [] } = req.body || {};

  // 4. 🛡️ Whitelist Check – क्या यह Query Registry में है?
  const queryConfig = QUERY_REGISTRY[queryType];
  if (!queryConfig) {
    return res.status(403).json({
      status: 'ERROR',
      error: 'INVALID_QUERY',
      message: `Query type "${queryType}" allowed nahi hai.`
    });
  }

  // 5. Registry से Hardcoded SQL लें
  const queryToExecute = queryConfig.sql;
  const expectedArgNames = queryConfig.args;

  // 6. सुनिश्चित करें कि Args की संख्या सही है
  if (args.length !== expectedArgNames.length) {
    return res.status(400).json({
      status: 'ERROR',
      error: 'INVALID_ARGS',
      message: `${expectedArgNames.length} argument(s) chahiye, par ${args.length} mile.`
    });
  }

  // 7. Timeout Handle (8.5 सेकंड)
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
          { 
            type: "execute", 
            stmt: { 
              sql: queryToExecute, 
              args: args  // Turso इसे सुरक्षित (Parameterized) तरीके से Handle करेगा
            } 
          },
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
