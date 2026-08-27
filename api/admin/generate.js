export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  const TURSO_URL = "https://mcq-rameshxcb-stack.aws-ap-south-1.turso.io/v2/pipeline";
  const TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODc4Mzk0NjIsImlkIjoiMDFhMDA5NTgtMWQwMS03YzQ4LWI2ZDktMmI4OGQwMDgyNTY1Iiwia2lkIjoiQ185cDN0WVAzRW1yb2xaa2hvUGlMWDNaeHVxSWxROUU4dGJLQXp5a1lEdyIsInJpZCI6ImY0M2VhNzc1LTNkMjYtNDZhMi05NmY4LThlNzRiM2NlNDJlZiJ9.zYjrmW6GuqmXB-qdf4UZTeByXvrf9lNznUB7EC-ooYHI22XwA-ty1vR0EqXHr8wseS1dTnOQntr911lnQ4S0Bg";

  try {
    const response = await fetch(TURSO_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TURSO_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        requests: [
          { type: "execute", stmt: { sql: "SELECT 1 as connection_test;" } },
          { type: "close" }
        ]
      })
    });

    const data = await response.json();

    if (response.ok) {
      return res.status(200).json({
        status: 'SUCCESS',
        message: '🎉 VERCEL & TURSO CONNECTED PERFECTLY!',
        data: data.results[0]?.response?.result || data
      });
    } else {
      return res.status(response.status).json({
        status: 'FAILED',
        http_code: response.status,
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
