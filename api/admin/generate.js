export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  try {
    // Dynamic import to prevent deployment crash if module path is wrong
    let getDb;
    try {
      const dbModule = await import('../../lib/db.js');
      getDb = dbModule.getDb || dbModule.default;
    } catch (importErr) {
      return res.status(200).json({
        status: 'PATH_IMPORT_ERROR',
        EXACT_DIAGNOSTIC_VERDICT: 'lib/db.js file ka path incorrect hai ya Vercel bundle me include nahi ho raha.',
        error_details: importErr.message
      });
    }

    const currentUrl = process.env.TURSO_DATABASE_URL || '';
    const currentToken = process.env.TURSO_AUTH_TOKEN || '';

    if (!currentUrl || !currentToken) {
      return res.status(200).json({
        status: 'MISSING_ENV',
        EXACT_DIAGNOSTIC_VERDICT: 'Vercel Environment variables (URL ya Auth Token) set nahi hain.',
        has_url: !!currentUrl,
        has_token: !!currentToken
      });
    }

    const db = getDb();
    await db.execute('SELECT 1;');

    return res.status(200).json({
      status: 'SUCCESS',
      message: '✅ Turso Database connected & Token successfully verified!',
      details: {
        database_url: currentUrl,
        token_length: currentToken.length
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
