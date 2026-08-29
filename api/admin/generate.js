// api/admin/generate.js
// ============================================================
// ✅ PRODUCTION VERSION
// Architecture unchanged
// Vercel + Turso + existing processTask preserved
// Added: Safe Turso diagnostic action
// ============================================================

import { generateAndStoreMCQs, retrieveEvidence } from '../../lib/mcq-generator.js';
import { createClient } from '@libsql/client';
import { randomUUID, createHash } from 'crypto';

const ADMIN_KEY = process.env.ADMIN_API_KEY;

const MAX_RETRY_ATTEMPTS = 3;
const TASK_LEASE_TIMEOUT_SECONDS = 120;
const RETRY_DELAY_SECONDS = 30;

// ============================================================
// 🔐 TURSO CLIENT
// ============================================================

function createTursoClient() {
  const rawUrl = process.env.TURSO_DATABASE_URL ?? '';
  const rawToken = process.env.TURSO_AUTH_TOKEN ?? '';

  const cleanUrl = rawUrl.trim();

  const cleanToken = rawToken
    .replace(/^Bearer\s+/i, '')
    .replace(/["'\s\r\n]/g, '')
    .trim();

  if (!cleanUrl) {
    throw new Error('Missing TURSO_DATABASE_URL');
  }

  if (!cleanToken) {
    throw new Error('Missing TURSO_AUTH_TOKEN');
  }

  return createClient({
    url: cleanUrl,
    authToken: cleanToken
  });
}

// ============================================================
// 📌 QUERY REGISTRY
// ============================================================

const QUERY_REGISTRY = {

  check_connection: {
    sql: 'SELECT 1 AS is_active;',
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
  }

};

// ============================================================
// 🛡️ SAFE ERROR
// ============================================================

function safeErrorMessage(error) {
  if (!error) return 'Unknown error';

  if (typeof error === 'string') {
    return error.replace(/\s+/g, ' ').slice(0, 500);
  }

  return String(error.message || error)
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

// ============================================================
// 📦 TASK MCQ PARSER
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

// ============================================================
// ⏱️ RETRY DELAY
// ============================================================

function getRetryDelaySeconds(attemptNumber) {

  return RETRY_DELAY_SECONDS *
    Math.pow(
      2,
      Math.max(0, Number(attemptNumber || 1) - 1)
    );
}

// ============================================================
// 🔎 SAFE TURSO DIAGNOSTIC
// ============================================================

async function diagnoseTurso() {

  const rawUrl = process.env.TURSO_DATABASE_URL ?? '';
  const rawToken = process.env.TURSO_AUTH_TOKEN ?? '';

  const cleanUrl = rawUrl.trim();

  const cleanToken = rawToken
    .replace(/^Bearer\s+/i, '')
    .replace(/["'\s\r\n]/g, '')
    .trim();

  // ----------------------------------------------------------
  // URL INFORMATION
  // ----------------------------------------------------------

  let protocol = 'INVALID_URL';
  let hostname = null;
  let urlParseError = null;

  if (cleanUrl) {

    try {

      const parsedUrl = new URL(cleanUrl);

      protocol = parsedUrl.protocol.replace(':', '');
      hostname = parsedUrl.hostname || null;

    } catch (error) {

      urlParseError = safeErrorMessage(error);

    }

  }

  // ----------------------------------------------------------
  // SAFE FINGERPRINTS
  // ----------------------------------------------------------

  const urlFingerprint = cleanUrl
    ? createHash('sha256')
        .update(cleanUrl)
        .digest('hex')
        .slice(0, 12)
    : null;

  const tokenFingerprint = cleanToken
    ? createHash('sha256')
        .update(cleanToken)
        .digest('hex')
        .slice(0, 12)
    : null;

  const diagnostics = {

    // Presence
    urlPresent: Boolean(cleanUrl),
    tokenPresent: Boolean(cleanToken),

    // Length only
    urlLength: cleanUrl.length,
    tokenLength: cleanToken.length,

    // URL
    protocol,
    hostname,
    urlParseError,

    // Safe identity fingerprints
    urlFingerprint,
    tokenFingerprint,

    // Detect common paste mistakes
    tokenHadBearerPrefix:
      /^Bearer\s+/i.test(rawToken),

    tokenHadOuterWhitespace:
      rawToken !== rawToken.trim(),

    tokenHadQuotes:
      /^["']|["']$/.test(rawToken.trim()),

    tokenContainsWhitespace:
      /\s/.test(rawToken),

    // Actual DB test
    select1: null,

    // Database information
    databaseIdentity: null
  };

  // ----------------------------------------------------------
  // BASIC VALIDATION
  // ----------------------------------------------------------

  if (!cleanUrl) {

    return {
      success: false,
      httpStatus: 500,
      error: 'TURSO_URL_MISSING',
      diagnostics
    };

  }

  if (!cleanToken) {

    return {
      success: false,
      httpStatus: 500,
      error: 'TURSO_TOKEN_MISSING',
      diagnostics
    };

  }

  if (protocol !== 'libsql') {

    return {
      success: false,
      httpStatus: 500,
      error: 'INVALID_TURSO_URL_PROTOCOL',
      diagnostics
    };

  }

  // ----------------------------------------------------------
  // CREATE CLIENT
  // ----------------------------------------------------------

  let db;

  try {

    db = createTursoClient();

  } catch (error) {

    return {
      success: false,
      httpStatus: 500,
      error: 'TURSO_CLIENT_CREATION_FAILED',
      message: safeErrorMessage(error),
      diagnostics
    };

  }

  // ----------------------------------------------------------
  // TEST 1: SELECT 1
  // ----------------------------------------------------------

  try {

    const result = await db.execute(
      'SELECT 1 AS is_active;'
    );

    diagnostics.select1 = {

      success: true,

      rowCount:
        result.rows?.length ?? 0,

      value:
        result.rows?.[0]?.is_active ?? null

    };

  } catch (error) {

    diagnostics.select1 = {

      success: false,

      errorName:
        error?.name || 'UnknownError',

      errorCode:
        error?.code || null,

      httpStatus:
        error?.status || null,

      message:
        safeErrorMessage(error)

    };

  }

  // ----------------------------------------------------------
  // TEST 2: DATABASE IDENTITY
  // ----------------------------------------------------------
  // This confirms we are actually talking to a SQLite/Turso
  // database through the supplied URL + token.
  // ----------------------------------------------------------

  if (diagnostics.select1?.success === true) {

    try {

      const identityResult = await db.execute(`
        SELECT
          sqlite_version() AS sqlite_version;
      `);

      diagnostics.databaseIdentity = {

        success: true,

        sqliteVersion:
          identityResult.rows?.[0]?.sqlite_version ?? null

      };

    } catch (error) {

      diagnostics.databaseIdentity = {

        success: false,

        errorName:
          error?.name || 'UnknownError',

        errorCode:
          error?.code || null,

        message:
          safeErrorMessage(error)

      };

    }

  }

  const authenticated =
    diagnostics.select1?.success === true;

  return {

    success: authenticated,

    httpStatus: authenticated ? 200 : 401,

    error: authenticated
      ? null
      : 'TURSO_AUTHENTICATION_FAILED',

    message: authenticated
      ? 'Turso credentials are accepted.'
      : 'Turso rejected the supplied credentials.',

    diagnostics

  };

}

// ============================================================
// 🚀 MAIN HANDLER
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

        timestamp:
          new Date().toISOString(),

        requestId,

        level,

        message,

        durationMs:
          Date.now() - startedAt,

        ...meta

      })
    );

  };

  // ----------------------------------------------------------
  // CORS
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // OPTIONS
  // ----------------------------------------------------------

  if (req.method === 'OPTIONS') {

    return res
      .status(200)
      .end();

  }

  // ----------------------------------------------------------
  // METHOD
  // ----------------------------------------------------------

  if (req.method !== 'POST') {

    return res.status(405).json({

      status: 'ERROR',

      error: 'METHOD_NOT_ALLOWED',

      message:
        'Only POST allowed.',

      requestId

    });

  }

  // ----------------------------------------------------------
  // BODY
  // ----------------------------------------------------------

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
        error:
          safeErrorMessage(error)
      }
    );

    return res.status(400).json({

      status: 'ERROR',

      error: 'INVALID_JSON',

      message:
        'Invalid JSON.',

      requestId

    });

  }

  const {
    action,
    queryType,
    args = []
  } = bodyData;

  // ----------------------------------------------------------
  // ADMIN AUTH
  // ----------------------------------------------------------

  const authorizationHeader =
    req.headers['authorization'];

  const reqAdminKey =
    req.headers['x-admin-key'] ||
    (
      typeof authorizationHeader === 'string'
        ? authorizationHeader.replace(
            /^Bearer\s+/i,
            ''
          )
        : ''
    );

  if (
    !ADMIN_KEY ||
    reqAdminKey !== ADMIN_KEY
  ) {

    log(
      'warn',
      'Unauthorized request'
    );

    return res.status(403).json({

      status: 'ERROR',

      error: 'UNAUTHORIZED',

      message:
        'Valid x-admin-key required.',

      requestId

    });

  }

  // ==========================================================
  // 🔎 ACTION 0: TURSO DIAGNOSTIC
  // ==========================================================

  if (action === 'diagnose_turso') {

    try {

      const diagnostic =
        await diagnoseTurso();

      log(

        diagnostic.success
          ? 'info'
          : 'error',

        diagnostic.success
          ? 'Turso diagnostic SUCCESS'
          : 'Turso diagnostic FAILED',

        {

          urlPresent:
            diagnostic.diagnostics.urlPresent,

          tokenPresent:
            diagnostic.diagnostics.tokenPresent,

          protocol:
            diagnostic.diagnostics.protocol,

          hostname:
            diagnostic.diagnostics.hostname,

          urlLength:
            diagnostic.diagnostics.urlLength,

          tokenLength:
            diagnostic.diagnostics.tokenLength,

          urlFingerprint:
            diagnostic.diagnostics.urlFingerprint,

          tokenFingerprint:
            diagnostic.diagnostics.tokenFingerprint,

          select1:
            diagnostic.diagnostics.select1

        }

      );

      return res
        .status(diagnostic.httpStatus)
        .json({

          status:
            diagnostic.success
              ? 'SUCCESS'
              : 'ERROR',

          error:
            diagnostic.error,

          message:
            diagnostic.message,

          diagnostics:
            diagnostic.diagnostics,

          requestId

        });

    } catch (error) {

      log(
        'error',
        'Turso diagnostic exception',
        {
          error:
            safeErrorMessage(error)
        }
      );

      return res.status(500).json({

        status: 'ERROR',

        error:
          'TURSO_DIAGNOSTIC_ERROR',

        message:
          safeErrorMessage(error),

        requestId

      });

    }

  }

  // ==========================================================
  // 🚀 ACTION 1: QUERY
  // ==========================================================

  if (action === 'query') {

    if (!queryType) {

      return res.status(400).json({

        status: 'ERROR',

        error:
          'MISSING_QUERY_TYPE',

        message:
          'queryType required.',

        requestId

      });

    }

    const queryConfig =
      QUERY_REGISTRY[queryType];

    if (!queryConfig) {

      return res.status(400).json({

        status: 'ERROR',

        error:
          'INVALID_QUERY',

        message:
          `Query type "${queryType}" not allowed.`,

        requestId

      });

    }

    if (
      !Array.isArray(args) ||
      args.length !== queryConfig.args.length
    ) {

      return res.status(400).json({

        status: 'ERROR',

        error:
          'INVALID_ARGS',

        message:
          `Expected ${queryConfig.args.length} args.`,

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

          error:
            'INVALID_ARG',

          message:
            `Argument ${i + 1} must be non-empty string.`,

          requestId

        });

      }

    }

    try {

      const db =
        createTursoClient();

      const result =
        await db.execute({

          sql:
            queryConfig.sql,

          args

        });

      const rows =
        result.rows || [];

      log(
        'info',
        'Query successful',
        {
          queryType,
          rowCount:
            rows.length
        }
      );

      return res.status(200).json({

        status: 'SUCCESS',

        connected: true,

        message:
          'Database connected successfully.',

        data: rows,

        requestId

      });

    } catch (error) {

      log(
        'error',
        'Query failed',
        {

          queryType,

          error:
            safeErrorMessage(error),

          errorName:
            error?.name || null,

          errorCode:
            error?.code || null

        }
      );

      return res.status(500).json({

        status: 'ERROR',

        error:
          'DATABASE_ERROR',

        connected: false,

        message:
          safeErrorMessage(error),

        diagnostics: {

          errorName:
            error?.name || null,

          errorCode:
            error?.code || null

        },

        requestId

      });

    }

  }

  // ==========================================================
  // ⚙️ ACTION 2: PROCESS TASK
  // ==========================================================

  if (action === 'processTask') {

    const workerId =
      `worker-${randomUUID().slice(0, 8)}`;

    let claimedTask = null;

    try {

      const db =
        createTursoClient();

      // ------------------------------------------------------
      // 1. RECOVER MAX ATTEMPTS
      // ------------------------------------------------------

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
            (
              status = 'pending'
              OR status = 'in_progress'
            )
            AND COALESCE(attempt_count, 0) >= ?
            AND (
              status = 'pending'
              OR locked_at IS NULL
              OR locked_at < datetime(
                'now',
                '-' || ? || ' seconds'
              )
            )
        `,

        args: [
          MAX_RETRY_ATTEMPTS,
          String(
            TASK_LEASE_TIMEOUT_SECONDS
          )
        ]

      });

      // ------------------------------------------------------
      // 2. ATOMIC CLAIM
      // ------------------------------------------------------

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

                  status = 'pending'

                  AND (
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

                AND COALESCE(
                  attempt_count,
                  0
                ) < ?

              ORDER BY
                created_at ASC,
                id ASC

              LIMIT 1

            )

            RETURNING *
          `,

          args: [

            workerId,

            String(
              TASK_LEASE_TIMEOUT_SECONDS
            ),

            MAX_RETRY_ATTEMPTS

          ]

        });

      const task =
        claimResult.rows?.[0] || null;

      if (!task) {

        log(
          'info',
          'No task to process'
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
        Number(
          task.attempt_count || 0
        );

      log(
        'info',
        'Task claimed',
        {

          taskId:
            task.id,

          attempt:
            attemptsUsed

        }
      );

      // ------------------------------------------------------
      // 3. PARSE MCQs
      // ------------------------------------------------------

      const rawMCQs =
        parseTaskMCQs(
          task.raw_mcqs ||
          task.payload ||
          task.raw_data
        );

      // ------------------------------------------------------
      // 4. EVIDENCE
      // ------------------------------------------------------

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

              taskId:
                task.id,

              error:
                safeErrorMessage(error)

            }
          );

        }

      }

      // ------------------------------------------------------
      // 5. GENERATE + STORE
      // ------------------------------------------------------

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

      const now =
        new Date().toISOString();

      // ------------------------------------------------------
      // 6. RETRY
      // ------------------------------------------------------

      if (canRetry) {

        const delaySeconds =
          getRetryDelaySeconds(
            attemptsUsed
          );

        const retryUpdate =
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
                next_retry_at =
                  datetime(
                    'now',
                    '+' || ? || ' seconds'
                  )

              WHERE
                id = ?
                AND locked_by = ?
                AND status = 'in_progress'
            `,

            args: [

              finalError,

              String(
                delaySeconds
              ),

              task.id,

              workerId

            ]

          });

        log(
          'warn',
          'Task scheduled for retry',
          {

            taskId:
              task.id,

            attempt:
              attemptsUsed,

            retryAfter:
              delaySeconds,

            updated:
              retryUpdate.rowsAffected

          }
        );

        return res.status(200).json({

          status: 'SUCCESS',

          taskId:
            task.id,

          taskStatus:
            'pending',

          message:
            'Task failed, will retry later.',

          summary: {

            generated: 0,

            inserted: 0,

            rejected:
              result?.rejectedTotal || 0

          },

          requestId

        });

      }

      // ------------------------------------------------------
      // 7. FINALIZE
      // ------------------------------------------------------

      const newStatus =
        success
          ? 'completed'
          : 'failed';

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

            RETURNING id
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

      if (
        !updateResult.rows ||
        updateResult.rows.length === 0
      ) {

        log(
          'warn',
          'Task ownership lost',
          {
            taskId:
              task.id
          }
        );

        return res.status(409).json({

          status: 'ERROR',

          error:
            'TASK_OWNERSHIP_LOST',

          message:
            'Task reclaimed by another worker.',

          requestId

        });

      }

      log(
        'info',
        'Task finalized',
        {

          taskId:
            task.id,

          status:
            newStatus

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

      log(
        'error',
        'Task processing exception',
        {

          taskId:
            claimedTask?.id || null,

          workerId,

          error:
            errorMessage,

          errorName:
            error?.name || null,

          errorCode:
            error?.code || null

        }
      );

      // ------------------------------------------------------
      // RECOVERY
      // ------------------------------------------------------

      if (claimedTask?.id) {

        try {

          const db =
            createTursoClient();

          const attemptsUsed =
            Number(
              claimedTask.attempt_count || 0
            );

          const canRetry =
            attemptsUsed <
            MAX_RETRY_ATTEMPTS;

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
                  next_retry_at =
                    datetime(
                      'now',
                      '+' || ? || ' seconds'
                    )

                WHERE
                  id = ?
                  AND locked_by = ?
                  AND status = 'in_progress'
              `,

              args: [

                errorMessage,

                String(delay),

                claimedTask.id,

                workerId

              ]

            });

            log(
              'info',
              'Task returned to retry queue',
              {
                taskId:
                  claimedTask.id
              }
            );

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
                  AND status = 'in_progress'
              `,

              args: [

                errorMessage,

                claimedTask.id,

                workerId

              ]

            });

            log(
              'error',
              'Task marked failed',
              {
                taskId:
                  claimedTask.id
              }
            );

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

      // ------------------------------------------------------
      // RETURN EXACT ERROR
      // ------------------------------------------------------

      return res.status(500).json({

        status: 'ERROR',

        error:
          'TASK_PROCESSING_ERROR',

        message:
          errorMessage,

        diagnostics: {

          errorName:
            error?.name || null,

          errorCode:
            error?.code || null,

          cause:
            error?.cause?.message ||
            error?.cause ||
            null,

          taskId:
            claimedTask?.id || null,

          workerId

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
      'Action must be "diagnose_turso", "query" or "processTask".',

    requestId

  });

}
