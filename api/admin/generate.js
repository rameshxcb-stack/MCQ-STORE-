export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  // Hardcoded Valid Values (As Tested in HTML) + Env Fallback
  const HARDCODED_URL = "https://mcq-rameshxcb-stack.aws-ap-south-1.turso.io";
  const HARDCODED_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODc4Mzk0NjIsImlkIjoiMDFhMDA5NTgtMWQwMS03YzQ4LWI2ZDktMmI4OGQwMDgyNTY1Iiwia2lkIjoiQ185cDN0WVAzRW1yb2xaa2hvUGlMWDNaeHVxSWxROUU4dGJLQXp5a1lEdyIsInJpZCI6ImY0M2VhNzc1LTNkMjYtNDZhMi05NmY4LThlNzRiM2NlNDJlZiJ9.zYjrmW6GuqmXB-qdf4UZTeByXvrf9lNznUB7EC-ooYHI22XwA-ty1vR0EqXHr8wseS1dTnOQntr911lnQ4S0Bg";

  // Pure Token Sanitizer (Remove invisible spaces / newlines)
  const getCleanToken = (str) => {
    if (!str) return '';
    return str.replace(/[^a-zA-Z0-9\._\-]/g, '').trim();
  };

  const envToken = getCleanToken(process.env.TURSO_AUTH_TOKEN);
  const activeToken = envToken.length > 50 ? envToken : HARDCODED_TOKEN;

  const envUrl = (process.env.TURSO_DATABASE_URL || '').replace('libsql://', 'https://').replace(/\/$/, '');
  const activeUrl = envUrl ? envUrl : HARDCODED_URL;
  const endpoint = `${activeUrl}/v2/pipeline`;

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${activeToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
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
    }

    // Direct Safe Return if 401 occurs from env variable mismatch
    return res.status(response.status).json({
      status: 'TURSO_ERROR',
      http_code: response.status,
      turso_response: data
    });

  } catch (err) {
    return res.status(500).json({
      status: 'SERVER_ERROR',
      error_message: err.message || String(err)
    });
  }
}
