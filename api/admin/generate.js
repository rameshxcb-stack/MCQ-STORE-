// api/admin/generate.js
// ============================================================
// TURSO + MCQ TASK PROCESSOR
// Production-safe diagnostic version
// ============================================================

import { generateAndStoreMCQs, retrieveEvidence } from '../../lib/mcq-generator.js';
import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';

// ============================================================
// CONFIG
// ============================================================

const ADMIN_KEY = process.env.ADMIN_API_KEY;

const MAX_RETRY_ATTEMPTS = 3;
const TASK_LEASE_TIMEOUT_SECONDS = 120;
const RETRY_DELAY_SECONDS = 30;

// ============================================================
// SAFE ERROR HELPERS
// ============================================================

function safeErrorMessage(error) {
  if (!error) return 'Unknown error';

  if (typeof error === 'string') {
    return error
      .replace(/\s+/g, ' ')
      .slice(0, 1000);
  }

  return String(error.message || error)
    .replace(/\s+/g, ' ')
    .slice(0, 1000);
}

function getErrorDiagnostics(error) {
  if (!error) {
    return {
      errorName: 'UnknownError',
      errorCode: null,
      cause: null
    };
  }

  return {
    errorName: error?.name || 'UnknownError',
    errorCode: error?.code || null,
    cause: safeErrorMessage(error)
  };
}

// ============================================================
// TURSO ENVIRONMENT DIAGNOSTICS
// ============================================================

function getTursoEnvironmentInfo() {
  const rawUrl = process.env.TURSO_DATABASE_URL || '';
  const rawToken = process.env.TURSO_AUTH_TOKEN || '';

  const trimmedUrl = rawUrl.trim();
  const trimmedToken = rawToken.trim();

  let parsed = null;

  try {
    let urlForParsing = trimmedUrl;

    // Remove accidental surrounding quotes
    urlForParsing = urlForParsing
      .replace(/^['"]/, '')
      .replace(/['"]$/, '')
      .trim();

    // libsql:// cannot be parsed directly by URL in some environments.
    // Convert only for diagnostic parsing.
    const httpUrl = urlForParsing
      .replace(/^libsql:\/\//i, 'https://')
      .replace(/^https:\/\//i, 'https://');

    parsed = new URL(httpUrl);
  } catch {
    parsed = null;
  }

  return {
    urlConfigured: Boolean(trimmedUrl),
    tokenConfigured: Boolean(trimmedToken),

    urlLength: trimmedUrl.length,
    tokenLength: trimmedToken.length,

    protocol: trimmedUrl
      ? (
          trimmedUrl.match(/^([a-z]+):\/\//i)?.[1] || 'unknown'
        ).toLowerCase()
      : null,

    hostname: parsed?.hostname || null,

    // NEVER return token itself.
    tokenExposed: false
  };
}

// ============================================================
// SANITIZE TURSO CREDENTIALS
// ============================================================

function cleanEnvironmentValue(value) {
  if (!value) return '';

  return String(value)
    .trim()
    .replace(/^['"]/, '')
    .replace(/['"]$/, '')
    .trim();
}

// ============================================================
// CREATE TURSO CLIENT
// ============================================================

function createTursoClient() {
  const rawUrl = cleanEnvironmentValue(
    process.env.TURSO_DATABASE_URL || ''
  );

  const rawToken = cleanEnvironmentValue(
    process.env.TURSO_AUTH_TOKEN || ''
  );

  if (!rawUrl) {
    throw new Error(
      'TURSO_DATABASE_URL is missing or empty.'
    );
  }

  if (!rawToken) {
    throw new Error(
      'TURSO_AUTH_TOKEN is missing or empty.'
    );
  }

  // Remove accidental Bearer prefix
  const cleanToken = rawToken
    .replace(/^Bearer\s+/i, '')
    .trim();

  // Keep libsql:// exactly as supplied.
  // @libsql/client supports libsql URLs.
  const cleanUrl = rawUrl
    .replace(/\/+$/, '')
    .trim();

  if (!/^libsql:\/\//i.test(cleanUrl) &&
      !/^https?:\/\//i.test(cleanUrl)) {
    throw new Error(
      'TURSO_DATABASE_URL has an unsupported format. Expected libsql://... or https://...'
    );
  }

  return createClient({
    url: cleanUrl,
    authToken: cleanToken
  });
}

// ============================================================
// QUERY REGISTRY
// ============================================================

const QUERY_REGISTRY = {

  check_connection: {
    sql: `
      SELECT 1 AS is_active;
    `,
    args: []
  },

  get_mcqs_by_chapter: {
    sql: `
      SELECT
        id,
        subject,
        chapter,
        difficulty,
        question,
        option_a,
        option_b,
        option_c,
        option_d,
        answer,
        explanation
      FROM mcqs
      WHERE subject = ?
        AND chapter = ?
      ORDER BY id
      LIMIT 25;
    `,
    args: ['subject', 'chapter']
  },

  count_generation_tasks: {
    sql: `
      SELECT
        status,
        COUNT(*) AS total
      FROM generation_tasks
      GROUP BY status
      ORDER BY status;
    `,
    args: []
  },

  inspect_generation_task_columns: {
    sql: `
      PRAGMA table_info(generation_tasks);
    `,
    args: []
  },

  inspect_mcqs_columns: {
    sql: `
      PRAGMA table_info(mcqs);
    `,
    args: []
  }
};

// ============================================================
// TASK HELPERS
// ============================================================

function parseTaskMCQs(value) {
  if (!value) return [];

  try {
    const parsed =
      typeof value === 'string'
        ? JSON.parse(value)
        : value;

    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (parsed && typeof parsed === 'object') {

      if (Array.isArray(parsed.mcqs)) {
        return parsed.mcqs;
      }

      if (Array.isArray(parsed.questions)) {
        return parsed.questions;
      }

      return [parsed];
    }

    return [];

  } catch {
    return [];
  }
}

function getRetryDelaySeconds(attemptNumber) {
  return RETRY_DELAY_SECONDS *
    Math.pow(
      2,
      Math.max(0, Number(attemptNumber || 1) - 1)
    );
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req, res) {

  const requestId =
    randomUUID().slice(0, 8);

  const startedAt = Date.now();

  const log = (
    level,
    message,
    meta = {}
  ) => {

    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        requestId,
        level,
        message,
        durationMs: Date.now() - startedAt,
        ...meta
      })
    );
  };

  // ==========================================================
  // HEADERS
  // ==========================================================

  res.setHeader(
    'Content-Type',
    'application/json'
  );

  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-admin-key'
  );

  // ==========================================================
  // OPTIONS
  // ==========================================================

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ==========================================================
  // METHOD
  // ==========================================================

  if (req.method !== 'POST') {

    return res.status(405).json({
      status: 'ERROR',
      error: 'METHOD_NOT_ALLOWED',
      message: 'Only POST allowed.',
      requestId
    });
  }

  // ==========================================================
  // BODY
  // ==========================================================

  let bodyData = {};

  try {

    bodyData =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {});

  } catch (error) {

    log(
      'error',
      'Invalid JSON',
      {
        error: safeErrorMessage(error)
      }
    );

    return res.status(400).json({
      status: 'ERROR',
      error: 'INVALID_JSON',
      message: 'Invalid JSON body.',
      requestId
    });
  }

  const {
    action,
    queryType,
    args = []
  } = bodyData;

  // ==========================================================
  // ADMIN AUTH
  // ==========================================================

  const headerAdminKey =
    req.headers['x-admin-key'];

  const bearerAdminKey =
    req.headers['authorization']
      ?.replace(/^Bearer\s+/i, '');

  const reqAdminKey =
    headerAdminKey || bearerAdminKey;

  if (
    !ADMIN_KEY ||
    reqAdminKey !== ADMIN_KEY
  ) {

    log(
      'warn',
      'Unauthorized request',
      {
        action
      }
    );

    return res.status(403).json({
      status: 'ERROR',
      error: 'UNAUTHORIZED',
      message: 'Valid admin authentication required.',
      requestId
    });
  }

  // ==========================================================
  // ACTION: DIAGNOSE CONNECTION
  // ==========================================================
  //
  // ReqBin:
  //
  // {
  //   "action": "diagnose_connection"
  // }
  //
  // ==========================================================

  if (action === 'diagnose_connection') {

    const envInfo =
      getTursoEnvironmentInfo();

    let dbClient = null;

    try {

      dbClient =
        createTursoClient();

    } catch (error) {

      const diagnostics =
        getErrorDiagnostics(error);

      log(
        'error',
        'Turso client creation failed',
        diagnostics
      );

      return res.status(500).json({
        status: 'ERROR',
        error: 'TURSO_CLIENT_CONFIGURATION_ERROR',

        diagnostics: {
          ...diagnostics,
          environment: envInfo,
          tokenExposed: false
        },

        message:
          'Turso client could not be created. Check TURSO_DATABASE_URL and TURSO_AUTH_TOKEN configuration.',

        requestId
      });
    }

    try {

      const result =
        await dbClient.execute({
          sql: `
            SELECT
              1 AS connection_ok,
              datetime('now') AS database_time;
          `,
          args: []
        });

      return res.status(200).json({

        status: 'SUCCESS',

        connection: {
          connected: true,
          queryExecuted: true
        },

        environment: {
          urlConfigured: envInfo.urlConfigured,
          tokenConfigured: envInfo.tokenConfigured,
          urlLength: envInfo.urlLength,
          tokenLength: envInfo.tokenLength,
          protocol: envInfo.protocol,
          hostname: envInfo.hostname,

          // Important security confirmation
          tokenExposed: false
        },

        database: {
          rows: result.rows || []
        },

        message:
          'Turso authentication and database query are working.',

        requestId
      });

    } catch (error) {

      const diagnostics =
        getErrorDiagnostics(error);

      log(
        'error',
        'Turso diagnostic query failed',
        diagnostics
      );

      return res.status(500).json({

        status: 'ERROR',

        error: 'TURSO_CONNECTION_FAILED',

        diagnostics: {
          ...diagnostics,

          environment: {
            urlConfigured: envInfo.urlConfigured,
            tokenConfigured: envInfo.tokenConfigured,
            urlLength: envInfo.urlLength,
            tokenLength: envInfo.tokenLength,
            protocol: envInfo.protocol,
            hostname: envInfo.hostname,

            tokenExposed: false
          }
        },

        message:
          'Turso server rejected the database request. The exact safe LibSQL error is shown in diagnostics.',

        requestId
      });
    }
  }

  // ==========================================================
  // ACTION: QUERY
  // ==========================================================

  if (action === 'query') {

    if (!queryType) {

      return res.status(400).json({
        status: 'ERROR',
        error: 'MISSING_QUERY_TYPE',
        message: 'queryType is required.',
        requestId
      });
    }

    const queryConfig =
      QUERY_REGISTRY[queryType];

    if (!queryConfig) {

      return res.status(400).json({
        status: 'ERROR',
        error: 'INVALID_QUERY',
        message:
          `Query type "${queryType}" is not allowed.`,
        requestId
      });
    }

    if (
      !Array.isArray(args) ||
      args.length !== queryConfig.args.length
    ) {

      return res.status(400).json({
        status: 'ERROR',
        error: 'INVALID_ARGS',
        message:
          `Expected ${queryConfig.args.length} arguments.`,
        requestId
      });
    }

    for (
      let i = 0;
      i < args.length;
      i++
    ) {

      if (
        typeof args[i] !== 'string' ||
        args[i].trim() === ''
      ) {

        return res.status(400).json({
          status: 'ERROR',
          error: 'INVALID_ARG',
          message:
            `Argument ${i + 1} must be a non-empty string.`,
          requestId
        });
      }
    }

    try {

      const db =
        createTursoClient();

      const result =
        await db.execute({
          sql: queryConfig.sql,
          args
        });

      const rows =
        result.rows || [];

      log(
        'info',
        'Query successful',
        {
          queryType,
          rowCount: rows.length
        }
      );

      return res.status(200).json({

        status: 'SUCCESS',

        connected: true,

        queryType,

        data: rows,

        requestId
      });

    } catch (error) {

      const diagnostics =
        getErrorDiagnostics(error);

      log(
        'error',
        'Query failed',
        {
          queryType,
          ...diagnostics
        }
      );

      return res.status(500).json({

        status: 'ERROR',

        error: 'DATABASE_ERROR',

        connected: false,

        queryType,

        diagnostics: {
          ...diagnostics,

          environment:
            getTursoEnvironmentInfo(),

          tokenExposed: false
        },

        message:
          'Database query failed. Safe server error details are returned above.',

        requestId
      });
    }
  }

  // ==========================================================
  // ACTION: PROCESS TASK
  // ==========================================================

  if (action === 'processTask') {

    const workerId =
      `worker-${randomUUID().slice(0, 8)}`;

    let claimedTask = null;

    try {

      const db =
        createTursoClient();

      // ======================================================
      // STEP 1: FAIL TASKS THAT EXCEEDED RETRIES
      // ======================================================

      await db.execute({

        sql: `
          UPDATE generation_tasks
          SET
            status = 'failed',
            locked_at = NULL,
            locked_by = NULL,
            failed_at = CURRENT_TIMESTAMP,
            last_error = 'Maximum retry attempts exceeded.',
            next_retry_at = NULL
          WHERE
            COALESCE(attempt_count, 0) >= ?
            AND
            (
              status = 'pending'
              OR status = 'in_progress'
            )
            AND
            (
              status = 'pending'
              OR locked_at IS NULL
              OR locked_at < datetime(
                'now',
                '-' || ? || ' seconds'
              )
            );
        `,

        args: [
          MAX_RETRY_ATTEMPTS,
          String(TASK_LEASE_TIMEOUT_SECONDS)
        ]
      });

      // ======================================================
      // STEP 2: ATOMIC TASK CLAIM
      // ======================================================

      const claimResult =
        await db.execute({

          sql: `
            UPDATE generation_tasks
            SET
              status = 'in_progress',
              locked_at = CURRENT_TIMESTAMP,
              locked_by = ?,
              attempt_count =
                COALESCE(attempt_count, 0) + 1,
              next_retry_at = NULL
            WHERE id = (
              SELECT id
              FROM generation_tasks
              WHERE
                (
                  (
                    status = 'pending'
                    AND
                    (
                      next_retry_at IS NULL
                      OR next_retry_at <= CURRENT_TIMESTAMP
                    )
                  )
                  OR
                  (
                    status = 'in_progress'
                    AND locked_at IS NOT NULL
                    AND locked_at < datetime(
                      'now',
                      '-' || ? || ' seconds'
                    )
                  )
                )
                AND
                COALESCE(attempt_count, 0) < ?
              ORDER BY
                created_at ASC,
                id ASC
              LIMIT 1
            )
            RETURNING *;
          `,

          args: [
            workerId,
            String(TASK_LEASE_TIMEOUT_SECONDS),
            MAX_RETRY_ATTEMPTS
          ]
        });

      const task =
        claimResult.rows?.[0] || null;

      // ======================================================
      // NO TASK
      // ======================================================

      if (!task) {

        log(
          'info',
          'No task available'
        );

        return res.status(200).json({

          status: 'SUCCESS',

          taskStatus: 'idle',

          message:
            'No pending tasks available.',

          requestId
        });
      }

      claimedTask = task;

      const attemptsUsed =
        Number(task.attempt_count || 0);

      log(
        'info',
        'Task claimed',
        {
          taskId: task.id,
          attempt: attemptsUsed,
          workerId
        }
      );

      // ======================================================
      // STEP 3: PARSE MCQS
      // ======================================================

      const rawMCQs =
        parseTaskMCQs(
          task.raw_mcqs ||
          task.payload ||
          task.raw_data
        );

      // ======================================================
      // STEP 4: EVIDENCE
      // ======================================================

      let evidenceText =
        task.evidence || '';

      if (
        !evidenceText &&
        task.subject &&
        task.chapter
      ) {

        try {

          evidenceText =
            await retrieveEvidence(
              task.subject,
              task.chapter
            );

        } catch (error) {

          log(
            'warn',
            'Evidence retrieval failed',
            {
              taskId: task.id,
              error: safeErrorMessage(error)
            }
          );
        }
      }

      // ======================================================
      // STEP 5: GENERATE + STORE
      // ======================================================

      const result =
        await generateAndStoreMCQs({

          subject:
            task.subject,

          chapter:
            task.chapter,

          rawMCQsInput:
            rawMCQs,

          evidenceText
        });

      const success =
        result?.success === true;

      const canRetry =
        !success &&
        attemptsUsed < MAX_RETRY_ATTEMPTS;

      const finalError =
        success
          ? null
          : (
              result?.error ||
              'MCQ generation failed.'
            );

      // ======================================================
      // STEP 6: RETRY
      // ======================================================

      if (canRetry) {

        const delaySeconds =
          getRetryDelaySeconds(
            attemptsUsed
          );

        const retryResult =
          await db.execute({

            sql: `
              UPDATE generation_tasks
              SET
                status = 'pending',
                locked_at = NULL,
                locked_by = NULL,
                completed_at = NULL,
                failed_at = NULL,
                last_error = ?,
                next_retry_at = datetime(
                  'now',
                  '+' || ? || ' seconds'
                )
              WHERE
                id = ?
                AND locked_by = ?
                AND status = 'in_progress';
            `,

            args: [
              finalError,
              String(delaySeconds),
              task.id,
              workerId
            ]
          });

        log(
          'warn',
          'Task scheduled for retry',
          {
            taskId: task.id,
            attempt: attemptsUsed,
            retryAfterSeconds: delaySeconds,
            affectedRows:
              retryResult.rowsAffected
          }
        );

        return res.status(200).json({

          status: 'SUCCESS',

          taskId:
            task.id,

          taskStatus:
            'pending',

          message:
            'Task failed and was scheduled for retry.',

          summary: {

            generated:
              result?.count || 0,

            inserted:
              result?.count || 0,

            rejected:
              result?.rejectedTotal || 0,

            duplicates:
              result?.duplicates || 0
          },

          requestId
        });
      }

      // ======================================================
      // STEP 7: FINAL STATUS
      // ======================================================

      const newStatus =
        success
          ? 'completed'
          : 'failed';

      const now =
        new Date().toISOString();

      const updateResult =
        await db.execute({

          sql: `
            UPDATE generation_tasks
            SET
              status = ?,
              locked_at = NULL,
              locked_by = NULL,
              completed_at = ?,
              failed_at = ?,
              last_error = ?,
              next_retry_at = NULL
            WHERE
              id = ?
              AND locked_by = ?
              AND status = 'in_progress'
            RETURNING id;
          `,

          args: [

            newStatus,

            success
              ? now
              : null,

            !success
              ? now
              : null,

            finalError,

            task.id,

            workerId
          ]
        });

      // ======================================================
      // OWNERSHIP LOST
      // ======================================================

      if (
        !updateResult.rows ||
        updateResult.rows.length === 0
      ) {

        log(
          'warn',
          'Task ownership lost',
          {
            taskId: task.id,
            workerId
          }
        );

        return res.status(409).json({

          status: 'ERROR',

          error:
            'TASK_OWNERSHIP_LOST',

          message:
            'Task was reclaimed by another worker.',

          requestId
        });
      }

      log(
        'info',
        'Task finalized',
        {
          taskId: task.id,
          status: newStatus
        }
      );

      return res.status(200).json({

        status: 'SUCCESS',

        taskId:
          task.id,

        taskStatus:
          newStatus,

        message:
          success
            ? 'Task completed successfully.'
            : 'Task failed permanently.',

        summary: {

          generated:
            result?.count || 0,

          inserted:
            result?.count || 0,

          rejected:
            result?.rejectedTotal || 0,

          duplicates:
            result?.duplicates || 0
        },

        requestId
      });

    } catch (error) {

      const errorMessage =
        safeErrorMessage(error);

      const diagnostics =
        getErrorDiagnostics(error);

      log(
        'error',
        'Task processing exception',
        {
          taskId:
            claimedTask?.id || null,

          workerId,

          ...diagnostics
        }
      );

      // ======================================================
      // RECOVERY
      // ======================================================

      if (claimedTask?.id) {

        try {

          const db =
            createTursoClient();

          const attemptsUsed =
            Number(
              claimedTask.attempt_count || 0
            );

          const canRetry =
            attemptsUsed < MAX_RETRY_ATTEMPTS;

          if (canRetry) {

            const delay =
              getRetryDelaySeconds(
                attemptsUsed
              );

            await db.execute({

              sql: `
                UPDATE generation_tasks
                SET
                  status = 'pending',
                  locked_at = NULL,
                  locked_by = NULL,
                  failed_at = NULL,
                  last_error = ?,
                  next_retry_at = datetime(
                    'now',
                    '+' || ? || ' seconds'
                  )
                WHERE
                  id = ?
                  AND locked_by = ?
                  AND status = 'in_progress';
              `,

              args: [
                errorMessage,
                String(delay),
                claimedTask.id,
                workerId
              ]
            });

          } else {

            await db.execute({

              sql: `
                UPDATE generation_tasks
                SET
                  status = 'failed',
                  locked_at = NULL,
                  locked_by = NULL,
                  failed_at = CURRENT_TIMESTAMP,
                  last_error = ?,
                  next_retry_at = NULL
                WHERE
                  id = ?
                  AND locked_by = ?
                  AND status = 'in_progress';
              `,

              args: [
                errorMessage,
                claimedTask.id,
                workerId
              ]
            });
          }

        } catch (recoveryError) {

          log(
            'error',
            'Recovery failed',
            {
              taskId:
                claimedTask.id,

              error:
                safeErrorMessage(
                  recoveryError
                )
            }
          );
        }
      }

      // ======================================================
      // IMPORTANT:
      // RETURN SAFE EXACT TURSO ERROR TO REQBIN
      // ======================================================

      return res.status(500).json({

        status: 'ERROR',

        error:
          'TASK_PROCESSING_ERROR',

        message:
          errorMessage,

        diagnostics: {

          errorName:
            diagnostics.errorName,

          errorCode:
            diagnostics.errorCode,

          cause:
            diagnostics.cause,

          taskId:
            claimedTask?.id || null,

          workerId,

          tursoEnvironment:
            getTursoEnvironmentInfo(),

          hint:
            'No database credentials are exposed. If errorCode is SERVER_ERROR and cause is HTTP 401, Turso authentication is being rejected before SQL/task processing.'
        },

        requestId
      });
    }
  }

  // ==========================================================
  // INVALID ACTION
  // ==========================================================

  return res.status(400).json({

    status: 'ERROR',

    error:
      'INVALID_ACTION',

    message:
      'Action must be "query", "diagnose_connection", or "processTask".',

    availableActions: [
      'diagnose_connection',
      'query',
      'processTask'
    ],

    requestId
  });
}
