export default async function handler(req, res) {
  // Always return standard JSON
  res.setHeader('Content-Type', 'application/json');

  try {
    // 1. Fetch environment variables or set credentials directly
    const rawUrl = process.env.TURSO_DATABASE_URL || "libsql://mcq-rameshxcb-stack.aws-ap-south-1.turso.io";
    const rawToken = process.env.TURSO_AUTH_TOKEN || "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODc4Mzk0NjIsImlkIjoiMDFhMDA5NTgtMWQwMS03YzQ4LWI2ZDktMmI4OGQwMDgyNTY1Iiwia2lkIjoiQ185cDN0WVAzRW1yb2xaa2hvUGlMWDNaeHVxSWxROUU4dGJLQXp5a1lEdyIsInJpZCI6ImY0M2VhNzc1LTNkMjYtNDZhMi05NmY4LThlNzRiM2NlNDJlZiJ9.zYjrmW6GuqmXB-qdf4UZTeByXvrf9lNznUB7EC-ooYHI22XwA-ty1vR0EqXHr8wseS1dTnOQntr911lnQ4S0Bg";

    // 2. Strict Token & Endpoint Sanitization
    const token = rawToken.replace(/["'\s\r\n]/g, '').trim();
    const cleanUrl = rawUrl.replace('libsql://', 'https://').replace(/\/$/, '');
    const endpoint = `${cleanUrl}/v2/pipeline`;

    if (!token) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'TURSO_AUTH_TOKEN empty hai ya parse nahi ho pa raha.'
      });
    }

    // 3. Direct HTTP Pipeline API Request
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

    // 4. Handle Unauthorized 401 & Database Errors
    if (!response.ok) {
      return res.status(response.status).json({
        status: 'TURSO_AUTH_FAILED',
        http_code: response.status,
        details: data,
        note: response.status === 401 
          ? "Token decode nahi ho paraha. Kripya Turso CLI me 'turso db tokens create mcq-rameshxcb-stack' run karke naya token generate karein."
          : "Turso side error."
      });
    }

    // 5. Query Result Response
    const result = data.results?.[0]?.response?.result;

    return res.status(200).json({
      status: 'SUCCESS',
      message: '🎉 Vercel se Turso Database connect ho gaya!',
      data: result
    });

  } catch (err) {
    console.error("Vercel Function Error:", err);
    return res.status(500).json({
      status: 'SERVER_ERROR',
      message: err.message || String(err)
    });
  }
}
