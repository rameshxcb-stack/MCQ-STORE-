// api/admin/generate.js
// ============================================================
// ✅ Production-Ready Vercel + Turso Admin Task Processor
// Architecture unchanged:
// Vercel API → generation_tasks → MCQ Generator → Turso
// ============================================================

import {
  generateAndStoreMCQs,
  retrieveEvidence,
  getDb
} from '../../lib/mcq-generator.js';

import { randomUUID } from 'crypto';

// ============================================================
// 🔐 CONFIGURATION
// ============================================================

const ADMIN_KEY = process.env.ADMIN_API_KEY;

const MAX_RETRY_ATTEMPTS = 3;

// Database lease only.
// This does NOT increase Vercel function execution timeout.
const TASK_LEASE_TIMEOUT_SECONDS = 120;

// Retry: 30s → 60s → 120s
const RETRY_DELAY_SECONDS = 30;

// ============================================================
// 📌 QUERY REGISTRY
// Admin-only predefined SQL.
// No arbitrary SQL is accepted from client.
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
// 🔧 HELPERS
// ============================================================

function safeErrorMessage(error) {
  if (!error) return 'Unknown error';

  if (typeof error === 'string') {
    return error.slice(0, 500);
  }

  return String(error.message || error)
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

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
  // attempt 1 → 30s
  // attempt 2 → 60s
  // attempt 3 → 120s
  return RETRY_DELAY_SECONDS * Math.pow(2, Math.max(0, attemptNumber - 1));
}

// ============================================================
// 🚀 MAIN HANDLER
// ============================================================

export default async function handler(req, res) {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();

  const log = (level, message, meta = {}) => {
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
  // 🌐 RESPONSE HEADERS
  // ==========================================================

  res.setHeader('Content-Type', 'application/json');

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
      message: 'Only POST requests are allowed.'
    });
  }

  // ==========================================================
  // ENVIRONMENT CHECK
  // ==========================================================

  const rawUrl = (process.env.TURSO_DATABASE_URL || '').trim();
  const rawToken = (process.env.TURSO_AUTH_TOKEN || '').trim();

  if (!rawUrl || !rawToken) {
    log('error', 'Turso environment variables missing');

    return res.status(500).json({
      status: 'ERROR',
      error: 'MISSING_CREDENTIALS',
      message: 'Database environment variables are not configured.'
    });
  }

  // ==========================================================
  // BODY PARSING
  // ==========================================================

  let bodyData = {};

  try {
    bodyData =
      typeof req.body === 'string'
        ? JSON.parse(req.body)
        : (req.body || {});
  } catch (error) {
    log('error', 'Invalid JSON body', {
      error: safeErrorMessage(error)
    });

    return res.status(400).json({
      status: 'ERROR',
      error: 'INVALID_JSON',
      message: 'Invalid JSON request body.'
    });
  }

  const {
    action,
    queryType,
    args = []
  } = bodyData;

  // ==========================================================
  // 🔐 ADMIN AUTHENTICATION
  // ALL ACTIONS REQUIRE ADMIN KEY
  // ==========================================================

  const authorizationHeader =
    req.headers['authorization'];

  const bearerKey =
    typeof authorizationHeader === 'string'
      ? authorizationHeader.replace(/^Bearer\s+/i, '').trim()
      : '';

  const headerAdminKey =
    typeof req.headers['x-admin-key'] === 'string'
      ? req.headers['x-admin-key'].trim()
      : '';

  const reqAdminKey =
    headerAdminKey || bearerKey;

  if (!ADMIN_KEY || reqAdminKey !== ADMIN_KEY) {
    log('warn', 'Unauthorized admin request', {
      action
    });

    return res.status(403).json({
      status: 'ERROR',
      error: 'UNAUTHORIZED',
      message: 'Valid admin authentication is required.'
    });
  }

  // ==========================================================
  // 🚀 ACTION 1: QUERY
  // ==========================================================

  if (action === 'query') {
    if (!queryType) {
      return res.status(400).json({
        status: 'ERROR',
        error: 'MISSING_QUERY_TYPE',
        message: 'queryType is required.'
      });
    }

    const queryConfig =
      QUERY_REGISTRY[queryType];

    if (!queryConfig) {
      log('warn', 'Invalid query type', {
        queryType
      });

      return res.status(400).json({
        status: 'ERROR',
        error: 'INVALID_QUERY',
        message: `Query type "${queryType}" is not allowed.`
      });
    }

    if (!Array.isArray(args)) {
      return res.status(400).json({
        status: 'ERROR',
        error: 'INVALID_ARGS',
        message: 'args must be an array.'
      });
    }

    if (
      args.length !==
      queryConfig.args.length
    ) {
      return res.status(400).json({
        status: 'ERROR',
        error: 'INVALID_ARGS',
        message:
          `Expected ${queryConfig.args.length} argument(s), ` +
          `received ${args.length}.`
      });
    }

    // Validate only configured string arguments.
    for (let i = 0; i < args.length; i++) {
      if (
        typeof args[i] !== 'string' ||
        args[i].trim() === ''
      ) {
        return res.status(400).json({
          status: 'ERROR',
          error: 'INVALID_ARG',
          message: `Argument ${i + 1} must be a non-empty string.`
        });
      }
    }

    try {
      // ======================================================
      // IMPORTANT:
      // Same DB client as the actual application.
      // No manual /v2/pipeline fetch.
      // ======================================================

      const db = getDb();

      const result = await db.execute({
        sql: queryConfig.sql,
        args
      });

      const rows = result.rows || [];

      log('info', 'Database query successful', {
        queryType,
        rowCount: rows.length
      });

      return res.status(200).json({
        status: 'SUCCESS',
        connected: true,
        message: 'Database connected successfully.',
        data: rows
      });

    } catch (error) {
      log('error', 'Database query failed', {
        queryType,
        error: safeErrorMessage(error)
      });

      return res.status(500).json({
        status: 'ERROR',
        error: 'DATABASE_ERROR',
        connected: false,
        message: 'Database query failed. Check server logs.',
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
      const db = getDb();

      // ======================================================
      // STEP 1
      // Recover tasks that have exceeded maximum attempts.
      //
      // This prevents:
      // status = in_progress
      // attempt_count >= MAX_RETRY_ATTEMPTS
      //
      // from staying stuck forever.
      // ======================================================

      await db.execute({
        sql: `
          UPDATE generation_tasks
          SET
            status = 'failed',
            locked_at = NULL,
            locked_by = NULL,
            failed_at = CURRENT_TIMESTAMP,
            last_error = COALESCE(
              last_error,
              'Maximum retry attempts exceeded.'
            )
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

      // ======================================================
      // STEP 2
      // ATOMIC CLAIM
      //
      // Instead of:
      // UPDATE ... ORDER BY ... LIMIT 1
      //
      // we select one eligible ID inside the UPDATE.
      //
      // This keeps the architecture the same while making the
      // statement more portable/reliable for SQLite/libSQL.
      // ======================================================

      const claimResult = await db.execute({
        sql: `
          UPDATE generation_tasks
          SET
            status = 'in_progress',
            locked_at = CURRENT_TIMESTAMP,
            locked_by = ?,
            attempt_count = COALESCE(attempt_count, 0) + 1,
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
              AND COALESCE(attempt_count, 0) < ?
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

      // ======================================================
      // NO TASK
      // ======================================================

      if (!task) {
        log('info', 'No eligible generation task found');

        return res.status(200).json({
          status: 'SUCCESS',
          taskStatus: 'idle',
          message: 'No pending tasks available.'
        });
      }

      claimedTask = task;

      const attemptsUsed =
        Number(task.attempt_count || 0);

      log('info', 'Task claimed', {
        taskId: task.id,
        workerId,
        attempt: attemptsUsed
      });

      // ======================================================
      // STEP 3
      // PARSE RAW MCQ INPUT
      // ======================================================

      const mcqData =
        task.raw_mcqs ??
        task.payload ??
        task.raw_data ??
        null;

      const rawMCQs =
        parseTaskMCQs(mcqData);

      // ======================================================
      // STEP 4
      // EVIDENCE
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
          log('warn', 'Evidence retrieval failed', {
            taskId: task.id,
            error: safeErrorMessage(error)
          });

          // Important:
          // Do not silently continue with unknown evidence.
          // generateAndStoreMCQs remains the final quality gate.
          evidenceText = '';
        }
      }

      // ======================================================
      // STEP 5
      // AI / MCQ PIPELINE
      // ======================================================

      const result =
        await generateAndStoreMCQs({
          subject: task.subject,
          chapter: task.chapter,
          rawMCQsInput: rawMCQs,
          evidenceText
        });

      const success =
        result?.success === true;

      // ======================================================
      // STEP 6
      // RETRY DECISION
      // ======================================================

      const canRetry =
        !success &&
        attemptsUsed < MAX_RETRY_ATTEMPTS;

      let newStatus = 'failed';

      if (success) {
        newStatus = 'completed';
      } else if (canRetry) {
        newStatus = 'pending';
      }

      const now =
        new Date().toISOString();

      const finalError =
        success
          ? null
          : (
              result?.error ||
              'MCQ generation failed.'
            );

      // ======================================================
      // STEP 7
      // FINAL UPDATE
      //
      // Ownership check:
      // Only the worker that owns the task can finalize it.
      // ======================================================

      if (canRetry) {
        const delaySeconds =
          getRetryDelaySeconds(attemptsUsed);

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
              AND status = 'in_progress'
          `,
          args: [
            finalError,
            String(delaySeconds),
            task.id,
            workerId
          ]
        });

        log('warn', 'Task scheduled for retry', {
          taskId: task.id,
          attempt: attemptsUsed,
          retryAfterSeconds: delaySeconds
        });

      } else {
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
              RETURNING id, status
            `,
            args: [
              newStatus,
              success ? now : null,
              !success ? now : null,
              finalError,
              task.id,
              workerId
            ]
          });

        if (
          !updateResult.rows ||
          updateResult.rows.length === 0
        ) {
          log('warn', 'Task ownership lost', {
            taskId: task.id,
            workerId
          });

          return res.status(409).json({
            status: 'ERROR',
            error: 'TASK_OWNERSHIP_LOST',
            message:
              'Task ownership was lost before finalization.',
            requestId
          });
        }

        log('info', 'Task finalized', {
          taskId: task.id,
          status: newStatus
        });
      }

      // ======================================================
      // STEP 8
      // RESPONSE SUMMARY
      // ======================================================

      const summary = {
        generated:
          Number(result?.count || 0),

        inserted:
          Number(result?.count || 0),

        rejected:
          Number(result?.rejectedTotal || 0),

        duplicates:
          Number(result?.duplicates || 0)
      };

      return res.status(200).json({
        status: 'SUCCESS',
        taskId: task.id,
        taskStatus: newStatus,
        attempt: attemptsUsed,
        message:
          success
            ? 'Task completed successfully.'
            : canRetry
              ? 'Task failed and has been scheduled for retry.'
              : 'Task failed permanently.',
        summary,
        requestId
      });

    } catch (error) {
      // ======================================================
      // ❌ UNEXPECTED PROCESSING ERROR
      // ======================================================

      const errorMessage =
        safeErrorMessage(error);

      log('error', 'Task processing exception', {
        taskId: claimedTask?.id || null,
        workerId,
        error: errorMessage
      });

      // ======================================================
      // TRY TO RECOVER CLAIMED TASK
      // ======================================================

      if (claimedTask?.id) {
        try {
          const db = getDb();

          const attemptsUsed =
            Number(
              claimedTask.attempt_count || 0
            );

          const canRetry =
            attemptsUsed < MAX_RETRY_ATTEMPTS;

          if (canRetry) {
            const delaySeconds =
              getRetryDelaySeconds(attemptsUsed);

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
                  AND status = 'in_progress'
              `,
              args: [
                errorMessage,
                String(delaySeconds),
                claimedTask.id,
                workerId
              ]
            });

            log('info', 'Task returned to retry queue', {
              taskId: claimedTask.id,
              retryAfterSeconds: delaySeconds
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

            log('error', 'Task marked permanently failed', {
              taskId: claimedTask.id
            });
          }

        } catch (recoveryError) {
          log(
            'error',
            'Failed to recover task after exception',
            {
              taskId: claimedTask.id,
              error: safeErrorMessage(recoveryError)
            }
          );
        }
      }

      // ======================================================
      // 🔒 PRODUCTION-SAFE RESPONSE
      // Do NOT expose raw internal error to client.
      // Exact error is available in Vercel logs via requestId.
      // ======================================================

      return res.status(500).json({
        status: 'ERROR',
        error: 'TASK_PROCESSING_ERROR',
        message: 'Task processing failed. Check server logs.',
        requestId
      });
    }
  }

  // ==========================================================
  // ❌ INVALID ACTION
  // ==========================================================

  return res.status(400).json({
    status: 'ERROR',
    error: 'INVALID_ACTION',
    message:
      'Action must be "query" or "processTask".'
  });
}
