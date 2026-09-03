// api/admin/generate.js
// ============================================================
// PRODUCTION ADMIN API
// Turso is accessed ONLY through /lib/db.js
//
// IMPORTANT:
// - No @libsql/client here
// - No direct Turso credentials here
// - No hardcoded token
// - No hardcoded_test action
// - All DB operations use the central HTTP DB client
// ============================================================

import {
  generateAndStoreMCQs,
  retrieveEvidence
} from '../../lib/mcq-generator.js';

import {
  getDb,
  getDbDiagnostics,
  safeDbError,
  diagnoseTurso
} from '../../lib/db.js';

import { randomUUID } from 'crypto';

// ============================================================
// CONFIG
// ============================================================

const ADMIN_KEY = process.env.ADMIN_API_KEY;

const MAX_RETRY_ATTEMPTS = 3;

const TASK_LEASE_TIMEOUT_SECONDS = 180;

const RETRY_DELAY_SECONDS = 30;

// ============================================================
// QUERY REGISTRY
// Admin-only allowlisted SQL
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
// HELPERS
// ============================================================

function safeErrorMessage(error) {
  if (!error) {
    return 'Unknown error';
  }

  return String(
    error?.message || error
  )
    .replace(/\s+/g, ' ')
    .slice(0, 1000);
}

// ------------------------------------------------------------
// Parse task MCQs safely
// ------------------------------------------------------------

function parseTaskMCQs(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed =
      typeof value === 'string'
        ? JSON.parse(value)
        : value;

    if (Array.isArray(parsed)) {
      return parsed;
    }

    if (
      parsed &&
      typeof parsed === 'object'
    ) {
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

// ------------------------------------------------------------
// Retry delay
// ------------------------------------------------------------

function getRetryDelaySeconds(attemptNumber) {
  return (
    RETRY_DELAY_SECONDS *
    Math.pow(
      2,
      Math.max(0, attemptNumber - 1)
    )
  );
}

// ------------------------------------------------------------
// Admin key
// ------------------------------------------------------------

function getAdminKey(req) {
  const headerKey =
    req.headers['x-admin-key'];

  if (headerKey) {
    return String(headerKey);
  }

  const authorization =
    req.headers['authorization'];

  if (authorization) {
    return authorization.replace(
      /^Bearer\s+/i,
      ''
    );
  }

  return null;
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req, res) {
  const requestId =
    randomUUID().slice(0, 8);

  const startedAt = Date.now();

  // ----------------------------------------------------------
  // Structured logger
  // ----------------------------------------------------------

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
  // Headers
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
    return res.status(200).end();
  }

  // ----------------------------------------------------------
  // Only POST
  // ----------------------------------------------------------

  if (req.method !== 'POST') {
    return res.status(405).json({
      status: 'ERROR',
      error: 'METHOD_NOT_ALLOWED',
      message: 'Only POST requests are allowed.',
      requestId
    });
  }

  // ----------------------------------------------------------
  // Parse body
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
      message: 'Invalid JSON request body.',
      requestId
    });
  }

  const {
    action,
    queryType,
    args = []
  } = bodyData;

  // ==========================================================
  // ADMIN AUTHENTICATION
  // ==========================================================

  const reqAdminKey =
    getAdminKey(req);

  if (
    !ADMIN_KEY ||
    !reqAdminKey ||
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
      message:
        'Valid x-admin-key is required.',
      requestId
    });
  }

  // ==========================================================
  // ACTION 1: DIAGNOSE
  // ==========================================================

  if (action === 'diagnose') {
    try {
      const diagnostics =
        await diagnoseTurso();

      log(
        diagnostics.success
          ? 'info'
          : 'error',
        'Database diagnosis completed',
        {
          success:
            diagnostics.success
        }
      );

      return res.status(
        diagnostics.success
          ? 200
          : 500
      ).json({
        ...diagnostics,
        requestId
      });

    } catch (error) {
      const dbError =
        safeDbError(error);

      log(
        'error',
        'Database diagnosis failed',
        {
          error:
            dbError.message,
          errorCode:
            dbError.code
        }
      );

      return res.status(500).json({
        status: 'ERROR',
        error: 'DIAGNOSIS_FAILED',
        connected: false,
        message:
          dbError.message,
        diagnostics:
          getDbDiagnostics(),
        requestId
      });
    }
  }

  // ==========================================================
  // ACTION 2: QUERY
  // ==========================================================

  if (action === 'query') {
    if (!queryType) {
      return res.status(400).json({
        status: 'ERROR',
        error: 'MISSING_QUERY_TYPE',
        message:
          'queryType is required.',
        requestId
      });
    }

    const queryConfig =
      QUERY_REGISTRY[queryType];

    if (!queryConfig) {
      log(
        'error',
        'Invalid query type',
        {
          queryType
        }
      );

      return res.status(400).json({
        status: 'ERROR',
        error: 'INVALID_QUERY',
        message:
          `Query type "${queryType}" is not allowed.`,
        requestId
      });
    }

    // --------------------------------------------------------
    // Validate arguments
    // --------------------------------------------------------

    const expectedArgNames =
      queryConfig.args;

    if (
      !Array.isArray(args) ||
      args.length !==
        expectedArgNames.length
    ) {
      return res.status(400).json({
        status: 'ERROR',
        error: 'INVALID_ARGS',
        message:
          `Expected ${expectedArgNames.length} argument(s).`,
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

    // --------------------------------------------------------
    // Execute using CENTRAL HTTP DB
    // --------------------------------------------------------

    try {
      const db = getDb();

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
          rowCount:
            rows.length
        }
      );

      return res.status(200).json({
        status: 'SUCCESS',
        connected: true,
        message:
          'Database query executed successfully.',
        data: rows,
        diagnostics: {
          queryType,
          rowCount:
            rows.length
        },
        requestId
      });

    } catch (error) {
      const dbError =
        safeDbError(error);

      const diagnostics =
        getDbDiagnostics();

      log(
        'error',
        'Query failed',
        {
          queryType,
          error:
            dbError.message,
          errorName:
            dbError.name,
          errorCode:
            dbError.code,
          diagnostics
        }
      );

      return res.status(500).json({
        status: 'ERROR',
        error: 'DATABASE_ERROR',
        connected: false,
        message:
          'Database query failed.',
        diagnostics: {
          errorName:
            dbError.name,

          errorCode:
            dbError.code,

          cause:
            dbError.message,

          databaseConfig: {
            urlConfigured:
              diagnostics.urlConfigured,

            tokenConfigured:
              diagnostics.tokenConfigured,

            urlProtocol:
              diagnostics.urlProtocol ||
              null,

            urlHost:
              diagnostics.urlHost ||
              null,

            tokenLength:
              diagnostics.tokenLength ||
              null
          },

          hint:
            'Database access is handled only by lib/db.js. No database token is exposed.'
        },

        requestId
      });
    }
  }

  // ==========================================================
  // ACTION 3: processTask
  // ==========================================================

  if (action === 'processTask') {
    const workerId =
      `worker-${randomUUID().slice(0, 8)}`;

    let claimedTask = null;

    try {
      const db = getDb();

      // ------------------------------------------------------
      // Recover tasks that exceeded retry limit
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
            (status = 'pending'
             OR status = 'in_progress')
            AND COALESCE(attempt_count, 0) >= ?
            AND (
              status = 'pending'
              OR locked_at IS NULL
              OR locked_at <
                 datetime(
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
      // Atomic task claim
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
                    AND locked_at <
                        datetime(
                          'now',
                          '-' || ? || ' seconds'
                        )
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
        claimResult.rows?.[0] ||
        null;

      // ------------------------------------------------------
      // No task
      // ------------------------------------------------------

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
        Number(
          task.attempt_count || 0
        );

      log(
        'info',
        'Task claimed',
        {
          taskId: task.id,
          attempt:
            attemptsUsed,
          workerId
        }
      );

      // ------------------------------------------------------
      // Parse raw MCQs
      // ------------------------------------------------------

      const rawMCQs =
        parseTaskMCQs(
          task.raw_mcqs ||
          task.payload ||
          task.raw_data
        );

      // ------------------------------------------------------
      // Evidence
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
              taskId: task.id,
              error:
                safeErrorMessage(error)
            }
          );
        }
      }

      // ------------------------------------------------------
      // Generate and store MCQs
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
        attemptsUsed <
          MAX_RETRY_ATTEMPTS;

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
      // Retry
      // ------------------------------------------------------

      if (canRetry) {
        const delaySeconds =
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
            attempt:
              attemptsUsed,
            retryAfter:
              delaySeconds
          }
        );

        return res.status(200).json({
          status: 'SUCCESS',
          taskId:
            task.id,
          taskStatus:
            'pending',
          message:
            'Task failed and will retry later.',
          summary: {
            generated: 0,
            inserted: 0,
            rejected:
              result?.rejectedTotal ||
              0
          },
          requestId
        });
      }

      // ------------------------------------------------------
      // Finalize task
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

      // ------------------------------------------------------
      // Ownership lost
      // ------------------------------------------------------

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
            'Task was reclaimed by another worker.',
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
            result?.count ||
            0,

          inserted:
            result?.count ||
            0,

          rejected:
            result?.rejectedTotal ||
            0,

          duplicates:
            result?.duplicates ||
            0
        },

        requestId
      });

    } catch (error) {
      // ------------------------------------------------------
      // Task processing exception
      // ------------------------------------------------------

      const dbError =
        safeDbError(error);

      const errorMessage =
        dbError.message;

      log(
        'error',
        'Task processing exception',
        {
          taskId:
            claimedTask?.id ||
            null,

          workerId,

          error:
            errorMessage,

          errorCode:
            dbError.code
        }
      );

      // ------------------------------------------------------
      // Recovery
      // ------------------------------------------------------

      if (claimedTask?.id) {
        try {
          const db = getDb();

          const attemptsUsed =
            Number(
              claimedTask.attempt_count ||
              0
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
          }

        } catch (recoveryError) {
          log(
            'error',
            'Task recovery failed',
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

      const diagnostics =
        getDbDiagnostics();

      return res.status(500).json({
        status: 'ERROR',

        error:
          'TASK_PROCESSING_ERROR',

        message:
          errorMessage,

        diagnostics: {
          errorName:
            dbError.name,

          errorCode:
            dbError.code,

          cause:
            errorMessage,

          taskId:
            claimedTask?.id ||
            null,

          workerId,

          databaseConfig: {
            urlConfigured:
              diagnostics.urlConfigured,

            tokenConfigured:
              diagnostics.tokenConfigured,

            urlProtocol:
              diagnostics.urlProtocol ||
              null,

            urlHost:
              diagnostics.urlHost ||
              null,

            tokenLength:
              diagnostics.tokenLength ||
              null
          }
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
    error: 'INVALID_ACTION',
    message:
      'Action must be "diagnose", "query", or "processTask".',
    requestId
  });
}
