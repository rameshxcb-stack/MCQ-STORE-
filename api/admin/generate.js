import { getDb } from '../../lib/db.js';

export default async function handler(req, res) {
  const currentUrl = process.env.TURSO_DATABASE_URL || '';
  const currentToken = process.env.TURSO_AUTH_TOKEN || '';

  // 1. Extract Database Name from standard Turso URL (e.g. libsql://db-name-org.turso.io)
  let extractedDbName = 'UNKNOWN';
  if (currentUrl) {
    const match = currentUrl.match(/libsql:\/\/([^.]+)/);
    if (match && match[1]) {
      extractedDbName = match[1];
    }
  }

  // 2. Extract Key ID / Issuer info safely from JWT Token payload without external libraries
  let tokenInfo = { issuer: 'UNKNOWN', keyId: 'UNKNOWN', error: null };
  if (currentToken) {
    try {
      const parts = currentToken.split('.');
      if (parts.length === 3) {
        const headerJson = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf-8'));
        const payloadJson = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
        
        tokenInfo = {
          keyId: headerJson.kid || 'No Key ID (kid)',
          issuer: payloadJson.iss || payloadJson.sub || 'Unknown Issuer',
          expiresAt: payloadJson.exp ? new Date(payloadJson.exp * 1000).toISOString() : 'No Expiry'
        };
      }
    } catch (e) {
      tokenInfo.error = 'Token is not a valid JWT structure';
    }
  }

  // Terminal Console Logs
  console.log('--- 🔍 LIVE TURSO INSPECTOR ---');
  console.log('🔗 Loaded URL:', currentUrl);
  console.log('🗄️ Database Name:', extractedDbName);
  console.log('🔑 Token Key ID (kid):', tokenInfo.keyId);
  console.log('--------------------------------');

  try {
    const db = getDb();
    // Try pinging to check token validity against the loaded database URL
    await db.execute('SELECT 1;');

    return res.status(200).json({
      status: 'SUCCESS',
      message: 'Database connection verified! URL aur Token exact match ho rahe hain.',
      database_details: {
        database_url_used: currentUrl,
        database_name_from_url: extractedDbName,
        token_prefix: currentToken ? `${currentToken.substring(0, 15)}...` : 'MISSING',
        token_length: currentToken.length,
        token_internal_info: tokenInfo
      }
    });

  } catch (err) {
    return res.status(500).json({
      status: 'FAILED',
      EXACT_DIAGNOSTIC_VERDICT: err.message.includes('invalid JWT token') || err.message.includes('401')
        ? 'TOKEN_DATABASE_MISMATCH (Token invalid hai ya kisi DUSRE database ka active hai)'
        : 'CONNECTION_ERROR',
      database_details: {
        database_url_used: currentUrl,
        database_name_from_url: extractedDbName,
        token_prefix: currentToken ? `${currentToken.substring(0, 15)}...` : 'MISSING',
        token_length: currentToken.length,
        token_internal_info: tokenInfo,
        raw_error: err.message
      }
    });
  }
}
