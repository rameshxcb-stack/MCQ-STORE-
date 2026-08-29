// api/admin/generate.js - ✅ बस trim() करो, बाकी सब सही है

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ✅ Environment Variables से लें और trim() करें
  const url = (process.env.TURSO_DATABASE_URL || '').trim();
  const token = (process.env.TURSO_AUTH_TOKEN || '').trim();

  if (!url || !token) {
    return res.status(500).json({ error: 'Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN' });
  }

  // ✅ URL को HTTPS में बदलें
  const cleanUrl = url.replace('libsql://', 'https://').replace(/\/$/, '');
  const endpoint = `${cleanUrl}/v2/pipeline`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`, // ✅ Token सीधा भेजें (बिना किसी बदलाव के)
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
        message: '✅ Connected!',
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
    console.error('Server Error:', err);
    return res.status(500).json({
      status: 'ERROR',
      error: 'SERVER_ERROR',
      message: err.message
    });
  }
}
