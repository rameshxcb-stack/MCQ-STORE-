import { getDb } from '../../lib/db.js';

export default async function handler(req, res) {
  // Always return JSON, prevent HTML 500 crashes
  res.setHeader('Content-Type', 'application/json');

  try {
    const currentUrl = process.env.TURSO_DATABASE_URL || '';
    const currentToken = process.env.TURSO_AUTH_TOKEN || '';

    // Extract Database Name from URL safely
    let extractedDbName = 'NOT_CONFIGURED';
    if (currentUrl) {
      const match = currentUrl.match(/libsql:\/\/([^.]+)/);
      if (match && match[1]) {
        extractedDbName = match[1];
      }
    }

    // Direct Verification Steps
    if (!currentUrl || !currentToken) {
      return res.status(200).json({
        status: 'ENV_VARIABLES_MISSING',
        EXACT_DIAGNOSTIC_VERDICT: 'Vercel Environment variables properly load nahi hue hain.',
        details: {
          has_url: !!currentUrl,
          has_token: !!currentToken
        }
      });
    }

    // Try DB Execution
    const db = getDb();
    await db.execute('SELECT 1;');

    return res.status(200).json({
      status: 'SUCCESS',
      message: '✅ Database Connection & Auth Token Verified Successfully!',
      details: {
        database_url: currentUrl,
        database_name: extractedDbName,
        token_length: currentToken.length
      }
    });

  } catch (err) {
    const errorMsg = err?.message || String(err);
    
    let failureReason = 'UNKNOWN_DATABASE_ERROR';
    if (errorMsg.includes('invalid JWT token') || errorMsg.includes('401') || errorMsg.includes('can\'t be decoded')) {
      failureReason = 'TOKEN_MISMATCH (Vercel mein TURSO_AUTH_TOKEN galat ya dusre DB ka pada hai)';
    } else if (errorMsg.includes('ENOTFOUND') || errorMsg.includes('fetch failed')) {
      failureReason = 'INVALID_URL (TURSO_DATABASE_URL reach nahi ho raha hai)';
    }

    return res.status(200).json({
      status: 'DATABASE_ERROR',
      EXACT_DIAGNOSTIC_VERDICT: failureReason,
      error_message: errorMsg,
      details: {
        database_url_used: process.env.TURSO_DATABASE_URL || 'MISSING',
        token_length: process.env.TURSO_AUTH_TOKEN ? process.env.TURSO_AUTH_TOKEN.length : 0
      }
    });
  }
}
