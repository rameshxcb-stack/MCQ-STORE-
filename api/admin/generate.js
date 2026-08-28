export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // Read & sanitize environment variables
  const rawUrl = process.env.TURSO_DATABASE_URL || '';
  const rawToken = process.env.TURSO_AUTH_TOKEN || '';

  // Remove hidden characters, quotes, and whitespace
  const token = rawToken.replace(/["'\s\r\n]/g, '');
  let cleanUrl = rawUrl.replace(/["'\s\r\n]/g, '');

  // Validate credentials
  if (!cleanUrl || !token) {
    return res.status(400).json({
      status: 'MISSING_CREDENTIALS',
      message: 'TURSO_DATABASE_URL or TURSO_AUTH_TOKEN not found in environment variables.'
    });
  }

  // Convert libsql:// to https:// and remove trailing slash
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
        message: '🎉 Vercel Function & Turso DB Connected Successfully!',
        data: data.results?.[0]?.response?.result || data
      });
    } else {
      // Log the full error for debugging
      console.error('Turso Error:', response.status, data);
      return res.status(response.status).json({
        status: 'TURSO_ERROR',
        http_code: response.status,
        turso_response: data
      });
    }

  } catch (err) {
    console.error('Server Error:', err);
    return res.status(500).json({
      status: 'SERVER_ERROR',
      error_message: err.message || String(err)
    });
  }
}
