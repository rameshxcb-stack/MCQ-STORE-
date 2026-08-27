export default async function handler(req, res) {
  // Response type always JSON set karein
  res.setHeader('Content-Type', 'application/json');

  // Vercel Environment Variables Read karein
  const rawUrl = process.env.TURSO_DATABASE_URL || '';
  const token = process.env.TURSO_AUTH_TOKEN || '';

  // Safe Environment Variables Check
  if (!rawUrl || !token) {
    return res.status(400).json({
      status: 'MISSING_ENV',
      message: 'Vercel Environment Variables (TURSO_DATABASE_URL ya TURSO_AUTH_TOKEN) nahi mile.'
    });
  }

  // libsql:// ko https:// me convert karke pipeline endpoint tayar karein
  const endpoint = rawUrl.replace('libsql://', 'https://').replace(/\/$/, '') + '/v2/pipeline';

  try {
    // Direct HTTP Pipeline Fetch Request
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token.trim()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          { type: "execute", stmt: { sql: "SELECT 1 as test;" } },
          { type: "close" }
        ]
      })
    });

    const data = await response.json();

    if (response.ok) {
      // Direct success response pass karein
      return res.status(200).json({
        status: 'SUCCESS',
        message: 'Database query executed successfully!',
        result: data.results[0]?.response?.result || data
      });
    } else {
      return res.status(response.status).json({
        status: 'DATABASE_ERROR',
        http_status: response.status,
        turso_error: data
      });
    }

  } catch (err) {
    return res.status(500).json({
      status: 'SERVER_ERROR',
      error: err.message || String(err)
    });
  }
}
