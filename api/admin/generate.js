import { createClient } from '@libsql/client';

// 1. Force HTTPS protocol to bypass WebSocket migration protocol bug
const TURSO_URL = "https://mcq-rameshxcb-stack.aws-ap-south-1.turso.io";
const TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODc4Mzk0NjIsImlkIjoiMDFhMDA5NTgtMWQwMS03YzQ4LWI2ZDktMmI4OGQwMDgyNTY1Iiwia2lkIjoiQ185cDN0WVAzRW1yb2xaa2hvUGlMWDNaeHVxSWxROUU4dGJLQXp5a1lEdyIsInJpZCI6ImY0M2VhNzc1LTNkMjYtNDZhMi05NmY4LThlNzRiM2NlNDJlZiJ9.zYjrmW6GuqmXB-qdf4UZTeByXvrf9lNznUB7EC-ooYHI22XwA-ty1vR0EqXHr8wseS1dTnOQntr911lnQ4S0Bg";

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    // Explicit HTTP mode configuration
    const db = createClient({
      url: TURSO_URL,
      authToken: TURSO_TOKEN,
    });

    const result = await db.execute('SELECT 1 as test');

    return res.status(200).json({
      status: 'SUCCESS',
      message: '🎉 VERCEL API CONNECTED SUCCESSFULLY!',
      rows: result.rows
    });

  } catch (err) {
    return res.status(200).json({
      status: 'FAILED',
      exact_error: err.message || String(err)
    });
  }
}
