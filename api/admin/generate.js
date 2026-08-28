export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // 1. Fetch Environment Variables
  const rawUrl = process.env.TURSO_DATABASE_URL || '';
  const rawToken = process.env.TURSO_AUTH_TOKEN || '';

  if (!rawUrl || !rawToken) {
    return res.status(400).json({
      status: 'MISSING_ENV',
      message: 'Vercel Environment Variables (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN) nahi mile.'
    });
  }

  // 2. ✅ FIX: Strict Sanitizer - Sirf Vercel ke injected garbage (newline, space, quotes) hataye, JWT ke valid chars ko nahi chhede.
  const cleanToken = rawToken.replace(/["'\s\r\n]/g, '').trim();

  // 3. Format URL
  const cleanUrl = rawUrl.replace('libsql://', 'https://').replace(/\/$/, '');
  const endpoint = `${cleanUrl}/v2/pipeline`;

  // 4. ✅ Professional Addition: AbortController (8.5 seconds timeout) taaki Vercel ka 502 error na aaye
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
          { type: "execute", stmt: { sql: "SELECT 1 as is_active;" } },
          { type: "close" }
        ]
      }),
      signal: controller.signal // Timeout signal pass kiya
    });

    clearTimeout(timeoutId); // Timeout clear karo agar response agaya

    // 5. ✅ Professional Addition: Raw text parse (agar Turso ne galat format mein HTML bheja toh crash na ho)
    const rawText = await response.text();
    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      data = { raw: rawText, parseError: parseErr.message };
    }

    if (response.ok) {
      return res.status(200).json({
        status: 'SUCCESS',
        message: '🎉 Vercel Env & Turso DB Direct Pipeline Connected!',
        data: data.results?.[0]?.response?.result || data
      });
    } else {
      // Logging ke liye console (Vercel logs me dikhega)
      console.error(`Turso Error ${response.status}:`, rawText);
      return res.status(response.status).json({
        status: 'TURSO_ERROR',
        http_code: response.status,
        details: data
      });
    }

  } catch (err) {
    clearTimeout(timeoutId);
    
    // Timeout specific error message
    if (err.name === 'AbortError') {
      return res.status(504).json({ 
        status: 'TIMEOUT', 
        error: 'Database request 8.5 seconds se zyada lag gaya.' 
      });
    }

    return res.status(500).json({ 
      status: 'SERVER_ERROR', 
      error: err.message 
    });
  }
}
