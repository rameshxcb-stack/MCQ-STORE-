import { createClient } from '@libsql/client';

// 🔥 Hardcoded credentials (directly from your working HTML test)
const TURSO_URL = "libsql://mcq-rameshxcb-stack.aws-ap-south-1.turso.io";
const TURSO_TOKEN = "eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODc4Mzk0NjIsImlkIjoiMDFhMDA5NTgtMWQwMS03YzQ4LWI2ZDktMmI4OGQwMDgyNTY1Iiwia2lkIjoiQ185cDN0WVAzRW1yb2xaa2hvUGlMWDNaeHVxSWxROUU4dGJLQXp5a1lEdyIsInJpZCI6ImY0M2VhNzc1LTNkMjYtNDZhMi05NmY4LThlNzRiM2NlNDJlZiJ9.zYjrmW6GuqmXB-qdf4UZTeByXvrf9lNznUB7EC-ooYHI22XwA-ty1vR0EqXHr8wseS1dTnOQntr911lnQ4S0Bg";

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    // Directly use hardcoded credentials
    const db = createClient({
      url: TURSO_URL,
      authToken: TURSO_TOKEN,
    });

    // Simple test query
    await db.execute('SELECT 1;');

    return res.status(200).json({
      status: 'SUCCESS',
      message: '✅ Turso Database connected & Token successfully verified!',
      details: {
        database_url: TURSO_URL,
        token_length: TURSO_TOKEN.length,
      },
    });
  } catch (err) {
    const errorMsg = err?.message || String(err);
    return res.status(200).json({
      status: 'DATABASE_ERROR',
      EXACT_DIAGNOSTIC_VERDICT: errorMsg.includes('invalid JWT') || errorMsg.includes('401')
        ? 'TOKEN_DATABASE_MISMATCH (Turso token is invalid or wrong database)'
        : 'TURSO_QUERY_FAILED',
      raw_error: errorMsg,
    });
  }
}
