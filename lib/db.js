// lib/db.js
// ============================================================
// CENTRAL TURSO DATABASE CLIENT
// One database client for the application
// ============================================================

import { createClient } from '@libsql/client';

// ------------------------------------------------------------
// Environment helpers
// ------------------------------------------------------------

function getEnv(name) {
  const raw = process.env[name];

  if (typeof raw !== 'string') {
    return '';
  }

  return raw.trim();
}

// ------------------------------------------------------------
// Credential sanitization
// ------------------------------------------------------------

function sanitizeToken(value) {
  if (!value) return '';

  return value
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function sanitizeUrl(value) {
  if (!value) return '';

  return value
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\/+$/, '');
}

// ------------------------------------------------------------
// Get Turso configuration
// ------------------------------------------------------------

export function getTursoConfig() {
  const rawUrl = getEnv('TURSO_DATABASE_URL');
  const rawToken = getEnv('TURSO_AUTH_TOKEN');

  const url = sanitizeUrl(rawUrl);
  const token = sanitizeToken(rawToken);

  return {
    url,
    token
  };
}

// ------------------------------------------------------------
// Create Turso client
// ------------------------------------------------------------

export function createDb() {
  const { url, token } = getTursoConfig();

  if (!url) {
    throw new Error(
      'TURSO_DATABASE_URL is missing from the server environment.'
    );
  }

  if (!token) {
    throw new Error(
      'TURSO_AUTH_TOKEN is missing from the server environment.'
    );
  }

  if (!/^libsql:\/\//i.test(url)) {
    throw new Error(
      `Invalid TURSO_DATABASE_URL protocol. Expected libsql:// but received: ${url.split(':')[0] || 'unknown'}`
    );
  }

  return createClient({
    url,
    authToken: token
  });
}

// ------------------------------------------------------------
// Singleton database client
// ------------------------------------------------------------

let dbInstance = null;

export function getDb() {
  if (!dbInstance) {
    dbInstance = createDb();
  }

  return dbInstance;
}

// ------------------------------------------------------------
// Database query helper
// ------------------------------------------------------------

export async function dbQuery(sql, args = []) {
  const db = getDb();

  const result = await db.execute({
    sql,
    args
  });

  return result.rows || [];
}

// ------------------------------------------------------------
// Safe credential fingerprint
// NEVER returns actual token
// ------------------------------------------------------------

async function sha256Fingerprint(value) {
  if (!value) return null;

  try {
    const data = new TextEncoder().encode(value);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);

    const hashArray = Array.from(new Uint8Array(hashBuffer));

    return hashArray
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Turso diagnostics
// ------------------------------------------------------------

export async function diagnoseTurso() {
  const { url, token } = getTursoConfig();

  let hostname = null;
  let urlParseError = null;

  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
  } catch (error) {
    urlParseError = String(error?.message || error);
  }

  const diagnostics = {
    urlPresent: Boolean(url),
    tokenPresent: Boolean(token),

    urlLength: url.length,
    tokenLength: token.length,

    protocol: url
      ? (url.split(':')[0] || '').toLowerCase()
      : null,

    hostname,
    urlParseError,

    tokenHadBearerPrefix: /^Bearer\s+/i.test(getEnv('TURSO_AUTH_TOKEN')),

    tokenHadOuterWhitespace:
      getEnv('TURSO_AUTH_TOKEN') !== process.env.TURSO_AUTH_TOKEN,

    tokenHadQuotes:
      /^["']|["']$/.test(getEnv('TURSO_AUTH_TOKEN')),

    tokenContainsWhitespace: /\s/.test(token),

    urlFingerprint: await sha256Fingerprint(url),
    tokenFingerprint: await sha256Fingerprint(token),

    select1: {
      success: false,
      errorName: null,
      errorCode: null,
      httpStatus: null,
      message: null
    },

    databaseIdentity: null
  };

  // ----------------------------------------------------------
  // Basic validation
  // ----------------------------------------------------------

  if (!url) {
    return {
      success: false,
      status: 'ERROR',
      error: 'TURSO_URL_MISSING',
      message: 'TURSO_DATABASE_URL is missing.',
      diagnostics
    };
  }

  if (!token) {
    return {
      success: false,
      status: 'ERROR',
      error: 'TURSO_TOKEN_MISSING',
      message: 'TURSO_AUTH_TOKEN is missing.',
      diagnostics
    };
  }

  if (!/^libsql:\/\//i.test(url)) {
    return {
      success: false,
      status: 'ERROR',
      error: 'INVALID_TURSO_URL',
      message: 'TURSO_DATABASE_URL must use libsql:// protocol.',
      diagnostics
    };
  }

  // ----------------------------------------------------------
  // SELECT 1
  // ----------------------------------------------------------

  try {
    const db = createDb();

    const result = await db.execute({
      sql: 'SELECT 1 AS is_active',
      args: []
    });

    diagnostics.select1 = {
      success: true,
      errorName: null,
      errorCode: null,
      httpStatus: 200,
      message: 'SELECT 1 succeeded.'
    };

    // --------------------------------------------------------
    // Try to identify database safely
    // --------------------------------------------------------

    try {
      const identityResult = await db.execute({
        sql: `
          SELECT
            1 AS connection_ok
        `,
        args: []
      });

      diagnostics.databaseIdentity = {
        connectionOk:
          identityResult.rows?.[0]?.connection_ok === 1
      };
    } catch {
      diagnostics.databaseIdentity = null;
    }

    return {
      success: true,
      status: 'SUCCESS',
      error: null,
      message: 'Turso authentication and SELECT 1 succeeded.',
      diagnostics
    };

  } catch (error) {
    const message = String(error?.message || error);

    let httpStatus = null;

    const statusMatch =
      message.match(/\bHTTP(?: status)?\s+(\d{3})\b/i) ||
      message.match(/\bstatus\s+(\d{3})\b/i);

    if (statusMatch) {
      httpStatus = Number(statusMatch[1]);
    }

    diagnostics.select1 = {
      success: false,
      errorName: error?.name || null,
      errorCode: error?.code || null,
      httpStatus,
      message
    };

    if (httpStatus === 401 || /401|unauthorized/i.test(message)) {
      return {
        success: false,
        status: 'ERROR',
        error: 'TURSO_AUTHENTICATION_FAILED',
        message: 'Turso rejected the supplied credentials.',
        diagnostics
      };
    }

    return {
      success: false,
      status: 'ERROR',
      error: 'TURSO_CONNECTION_FAILED',
      message: 'Turso connection failed.',
      diagnostics
    };
  }
}

// ------------------------------------------------------------
// Optional direct connection test
// ------------------------------------------------------------

export async function testDbConnection() {
  const db = getDb();

  const result = await db.execute({
    sql: 'SELECT 1 AS is_active',
    args: []
  });

  return {
    connected: true,
    rows: result.rows || []
  };
}
