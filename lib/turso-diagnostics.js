// lib/turso-diagnostics.js

import { createClient } from '@libsql/client';
import { createHash } from 'crypto';

function fingerprint(value) {
  if (!value) return null;

  return createHash('sha256')
    .update(value)
    .digest('hex')
    .slice(0, 12);
}

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');

    if (parts.length !== 3) {
      return {
        isJwt: false,
        payload: null,
        error: 'Token does not look like a JWT'
      };
    }

    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    );

    return {
      isJwt: true,
      payload
    };
  } catch (error) {
    return {
      isJwt: false,
      payload: null,
      error: 'JWT payload could not be decoded'
    };
  }
}

function sanitizeToken(token) {
  return String(token || '')
    .replace(/^Bearer\s+/i, '')
    .replace(/["'\s\r\n]/g, '')
    .trim();
}

function sanitizeUrl(url) {
  return String(url || '')
    .trim()
    .replace(/\/+$/, '');
}

function parseUrl(url) {
  try {
    const parsed = new URL(url);

    return {
      valid: true,
      protocol: parsed.protocol.replace(':', ''),
      hostname: parsed.hostname,
      pathname: parsed.pathname
    };
  } catch {
    return {
      valid: false,
      protocol: null,
      hostname: null,
      pathname: null
    };
  }
}

export async function diagnoseTursoCredentials({ url, token }) {
  const cleanUrl = sanitizeUrl(url);
  const cleanToken = sanitizeToken(token);

  const urlInfo = parseUrl(cleanUrl);
  const jwtInfo = decodeJwtPayload(cleanToken);

  const result = {
    urlPresent: Boolean(cleanUrl),
    tokenPresent: Boolean(cleanToken),

    urlLength: cleanUrl.length,
    tokenLength: cleanToken.length,

    protocol: urlInfo.protocol,
    hostname: urlInfo.hostname,
    pathname: urlInfo.pathname,

    urlValid: urlInfo.valid,
    urlFingerprint: fingerprint(cleanUrl),
    tokenFingerprint: fingerprint(cleanToken),

    tokenHadBearerPrefix: /^Bearer\s+/i.test(String(token || '')),
    tokenHadOuterWhitespace:
      String(token || '') !== String(token || '').trim(),

    tokenHadQuotes:
      /^["']/.test(String(token || '').trim()) ||
      /["']$/.test(String(token || '').trim()),

    tokenContainsWhitespace: /\s/.test(String(token || '')),

    jwt: {
      isJwt: jwtInfo.isJwt,
      expired: null,
      expiresAt: null,
      issuedAt: null,
      subject: null,
      audience: null,
      issuer: null,
      claims: null
    },

    connection: {
      success: false,
      select1: false,
      errorName: null,
      errorCode: null,
      httpStatus: null,
      message: null
    },

    databaseIdentity: null,
    compatibility: {
      sameDatabaseConfirmed: false,
      status: 'NOT_CONFIRMED',
      reason: null
    }
  };

  // Basic validation
  if (!cleanUrl) {
    result.compatibility.reason = 'URL is missing.';
    return result;
  }

  if (!cleanToken) {
    result.compatibility.reason = 'Token is missing.';
    return result;
  }

  if (!urlInfo.valid) {
    result.compatibility.reason = 'URL format is invalid.';
    return result;
  }

  if (urlInfo.protocol !== 'libsql') {
    result.compatibility.reason =
      `Expected libsql:// URL, received ${urlInfo.protocol}://`;
    return result;
  }

  // JWT inspection
  if (jwtInfo.isJwt && jwtInfo.payload) {
    const payload = jwtInfo.payload;

    const now = Math.floor(Date.now() / 1000);

    result.jwt.expiresAt =
      typeof payload.exp === 'number' ? payload.exp : null;

    result.jwt.issuedAt =
      typeof payload.iat === 'number' ? payload.iat : null;

    result.jwt.expired =
      typeof payload.exp === 'number'
        ? payload.exp <= now
        : null;

    result.jwt.subject =
      typeof payload.sub === 'string' ? payload.sub : null;

    result.jwt.audience =
      payload.aud ?? null;

    result.jwt.issuer =
      typeof payload.iss === 'string' ? payload.iss : null;

    // Do NOT return the complete token.
    // Return only selected non-secret claim keys.
    const safeClaims = {};

    for (const key of [
      'sub',
      'aud',
      'iss',
      'exp',
      'iat',
      'nbf',
      'scope',
      'permissions',
      'database',
      'databases'
    ]) {
      if (payload[key] !== undefined) {
        safeClaims[key] = payload[key];
      }
    }

    result.jwt.claims = safeClaims;
  }

  // Actual Turso connection test
  try {
    const db = createClient({
      url: cleanUrl,
      authToken: cleanToken
    });

    const queryResult = await db.execute(
      'SELECT 1 AS turso_connection_test'
    );

    result.connection.success = true;
    result.connection.select1 = true;

    result.databaseIdentity = {
      hostname: urlInfo.hostname,
      fingerprint: fingerprint(cleanUrl),
      select1:
        queryResult.rows?.[0]?.turso_connection_test ?? null
    };

    result.compatibility.sameDatabaseConfirmed = true;
    result.compatibility.status = 'CONFIRMED';
    result.compatibility.reason =
      'The supplied token was accepted by the supplied libsql URL and SELECT 1 succeeded.';

    return result;

  } catch (error) {
    const message = String(error?.message || error);

    result.connection.success = false;
    result.connection.select1 = false;
    result.connection.errorName = error?.name || null;
    result.connection.errorCode = error?.code || null;
    result.connection.message = message.slice(0, 500);

    // @libsql/client may not expose HTTP status separately.
    const statusMatch = message.match(/\b(401|403|404|429|500|502|503)\b/);

    if (statusMatch) {
      result.connection.httpStatus = Number(statusMatch[1]);
    }

    if (
      result.connection.httpStatus === 401 ||
      message.includes('401')
    ) {
      result.compatibility.status = 'REJECTED';
      result.compatibility.reason =
        'Turso rejected the token for this URL. The URL/token pair could not be authenticated.';
    } else if (
      result.connection.httpStatus === 403 ||
      message.includes('403')
    ) {
      result.compatibility.status = 'FORBIDDEN';
      result.compatibility.reason =
        'Turso accepted the request endpoint but denied access for this credential.';
    } else {
      result.compatibility.status = 'FAILED';
      result.compatibility.reason =
        'Connection failed before database identity could be confirmed.';
    }

    return result;
  }
}
