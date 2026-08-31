// api/admin/generate.js
// ============================================================
// ADMIN GENERATION API
// Centralized Turso connection through lib/db.js
// ============================================================

import {
  getDb,
  diagnoseTurso
} from '../../lib/db.js';

import {
  generateAndStoreMCQs,
  retrieveEvidence
} from '../../lib/mcq-generator.js';

import { randomUUID } from 'crypto';

// ============================================================
// CONFIG
// ============================================================

const ADMIN_KEY = process.env.ADMIN_API_KEY;

const MAX_RETRY_ATTEMPTS = 3;

const TASK_LEASE_TIMEOUT_SECONDS = 120;

const RETRY_DELAY_SECONDS = 30;

// ============================================================
// QUERY REGISTRY
// ============================================================

const QUERY_REGISTRY = {
  check_connection: {
    sql: 'SELECT 1 AS is_active',
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
      LIMIT 25
    `,
    args: ['subject', 'chapter']
  }
};

// ============================================================
// SAFE ERROR MESSAGE
// ============================================================

function safeErrorMessage(error) {
  if (!error) {
    return 'Unknown error';
  }

  if (typeof error === 'string') {
    return error
      .replace(/\s+/g, ' ')
      .slice(0, 500);
  }

  return String(
    error?.message ||
    error?.cause?.message ||
    error
  )
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

// ============================================================
// PARSE TASK MCQs
// ============================================================

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
// RETRY DELAY
// ============================================================

function getRetryDelaySeconds(attemptNumber) {
  return (
    RETRY_DELAY_SECONDS *
    Math.pow(
      2,
      Math.max(0, attemptNumber - 1)
    )
  );
}

// ============================================================
// ADMIN AUTH
// ============================================================

function getRequestAdminKey(req) {
  const headerKey =
    req.headers['x-admin-key'];

  if (typeof headerKey === 'string' && headerKey.trim()) {
    return headerKey.trim();
  }

  const authorization =
    req.headers.authorization;

  if (
    typeof authorization === 'string' &&
    /^Bearer\s+/i.test(authorization)
  ) {
    return authorization
      .replace(/^Bearer\s+/i, '')
      .trim();
  }

  return '';
}

// ============================================================
// MAIN HANDLER
// ============================================================

export default async function handler(req, res) {

  const requestId =
    randomUUID().slice(0, 8);

  const startedAt = Date.now();

  function log(level, message, meta = {}) {

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
  }

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
    return res.status(200).end();
  }

  // ----------------------------------------------------------
  // POST ONLY
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

  // ----------------------------------------------------------
  // ADMIN AUTHENTICATION
  // ----------------------------------------------------------

  const reqAdminKey =
    getRequestAdminKey(req);

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
      message: 'Valid x-admin-key is required.',
      requestId
    });
  }

  // ==========================================================
  // ACTION: diagnose_turso
  // ==========================================================

  if (action === 'diagnose_turso') {

    try {

      const diagnosis =
        await diagnoseTurso();

      log(
        diagnosis.success
          ? 'info'
          : 'error',
        'Turso diagnostic completed',
        {
          success: diagnosis.success,
          error: diagnosis.error || null,
          select1:
            diagnosis.diagnostics?.select1?.success || false
        }
      );

      return res
        .status(
          diagnosis.success
            ? 200
            : diagnosis.error === 'TURSO_AUTHENTICATION_FAILED'
              ? 401
              : 500
        )
        .json({
          ...diagnosis,
          requestId
        });

    } catch (error) {

      log(
        'error',
        'Turso diagnostic exception',
        {
          error: safeErrorMessage(error)
        }
      );

      return res.status(500).json({
        status: 'ERROR',
        error: 'TURSO_DIAGNOSTIC_ERROR',
        message: safeErrorMessage(error),
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

      log(
        'warn',
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

    if (
      !Array.isArray(args) ||
      args.length !== queryConfig.args.length
    ) {

      return res.status(400).json({
        status: 'ERROR',
        error: 'INVALID_ARGS',
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
          error: 'INVALID_ARG',
          message:
            `Argument ${i + 1} must be a non-empty string.`,
          requestId
        });
      }
    }

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
          rowCount: rows.length
        }
      );

      return res.status(200).json({
        status: 'SUCCESS',
        connected: true,
        message:
          'Database query successful.',
        data: rows,
        requestId
      });

    } catch (error) {

      const errorMessage =
        safeErrorMessage(error);

      log(
        'error',
        'Query failed',
        {
          queryType,
          error: errorMessage
        }
      );

      const is401 =
        /401|unauthorized/i.test(
          errorMessage
        );

      return res
        .status(is401 ? 401 : 500)
        .json({
          status: 'ERROR',
          error: is401
            ? 'TURSO_AUTHENTICATION_FAILED'
            : 'DATABASE_ERROR',
          connected: false,
          message: errorMessage,
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

      // --------------------------------------------------------
      // SINGLE CENTRAL DB CLIENT
      // --------------------------------------------------------

      const db = getDb();

      // --------------------------------------------------------
      // 1. Recover tasks exceeding max attempts
      // --------------------------------------------------------

      await db.execute({
        sql: `
          UPDATE generation_tasks
          SET
            status = 'failed',
            locked_at = NULL,
            locked_by = NULL,
            failed_at = CURRENT_TIMESTAMP,
            last_error = 'Maximum retry attempts exceeded.'
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
          String(TASK_LEASE_TIMEOUT_SECONDS)
        ]
      });

      // --------------------------------------------------------
      // 2. Atomic task claim
      // --------------------------------------------------------

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
                    AND locked_at < datetime(
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
            String(TASK_LEASE_TIMEOUT_SECONDS),
            MAX_RETRY_ATTEMPTS
          ]

        });

      const task =
        claimResult.rows?.[0] || null;

      // --------------------------------------------------------
      // No task
      // --------------------------------------------------------

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
          attempt: attemptsUsed
        }
      );

      // --------------------------------------------------------
      // 3. Parse raw MCQs
      // --------------------------------------------------------

      const rawMCQs =
        parseTaskMCQs(
          task.raw_mcqs ||
          task.payload ||
          task.raw_data
        );

      // --------------------------------------------------------
      // 4. Evidence
      // --------------------------------------------------------

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

      // --------------------------------------------------------
      // 5. Generate and store MCQs
      // --------------------------------------------------------

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

      // --------------------------------------------------------
      // 6. Retry
      // --------------------------------------------------------

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
            attempt: attemptsUsed,
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
              result?.rejectedTotal || 0,

            duplicates:
              result?.duplicates || 0
          },

          requestId
        });
      }

      // --------------------------------------------------------
      // 7. Finalize task
      // --------------------------------------------------------

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

      // --------------------------------------------------------
      // Ownership lost
      // --------------------------------------------------------

      if (
        !updateResult.rows ||
        updateResult.rows.length === 0
      ) {

        log(
          'warn',
          'Task ownership lost',
          {
            taskId: task.id
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

      log(
        'error',
        'Task processing exception',
        {
          taskId:
            claimedTask?.id || null,

          workerId,

          error:
            errorMessage
        }
      );

      // --------------------------------------------------------
      // Recovery
      // --------------------------------------------------------

      if (claimedTask?.id) {

        try {

          const db =
            getDb();

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
              'Task marked permanently failed',
              {
                taskId:
                  claimedTask.id
              }
            );
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

      const is401 =
        /401|unauthorized/i.test(
          errorMessage
        );

      return res
        .status(is401 ? 401 : 500)
        .json({

          status: 'ERROR',

          error:
            is401
              ? 'TURSO_AUTHENTICATION_FAILED'
              : 'TASK_PROCESSING_ERROR',

          message:
            errorMessage,

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
      'Action must be "diagnose_turso", "query" or "processTask".',

    requestId
  });
}
