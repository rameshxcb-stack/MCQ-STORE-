// lib/db.js
// ============================================================
// TURSO HTTP DATABASE CLIENT
// Direct HTTP /v2/pipeline
//
// Purpose:
// - Avoid @libsql/client migration-jobs behaviour
// - Keep existing db.execute({ sql, args }) interface
// - Keep getDb() compatible with current application
// - ESM compatible with "type": "module"
// ============================================================

function getEnv(name) {
  const value = process.env[name];

  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

// ------------------------------------------------------------
// Credential sanitization
// ------------------------------------------------------------

function sanitizeToken(value) {
  if (!value) {
    return '';
  }

  let token = String(value).trim();

  token = token.replace(/^Bearer\s+/i, '');

  if (
    token.length >= 2 &&
    (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    )
  ) {
    token = token.slice(1, -1).trim();
  }

  return token;
}

function sanitizeUrl(value) {
  if (!value) {
    return '';
  }

  let url = String(value).trim();

  if (
    url.length >= 2 &&
    (
      (url.startsWith('"') && url.endsWith('"')) ||
      (url.startsWith("'") && url.endsWith("'"))
    )
  ) {
    url = url.slice(1, -1).trim();
  }

  return url.replace(/\/+$/, '');
}

// ------------------------------------------------------------
// Turso configuration
// ------------------------------------------------------------

export function getTursoConfig() {
  const rawUrl = getEnv('TURSO_DATABASE_URL');
  const rawToken = getEnv('TURSO_AUTH_TOKEN');

  return {
    url: sanitizeUrl(rawUrl),
    token: sanitizeToken(rawToken)
  };
}

// ------------------------------------------------------------
// Convert libSQL URL to HTTP endpoint
// ------------------------------------------------------------

function getHttpEndpoint(url) {
  if (!url) {
    throw new Error('TURSO_DATABASE_URL is missing.');
  }

  let httpUrl = url;

  if (/^libsql:\/\//i.test(httpUrl)) {
    httpUrl = httpUrl.replace(
      /^libsql:\/\//i,
      'https://'
    );
  }

  if (!/^https?:\/\//i.test(httpUrl)) {
    throw new Error(
      'Invalid TURSO_DATABASE_URL. Expected libsql:// or https:// URL.'
    );
  }

  return `${httpUrl.replace(/\/+$/, '')}/v2/pipeline`;
}

// ------------------------------------------------------------
// Convert JavaScript values to Hrana values
// ------------------------------------------------------------

function toHranaValue(value) {
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
      throw new Error(
        'Invalid numeric SQL argument.'
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

  if (value instanceof Uint8Array) {
    let binary = '';

    for (const byte of value) {
      binary += String.fromCharCode(byte);
    }

    return {
      type: 'blob',
      base64: btoa(binary)
    };
  }

  if (value instanceof ArrayBuffer) {
    return toHranaValue(
      new Uint8Array(value)
    );
  }

  // Safely convert unknown objects to JSON text.
  if (typeof value === 'object') {
    return {
      type: 'text',
      value: JSON.stringify(value)
    };
  }

  return {
    type: 'text',
    value: String(value)
  };
}

// ------------------------------------------------------------
// Convert Hrana values back to JavaScript
// ------------------------------------------------------------

function fromHranaValue(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (
    typeof value !== 'object' ||
    !value.type
  ) {
    return value;
  }

  switch (value.type) {
    case 'null':
      return null;

    case 'integer': {
      const raw = value.value;

      const number = Number(raw);

      if (
        Number.isSafeInteger(number)
      ) {
        return number;
      }

      try {
        return BigInt(raw);
      } catch {
        return raw;
      }
    }

    case 'float':
      return Number(value.value);

    case 'text':
      return value.value ?? '';

    case 'blob':
      return value.base64 ?? '';

    default:
      return value.value ?? null;
  }
}

// ------------------------------------------------------------
// Convert Turso response rows into object rows
// ------------------------------------------------------------

function convertRows(executeResult) {
  const columns = Array.isArray(
    executeResult?.cols
  )
    ? executeResult.cols
    : [];

  const rawRows = Array.isArray(
    executeResult?.rows
  )
    ? executeResult.rows
    : [];

  return rawRows.map(row => {
    const values = Array.isArray(row)
      ? row
      : Array.isArray(row?.values)
        ? row.values
        : [];

    const result = {};

    for (
      let index = 0;
      index < columns.length;
      index++
    ) {
      const column = columns[index];

      const name =
        typeof column === 'string'
          ? column
          : column?.name ||
            column?.label ||
            `column_${index}`;

      result[name] =
        fromHranaValue(values[index]);
    }

    return result;
  });
}

// ------------------------------------------------------------
// Extract useful response information
// ------------------------------------------------------------

function normalizeExecuteResult(executeResult) {
  if (!executeResult) {
    return {
      rows: [],
      columns: [],
      rowsAffected: 0,
      lastInsertRowid: undefined
    };
  }

  const columns =
    Array.isArray(executeResult.cols)
      ? executeResult.cols
      : [];

  const rows =
    convertRows(executeResult);

  const rowsAffected =
    Number(
      executeResult.affected_row_count ??
      executeResult.rows_affected ??
      0
    );

  let lastInsertRowid =
    executeResult.last_insert_rowid;

  if (
    lastInsertRowid &&
    typeof lastInsertRowid === 'object'
  ) {
    lastInsertRowid =
      fromHranaValue(lastInsertRowid);
  }

  return {
    rows,
    columns,
    rowsAffected,
    lastInsertRowid
  };
}

// ------------------------------------------------------------
// Read HTTP error body safely
// ------------------------------------------------------------

async function readResponseBody(response) {
  const text =
    await response.text();

  if (!text) {
    return '';
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ------------------------------------------------------------
// Main HTTP execute
// ------------------------------------------------------------

async function executeHttp(
  sql,
  args = []
) {
  const {
    url,
    token
  } = getTursoConfig();

  if (!url) {
    throw new Error(
      'TURSO_DATABASE_URL is missing in Vercel environment.'
    );
  }

  if (!token) {
    throw new Error(
      'TURSO_AUTH_TOKEN is missing in Vercel environment.'
    );
  }

  if (typeof sql !== 'string' || !sql.trim()) {
    throw new Error(
      'SQL statement is empty.'
    );
  }

  if (!Array.isArray(args)) {
    throw new Error(
      'SQL args must be an array.'
    );
  }

  const endpoint =
    getHttpEndpoint(url);

  const hranaArgs =
    args.map(toHranaValue);

  const payload = {
    requests: [
      {
        type: 'execute',
        stmt: {
          sql,
          args: hranaArgs
        }
      }
    ]
  };

  let response;

  try {
    response = await fetch(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );
  } catch (error) {
    const message =
      String(
        error?.message || error
      );

    const networkError =
      new Error(
        `Turso HTTP request failed: ${message}`
      );

    networkError.code =
      'TURSO_HTTP_NETWORK_ERROR';

    throw networkError;
  }

  const body =
    await readResponseBody(response);

  if (!response.ok) {
    let serverMessage = '';

    if (
      body &&
      typeof body === 'object'
    ) {
      serverMessage =
        body.error?.message ||
        body.error ||
        body.message ||
        body.msg ||
        '';
    } else {
      serverMessage =
        String(body || '');
    }

    const error =
      new Error(
        `Turso HTTP ${response.status}: ${
          serverMessage || 'Request rejected.'
        }`
      );

    error.code =
      `HTTP_${response.status}`;

    error.status =
      response.status;

    throw error;
  }

  if (
    !body ||
    typeof body !== 'object'
  ) {
    throw new Error(
      'Turso returned an invalid JSON response.'
    );
  }

  // Pipeline-level error.
  if (
    body.error
  ) {
    const message =
      body.error?.message ||
      String(body.error);

    const error =
      new Error(
        `Turso pipeline error: ${message}`
      );

    error.code =
      body.error?.code ||
      'TURSO_PIPELINE_ERROR';

    throw error;
  }

  const results =
    Array.isArray(body.results)
      ? body.results
      : [];

  if (results.length === 0) {
    throw new Error(
      'Turso returned no pipeline result.'
    );
  }

  const first =
    results[0];

  if (
    first?.type &&
    first.type !== 'ok' &&
    first.type !== 'execute'
  ) {
    const message =
      first.error?.message ||
      first.error ||
      `Unexpected Turso result type: ${first.type}`;

    const error =
      new Error(
        `Turso pipeline request failed: ${message}`
      );

    error.code =
      first.error?.code ||
      'TURSO_REQUEST_ERROR';

    throw error;
  }

  const executeResult =
  first?.response?.result ||
  first?.result ||
  first;

  return normalizeExecuteResult(
    executeResult
  );
}

// ------------------------------------------------------------
// Compatible DB object
// ------------------------------------------------------------

function createHttpDb() {
  return {
    async execute(statement) {
      let sql;
      let args;

      if (
        typeof statement === 'string'
      ) {
        sql = statement;
        args = [];
      } else {
        sql = statement?.sql;
        args = statement?.args || [];
      }

      return await executeHttp(
        sql,
        args
      );
    },

    async batch(statements = []) {
      if (!Array.isArray(statements)) {
        throw new Error(
          'batch() requires an array.'
        );
      }

      const results = [];

      for (
        const statement of statements
      ) {
        results.push(
          await this.execute(statement)
        );
      }

      return results;
    },

    async close() {
      // HTTP has no persistent socket
      // that needs closing.
    }
  };
}

// ------------------------------------------------------------
// Singleton
// ------------------------------------------------------------

let dbInstance = null;

export function createDb() {
  return createHttpDb();
}

export function getDb() {
  if (!dbInstance) {
    dbInstance = createDb();
  }

  return dbInstance;
}

// ------------------------------------------------------------
// Query helper
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
// Safe error
// ------------------------------------------------------------

export function safeDbError(error) {
  if (!error) {
    return {
      name: 'UnknownError',
      code: null,
      message: 'Unknown database error'
    };
  }

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
        error
      )
        .replace(/\s+/g, ' ')
        .slice(0, 1000)
  };
}

// ------------------------------------------------------------
// Diagnostics
// ------------------------------------------------------------

export function getDbDiagnostics() {
  try {
    const {
      url,
      token
    } = getTursoConfig();

    let protocol =
      'unknown';

    let host =
      null;

    try {
      const parsed =
        new URL(
          url.startsWith('libsql://')
            ? url.replace(
                /^libsql:\/\//i,
                'https://'
              )
            : url
        );

      protocol =
        new URL(url).protocol ||
        (
          url.startsWith('libsql://')
            ? 'libsql:'
            : parsed.protocol
        );

      host =
        parsed.hostname;

    } catch {
      protocol =
        url.startsWith('libsql://')
          ? 'libsql:'
          : 'unknown';

      host =
        null;
    }

    return {
      urlConfigured:
        Boolean(url),

      tokenConfigured:
        Boolean(token),

      urlProtocol:
        protocol,

      urlHost:
        host,

      tokenLength:
        token.length
    };

  } catch (error) {
    return {
      urlConfigured:
        Boolean(
          process.env.TURSO_DATABASE_URL
        ),

      tokenConfigured:
        Boolean(
          process.env.TURSO_AUTH_TOKEN
        ),

      configurationError:
        safeDbError(error)
    };
  }
}

// ------------------------------------------------------------
// Turso diagnostic test
// ------------------------------------------------------------

export async function diagnoseTurso() {
  const diagnostics =
    getDbDiagnostics();

  if (
    !diagnostics.urlConfigured
  ) {
    return {
      success: false,
      status: 'ERROR',
      error: 'TURSO_URL_MISSING',
      message:
        'TURSO_DATABASE_URL is missing.',
      diagnostics
    };
  }

  if (
    !diagnostics.tokenConfigured
  ) {
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
    const db =
      getDb();

    const result =
      await db.execute({
        sql:
          'SELECT 1 AS is_active',
        args: []
      });

    const firstRow =
      result.rows?.[0] || {};

    return {
      success: true,
      status: 'SUCCESS',
      error: null,
      message:
        'Turso HTTP connection and SELECT 1 succeeded.',
      diagnostics: {
        ...diagnostics,

        select1: {
          success: true,
          httpStatus: 200,
          message:
            'SELECT 1 succeeded.',
          value:
            firstRow.is_active ?? null
        }
      }
    };

  } catch (error) {
    const dbError =
      safeDbError(error);

    return {
      success: false,
      status: 'ERROR',
      error:
        dbError.code === 'HTTP_401'
          ? 'TURSO_AUTHENTICATION_FAILED'
          : dbError.code === 'HTTP_403'
            ? 'TURSO_ACCESS_FORBIDDEN'
            : 'TURSO_CONNECTION_FAILED',

      message:
        dbError.message,

      diagnostics: {
        ...diagnostics,

        select1: {
          success: false,
          errorName:
            dbError.name,
          errorCode:
            dbError.code,
          httpStatus:
            error?.status ||
            null,
          message:
            dbError.message
        }
      }
    };
  }
}

// ------------------------------------------------------------
// Optional compatibility function
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
