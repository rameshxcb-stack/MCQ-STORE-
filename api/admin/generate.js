import { createClient } from '@libsql/client';

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    const url = process.env.TURSO_DATABASE_URL;
    const token = process.env.TURSO_AUTH_TOKEN;

    if (!url || !token) {
      return res.status(200).json({
        status: 'MISSING_ENV',
        EXACT_DIAGNOSTIC_VERDICT: 'Vercel Environment variables (URL ya Auth Token) set nahi hain.',
        has_url: !!url,
        has_token: !!token
      });
    }

    // Turso client directly yahin create karein
    const db = createClient({
      url,
      authToken: token,
    });

    await db.execute('SELECT 1;');

    return res.status(200).json({
      status: 'SUCCESS',
      message: '✅ Turso Database connected & Token successfully verified!',
      details: {
        database_url: url,
        token_length: token.length
      }
    });

  } catch (err) {
    const errorMsg = err?.message || String(err);
    return res.status(200).json({
      status: 'DATABASE_ERROR',
      EXACT_DIAGNOSTIC_VERDICT: errorMsg.includes('invalid JWT') || errorMsg.includes('401')
        ? 'TOKEN_DATABASE_MISMATCH (Turso token is invalid or wrong database)'
        : 'TURSO_QUERY_FAILED',
      raw_error: errorMsg
    });
  }
}
