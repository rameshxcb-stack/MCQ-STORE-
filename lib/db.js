// lib/db.js
// CENTRAL TURSO DATABASE CLIENT
// Vercel + Turso production connection
// Node.js 18+

import { createClient } from '@libsql/client';

/* =========================================================
   ENVIRONMENT HELPERS
========================================================= */

function getEnv(name) {
  const value = process.env[name];

  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

/* =========================================================
   TOKEN SANITIZATION
========================================================= */

function sanitizeToken(value) {
  if (!value) {
    return '';
  }

  let token = String(value).trim();

  // Remove accidental Bearer prefix
  token = token.replace(/^Bearer\s+/i, '');

  // Remove accidental surrounding quotes
  token = token.replace(/^["']|["']$/g, '');

  return token.trim();
}

/* =========================================================
   URL SANITIZATION
========================================================= */

function sanitizeUrl(value) {
  if (!value) {
    return '';
  }

  let url = String(value).trim();

  // Remove accidental surrounding quotes
  url = url.replace(/^["']|["']$/g, '');

  // Remove trailing slash
  url = url.replace(/\/+$/, '');

  return url;
}

/* =========================================================
   TURSO CONFIG
========================================================= */

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

/* =========================================================
   CREATE TURSO CLIENT
========================================================= */

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
      `Invalid TURSO_DATABASE_URL protocol. Expected libsql:// but received: ${
        url.split(':')[0] || 'unknown'
      }`
    );
  }

  return createClient({
    url,
    authToken: token
  });
}

/* =========================================================
   SINGLETON DATABASE INSTANCE
========================================================= */

let dbInstance = null;

export function getDb() {
  if (!dbInstance) {
    dbInstance = createDb();
  }

  return dbInstance;
}

/* =========================================================
   GENERIC DB QUERY
========================================================= */

export async function dbQuery(sql, args = []) {
  const db = getDb();

  const result = await db.execute({
    sql,
    args
  });

  return result.rows || [];
}

/* =========================================================
   SHA-256 FINGERPRINT
   Used ONLY for diagnostics.
   NEVER logs the actual token.
========================================================= */

async function sha256Fingerprint(value) {
  if (!value) {
    return null;
  }

  try {
    const data = new TextEncoder().encode(value);

    const hashBuffer = await crypto.subtle.digest(
      'SHA-256',
      data
    );

    const hashArray = Array.from(
      new Uint8Array(hashBuffer)
    );

    return hashArray
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 12);
  } catch {
    return null;
  }
}

/* =========================================================
   ERROR STATUS EXTRACTION
========================================================= */

function extractHttpStatus(error) {
  const message = String(
    error?.message || error || ''
  );

  const candidates = [
    error?.status,
    error?.statusCode,
    error?.cause?.status,
    error?.cause?.statusCode
  ];

  for (const candidate of candidates) {
    const number = Number(candidate);

    if (
      Number.isInteger(number) &&
      number >= 100 &&
      number <= 599
    ) {
      return number;
    }
  }

  const patterns = [
    /\bHTTP(?:\s+status)?\s*(?:code\s*)?(\d{3})\b/i,
    /\bstatus\s+code\s*[:=]?\s*(\d{3})\b/i,
    /\bstatus\s*[:=]?\s*(\d{3})\b/i,
    /:\s*(\d{3})\s*$/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);

    if (match) {
      const number = Number(match[1]);

      if (
        Number.isInteger(number) &&
        number >= 100 &&
        number <= 599
      ) {
        return number;
      }
    }
  }

  return null;
}

/* =========================================================
   DIAGNOSTIC
========================================================= */

export async function diagnoseTurso() {
  const rawUrl = getEnv('TURSO_DATABASE_URL');
  const rawToken = getEnv('TURSO_AUTH_TOKEN');

  const url = sanitizeUrl(rawUrl);
  const token = sanitizeToken(rawToken);

  let hostname = null;
  let urlParseError = null;

  try {
    const parsed = new URL(url);
    hostname = parsed.hostname;
  } catch (error) {
    urlParseError = String(
      error?.message || error
    );
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

    tokenHadBearerPrefix:
      /^Bearer\s+/i.test(rawToken),

    tokenHadOuterWhitespace:
      rawToken !== rawToken.trim(),

    tokenHadQuotes:
      /^["']|["']$/.test(rawToken),

    tokenContainsWhitespace:
      /\s/.test(token),

    urlFingerprint:
      await sha256Fingerprint(url),

    tokenFingerprint:
      await sha256Fingerprint(token),

    select1: {
      success: false,
      errorName: null,
      errorCode: null,
      httpStatus: null,
      message: null
    },

    databaseIdentity: null
  };

  /* -------------------------------------------------------
     BASIC VALIDATION
  ------------------------------------------------------- */

  if (!url) {
    return {
      success: false,
      status: 'ERROR',
      error: 'TURSO_URL_MISSING',
      message:
        'TURSO_DATABASE_URL is missing.',
      diagnostics
    };
  }

  if (!token) {
    return {
      success: false,
      status: 'ERROR',
      error: 'TURSO_TOKEN_MISSING',
      message:
        'TURSO_AUTH_TOKEN is missing.',
      diagnostics
    };
  }

  if (!/^libsql:\/\//i.test(url)) {
    return {
      success: false,
      status: 'ERROR',
      error: 'INVALID_TURSO_URL',
      message:
        'TURSO_DATABASE_URL must use libsql:// protocol.',
      diagnostics
    };
  }

  /* -------------------------------------------------------
     DATABASE CONNECTION
  ------------------------------------------------------- */

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

    /* -----------------------------------------------------
       SIMPLE DATABASE IDENTITY CHECK
       We intentionally do NOT expose secrets.
    ----------------------------------------------------- */

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
      message:
        'Turso authentication and SELECT 1 succeeded.',
      diagnostics
    };
  } catch (error) {
    const message = String(
      error?.message || error
    );

    const httpStatus =
      extractHttpStatus(error);

    diagnostics.select1 = {
      success: false,
      errorName:
        error?.name || null,
      errorCode:
        error?.code || null,
      httpStatus,
      message
    };

    /* -----------------------------------------------------
       AUTHENTICATION ERRORS
    ----------------------------------------------------- */

    if (
      httpStatus === 401 ||
      /unauthorized/i.test(message) ||
      /\b401\b/.test(message)
    ) {
      return {
        success: false,
        status: 'ERROR',
        error:
          'TURSO_AUTHENTICATION_FAILED',
        message:
          'Turso rejected the supplied credentials.',
        diagnostics
      };
    }

    /* -----------------------------------------------------
       FORBIDDEN
    ----------------------------------------------------- */

    if (
      httpStatus === 403 ||
      /\b403\b/.test(message) ||
      /forbidden/i.test(message)
    ) {
      return {
        success: false,
        status: 'ERROR',
        error:
          'TURSO_ACCESS_FORBIDDEN',
        message:
          'Turso rejected the request because access was forbidden.',
        diagnostics
      };
    }

    /* -----------------------------------------------------
       BAD REQUEST
    ----------------------------------------------------- */

    if (
      httpStatus === 400 ||
      /\b400\b/.test(message) ||
      /bad request/i.test(message)
    ) {
      return {
        success: false,
        status: 'ERROR',
        error:
          'TURSO_BAD_REQUEST',
        message:
          'Turso/client returned HTTP 400. This is not automatically classified as an authentication failure.',
        diagnostics
      };
    }

    /* -----------------------------------------------------
       OTHER CONNECTION ERRORS
    ----------------------------------------------------- */

    return {
      success: false,
      status: 'ERROR',
      error:
        'TURSO_CONNECTION_FAILED',
      message:
        'Turso connection failed.',
      diagnostics
    };
  }
}

/* =========================================================
   SIMPLE CONNECTION TEST
========================================================= */

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
