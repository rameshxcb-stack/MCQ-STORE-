export default async function handler(req, res) {
  // 1. Security Headers
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // 2. Fetch credentials from Environment Variables
  const rawUrl = process.env.TURSO_DATABASE_URL || '';
  const rawToken = process.env.TURSO_AUTH_TOKEN || '';

  if (!rawUrl || !rawToken) {
    return res.status(500).json({
      status: 'ERROR',
      message: 'Environment variables (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN) missing in Vercel.'
    });
  }

  // 3. Safe Base64 Decoding (Prevent UTF-8 Encoding Shift)
  let cleanToken = rawToken.trim();
  if (!cleanToken.startsWith('eyJ')) {
    try {
      cleanToken = Buffer.from(cleanToken, 'base64').toString('utf-8').trim();
    } catch (err) {
      return res.status(500).json({
        status: 'ERROR',
        message: 'Token Base64 decoding failed on server.'
      });
    }
  }

  // 4. Endpoint conversion (libsql:// -> https://)
  const cleanUrl = rawUrl.replace('libsql://', 'https://').replace(/\/$/, '');
  const endpoint = `${cleanUrl}/v2/pipeline`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cleanToken}`,
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
        message: '🎉 100% Secure & Working: Vercel Base64 Token Connected to Turso DB!',
        data: data.results?.[0]?.response?.result || data
      });
    } else {
      return res.status(response.status).json({
        status: 'TURSO_ERROR',
        http_code: response.status,
        details: data
      });
    }

  } catch (err) {
    return res.status(500).json({
      status: 'SERVER_ERROR',
      error: err.message || String(err)
    });
  }
}
