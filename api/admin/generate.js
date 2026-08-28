export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // 1. Fetch credentials strictly from Vercel Environment Variables
  const rawUrl = process.env.TURSO_DATABASE_URL || '';
  const rawToken = process.env.TURSO_AUTH_TOKEN || '';

  // 2. Strict sanitization to prevent key corruption or unwanted space issues
  const token = rawToken.replace(/["'\s\r\n]/g, '').trim();
  let cleanUrl = rawUrl.replace(/["'\s\r\n]/g, '').trim();

  // 3. Validation for missing environment variables
  if (!cleanUrl || !token) {
    return res.status(400).json({
      status: 'MISSING_ENV_VARIABLES',
      message: 'Vercel Environment Variables (TURSO_DATABASE_URL ya TURSO_AUTH_TOKEN) nahi mile.',
      debug_info: {
        has_url: Boolean(cleanUrl),
        has_token: Boolean(token)
      }
    });
  }

  // 4. Endpoint conversion (libsql:// -> https://)
  cleanUrl = cleanUrl.replace('libsql://', 'https://').replace(/\/$/, '');
  const endpoint = `${cleanUrl}/v2/pipeline`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          { type: "execute", stmt: { sql: "SELECT 1 as is_active;" } },
          { type: "close" }
        ]
      })
    });

    const data = await response.json();

    if (response.ok) {
      return res.status(200).json({
        status: 'SUCCESS',
        message: '🎉 Vercel Environment Variables se Turso DB successfully connect ho gaya!',
        data: data.results?.[0]?.response?.result || data
      });
    } else {
      return res.status(response.status).json({
        status: 'TURSO_AUTH_OR_EXEC_ERROR',
        http_code: response.status,
        turso_response: data
      });
    }

  } catch (err) {
    return res.status(500).json({
      status: 'SERVER_ERROR',
      error_message: err.message || String(err)
    });
  }
}
