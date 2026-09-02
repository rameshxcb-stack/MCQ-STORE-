// lib/db.js
// ============================================================
// CENTRAL TURSO DATABASE CLIENT
// Direct Turso HTTP v2 Pipeline Client
// ESM-compatible
//
// IMPORTANT:
// - Existing getDb().execute({...}) interface preserved
// - No @libsql/client required for database execution
// - Works with Vercel Node.js 18+
// ============================================================

// ------------------------------------------------------------
// Environment helpers
// ------------------------------------------------------------

function getRawEnv(name) {
  const value = process.env[name];

  return typeof value === 'string'
    ? value.trim()
    : '';
}

// ------------------------------------------------------------
// Credential sanitization
// ------------------------------------------------------------

function sanitizeToken(value) {
  if (!value) return '';

  return String(value)
    .trim()
    .replace(/^Bearer\s+/i, '')
    .replace(/^["']|["']$/g, '')
    .trim();
}

function sanitizeUrl(value) {
  if (!value) return '';

  return String(value)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\/+$/, '');
}

// ------------------------------------------------------------
// Turso configuration
// ------------------------------------------------------------

export function getTursoConfig() {
  const rawUrl = getRawEnv('TURSO_DATABASE_URL');
  const rawToken = getRawEnv('TURSO_AUTH_TOKEN');

  const url = sanitizeUrl(rawUrl);
  const token = sanitizeToken(rawToken);

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

  let httpUrl;

  if (/^libsql:\/\//i.test(url)) {
    httpUrl = url.replace(/^libsql:\/\//i, 'https://');
  } else if (/^https:\/\//i.test(url)) {
    httpUrl = url;
  } else {
    throw new Error(
      'Invalid TURSO_DATABASE_URL. Expected libsql:// or https:// URL.'
    );
  }

  // Prevent accidental duplicate /v2/pipeline
  httpUrl = httpUrl.replace(/\/+$/, '');

  if (httpUrl.endsWith('/v2/pipeline')) {
    httpUrl = httpUrl.slice(0, -'/v2/pipeline'.length);
  }

  return {
    url,
    httpUrl,
    endpoint: `${httpUrl}/v2/pipeline`,
    token
  };
}

// ------------------------------------------------------------
// JS value -> Turso Hrana value
// ------------------------------------------------------------

function toTursoValue(value) {
  if (value === null || value === undefined) {
    return {
      type: 'null'
    };
  }

  if (typeof value === 'boolean') {
    return {
      type: 'integer',
      value: value ? '1' : '0'
    };
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(
        'Turso query argument must be a finite number.'
      );
    }

    if (Number.isInteger(value)) {
      return {
        type: 'integer',
        value: String(value)
      };
    }

    return {
      type: 'float',
      value
    };
  }

  if (typeof value === 'bigint') {
    return {
      type: 'integer',
      value: value.toString()
    };
  }

  if (typeof value === 'string') {
    return {
      type: 'text',
      value
    };
  }

  // Node.js Buffer
  if (
    typeof Buffer !== 'undefined' &&
    Buffer.isBuffer(value)
  ) {
    return {
      type: 'blob',
      base64: value.toString('base64')
    };
  }

  // Uint8Array / ArrayBuffer-compatible binary data
  if (value instanceof Uint8Array) {
    return {
      type: 'blob',
      base64: Buffer.from(value).toString('base64')
    };
  }

  // Fallback:
  // Existing project primarily sends strings/numbers.
  return {
    type: 'text',
    value: String(value)
  };
}

// ------------------------------------------------------------
// Arguments conversion
// ------------------------------------------------------------

function toTursoArgs(args) {
  // Positional arguments:
  // [value1, value2, value3]
  if (Array.isArray(args)) {
    return args.map(toTursoValue);
  }

  // Named arguments:
  // { ':name': value }
  if (args && typeof args === 'object') {
    const converted = {};

    for (const [key, value] of Object.entries(args)) {
      converted[key] = toTursoValue(value);
    }

    return converted;
  }

  return [];
}

// ------------------------------------------------------------
// Turso value -> JS value
// ------------------------------------------------------------

function parseTursoValue(value) {
  if (!value) {
    return null;
  }

  switch (value.type) {
    case 'null':
      return null;

    case 'integer': {
      const number = Number(value.value);

      // Keep very large integers safe.
      if (
        Number.isSafeInteger(number)
      ) {
        return number;
      }

      return value.value;
    }

    case 'float':
      return Number(value.value);

    case 'text':
      return value.value ?? '';

    case 'blob': {
      const base64 =
        value.base64 ??
        value.value ??
        '';

      if (
        typeof Buffer !== 'undefined'
      ) {
        return Buffer.from(base64, 'base64');
      }

      return base64;
    }

    default:
      return value.value ?? null;
  }
}

// ------------------------------------------------------------
// Turso response -> @libsql/client-like ResultSet
// ------------------------------------------------------------

function resultToResultSet(result) {
  if (!result) {
    return {
      rows: [],
      columns: [],
      columnTypes: [],
      rowsAffected: 0,
      lastInsertRowid: undefined
    };
  }

  if (result.type === 'error') {
    const errorMessage =
      result.error?.message ||
      'Turso query execution failed.';

    const error = new Error(errorMessage);

    if (result.error?.code) {
      error.code = result.error.code;
    }

    if (result.error?.code) {
      error.tursoCode = result.error.code;
    }

    throw error;
  }

  const responseResult =
    result.response?.result;

  if (!responseResult) {
    throw new Error(
      'Turso returned an unexpected pipeline response.'
    );
  }

  const columns =
    Array.isArray(responseResult.cols)
      ? responseResult.cols.map(
          column => column?.name ?? ''
        )
      : [];

  const columnTypes =
    Array.isArray(responseResult.cols)
      ? responseResult.cols.map(
          column => column?.decltype ?? null
        )
      : [];

  const rows =
    Array.isArray(responseResult.rows)
      ? responseResult.rows.map(row => {
          const output = {};

          row.forEach((cell, index) => {
            const columnName =
              columns[index] ??
              `column_${index}`;

            output[columnName] =
              parseTursoValue(cell);
          });

          return output;
        })
      : [];

  return {
    rows,

    columns,

    columnTypes,

    rowsAffected:
      responseResult.affected_row_count ?? 0,

    lastInsertRowid:
      responseResult.last_insert_rowid ??
      undefined
  };
}

// ------------------------------------------------------------
// HTTP error helper
// ------------------------------------------------------------

function createHttpError(
  response,
  responseText,
  responseJson
) {
  let message =
    `Turso HTTP ${response.status}`;

  if (
    responseJson?.results &&
    Array.isArray(responseJson.results)
  ) {
    const firstError =
      responseJson.results.find(
        item => item?.type === 'error'
      );

    if (firstError?.error?.message) {
      message +=
        `: ${firstError.error.message}`;
    }
  } else if (responseText) {
    message +=
      `: ${responseText.slice(0, 500)}`;
  }

  const error = new Error(message);

  error.name = 'TursoHttpError';
  error.status = response.status;
  error.statusCode = response.status;

  return error;
}

// ------------------------------------------------------------
// HTTP v2 Pipeline
// ------------------------------------------------------------

async function executePipeline(requests) {
  const {
    endpoint,
    token
  } = getTursoConfig();

  const controller =
    new AbortController();

  const timeoutId =
    setTimeout(() => {
      controller.abort();
    }, 15000);

  let response;

  try {
    response = await fetch(endpoint, {
      method: 'POST',

      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },

      body: JSON.stringify({
        requests
      }),

      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError =
        new Error(
          'Turso request timed out after 15 seconds.'
        );

      timeoutError.name =
        'TursoTimeoutError';

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const responseText =
    await response.text();

  let responseJson = null;

  if (responseText) {
    try {
      responseJson =
        JSON.parse(responseText);
    } catch {
      responseJson = null;
    }
  }

  if (!response.ok) {
    throw createHttpError(
      response,
      responseText,
      responseJson
    );
  }

  if (!responseJson) {
    throw new Error(
      'Turso returned an empty or invalid JSON response.'
    );
  }

  if (!Array.isArray(responseJson.results)) {
    throw new Error(
      'Turso response does not contain a results array.'
    );
  }

  return responseJson;
}

// ------------------------------------------------------------
// Database client
// ------------------------------------------------------------

class TursoHttpDatabase {

  // ----------------------------------------------------------
  // execute()
  // Supports:
  //
  // db.execute({
  //   sql: 'SELECT ...',
  //   args: [...]
  // })
  //
  // and:
  //
  // db.execute('SELECT ...', [...])
  // ----------------------------------------------------------

  async execute(
    statementOrSql,
    args = []
  ) {
    let sql;
    let statementArgs;

    if (
      typeof statementOrSql === 'string'
    ) {
      sql = statementOrSql;
      statementArgs = args;
    } else if (
      statementOrSql &&
      typeof statementOrSql === 'object'
    ) {
      sql = statementOrSql.sql;
      statementArgs =
        statementOrSql.args ?? [];
    } else {
      throw new TypeError(
        'db.execute() requires a SQL string or statement object.'
      );
    }

    if (
      typeof sql !== 'string' ||
      sql.trim() === ''
    ) {
      throw new TypeError(
        'db.execute() requires a non-empty SQL string.'
      );
    }

    const stmt = {
      sql,
      args: toTursoArgs(statementArgs)
    };

    const response =
      await executePipeline([
        {
          type: 'execute',
          stmt
        },

        {
          type: 'close'
        }
      ]);

    const executeResult =
      response.results[0];

    return resultToResultSet(
      executeResult
    );
  }

  // ----------------------------------------------------------
  // batch()
  //
  // Included for compatibility/future use.
  // Current generate.js does not depend on it.
  // ----------------------------------------------------------

  async batch(statements = []) {
    if (!Array.isArray(statements)) {
      throw new TypeError(
        'db.batch() expects an array.'
      );
    }

    const requests =
      statements.map(statement => {
        if (typeof statement === 'string') {
          return {
            type: 'execute',
            stmt: {
              sql: statement,
              args: []
            }
          };
        }

        if (
          !statement ||
          typeof statement !== 'object'
        ) {
          throw new TypeError(
            'Invalid batch statement.'
          );
        }

        return {
          type: 'execute',
          stmt: {
            sql: statement.sql,
            args: toTursoArgs(
              statement.args ?? []
            )
          }
        };
      });

    requests.push({
      type: 'close'
    });

    const response =
      await executePipeline(requests);

    // Last result is close response.
    const executeResults =
      response.results.slice(
        0,
        statements.length
      );

    return executeResults.map(
      resultToResultSet
    );
  }

  // ----------------------------------------------------------
  // close()
  // ----------------------------------------------------------

  close() {
    // HTTP requests are stateless.
    return Promise.resolve();
  }
}

// ------------------------------------------------------------
// Singleton
// ------------------------------------------------------------

let dbInstance = null;

export function createDb() {
  return new TursoHttpDatabase();
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = createDb();
  }

  return dbInstance;
}

// ------------------------------------------------------------
// Simple query helper
// ------------------------------------------------------------

export async function dbQuery(
  sql,
  args = []
) {
  const db = getDb();

  const result =
    await db.execute({
      sql,
      args
    });

  return result.rows || [];
}

// ------------------------------------------------------------
// Safe SHA-256 fingerprint
// NEVER returns the actual token.
// ------------------------------------------------------------

async function sha256Fingerprint(value) {
  if (!value) {
    return null;
  }

  try {
    const data =
      new TextEncoder().encode(value);

    const hashBuffer =
      await crypto.subtle.digest(
        'SHA-256',
        data
      );

    const hashArray =
      Array.from(
        new Uint8Array(hashBuffer)
      );

    return hashArray
      .map(byte =>
        byte
          .toString(16)
          .padStart(2, '0')
      )
      .join('')
      .slice(0, 12);

  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// Database diagnostics
// ------------------------------------------------------------

export async function diagnoseTurso() {
  const rawUrl =
    getRawEnv('TURSO_DATABASE_URL');

  const rawToken =
    getRawEnv('TURSO_AUTH_TOKEN');

  const url =
    sanitizeUrl(rawUrl);

  const token =
    sanitizeToken(rawToken);

  const diagnostics = {
    urlPresent: Boolean(url),

    tokenPresent: Boolean(token),

    urlLength:
      url.length,

    tokenLength:
      token.length,

    protocol:
      url
        ? (url.split(':')[0] || '')
            .toLowerCase()
        : null,

    hostname: null,

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
    }
  };

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

  try {
    const config =
      getTursoConfig();

    const parsed =
      new URL(config.httpUrl);

    diagnostics.hostname =
      parsed.hostname;

    const db =
      getDb();

    const result =
      await db.execute({
        sql:
          'SELECT 1 AS is_active',
        args: []
      });

    diagnostics.select1 = {
      success: true,
      errorName: null,
      errorCode: null,
      httpStatus: 200,
      message:
        'SELECT 1 succeeded.'
    };

    return {
      success: true,
      status: 'SUCCESS',
      error: null,
      message:
        'Turso HTTP connection and SELECT 1 succeeded.',
      diagnostics,
      data: result.rows || []
    };

  } catch (error) {
    const message =
      String(
        error?.message || error
      );

    const httpStatus =
      Number(
        error?.status ??
        error?.statusCode ??
        NaN
      );

    diagnostics.select1 = {
      success: false,
      errorName:
        error?.name || null,

      errorCode:
        error?.code || null,

      httpStatus:
        Number.isInteger(httpStatus)
          ? httpStatus
          : null,

      message
    };

    if (httpStatus === 401) {
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

    if (httpStatus === 403) {
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

    if (httpStatus === 400) {
      return {
        success: false,
        status: 'ERROR',
        error:
          'TURSO_BAD_REQUEST',
        message:
          'Turso HTTP pipeline returned HTTP 400.',
        diagnostics
      };
    }

    return {
      success: false,
      status: 'ERROR',
      error:
        'TURSO_CONNECTION_FAILED',
      message:
        'Turso HTTP connection failed.',
      diagnostics
    };
  }
}

// ------------------------------------------------------------
// Compatibility helper
// ------------------------------------------------------------

export async function testDbConnection() {
  const db =
    getDb();

  const result =
    await db.execute({
      sql:
        'SELECT 1 AS is_active',
      args: []
    });

  return {
    connected: true,
    rows:
      result.rows || []
  };
}

// ------------------------------------------------------------
// Safe database error helper
// ------------------------------------------------------------

export function safeDbError(error) {
  return {
    name:
      error?.name ||
      'Error',

    code:
      error?.code ||
      null,

    message:
      String(
        error?.message ||
        error ||
        'Unknown database error'
      )
        .replace(/\s+/g, ' ')
        .slice(0, 1000)
  };
}

// ------------------------------------------------------------
// Optional default export
// ------------------------------------------------------------

export default getDb;
