// api/admin/generate.js
// ============================================================
// Vercel + Turso
// Production Architecture Preserved
// DEBUG VERSION: Exact DB errors returned to ReqBin
// ============================================================

import {
  generateAndStoreMCQs,
  retrieveEvidence,
  getDb
} from '../../lib/mcq-generator.js';

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
// ============================================================

const QUERY_REGISTRY = {

  // ----------------------------------------------------------
  // DATABASE CONNECTION TEST
  // ----------------------------------------------------------
  check_connection: {
    sql: 'SELECT 1 AS is_active;',
    args: []
  },

  // ----------------------------------------------------------
  // MCQ QUERY
  // ----------------------------------------------------------
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
// MAIN HANDLER
// ============================================================

export default async function handler(req, res) {

  const requestId = randomUUID().slice(0, 8);
  const startTime = Date.now();

  // ----------------------------------------------------------
  // Structured logger
  // ----------------------------------------------------------

  const log = (level, message, meta = {}) => {

    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        requestId,
        level,
        message,
        durationMs: Date.now() - startTime,
        ...meta
      })
    );

  };

  // ----------------------------------------------------------
  // CORS / RESPONSE HEADERS
  // ----------------------------------------------------------

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

  // ----------------------------------------------------------
  // OPTIONS
  // ----------------------------------------------------------

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ----------------------------------------------------------
  // METHOD CHECK
  // ----------------------------------------------------------

  if (req.method !== 'POST') {

    return res.status(405).json({
      status: 'ERROR',
      error: 'METHOD_NOT_ALLOWED',
      message: 'Only POST requests are allowed.',
      requestId
    });

  }

  // ==========================================================
  // ENVIRONMENT VARIABLES
  // ==========================================================

  const rawUrl =
    (process.env.TURSO_DATABASE_URL || '').trim();

  const rawToken =
    (process.env.TURSO_AUTH_TOKEN || '').trim();

  // ----------------------------------------------------------
  // Credential existence check
  // ----------------------------------------------------------

  if (!rawUrl || !rawToken) {

    log(
      'error',
      'Missing Turso environment variables',
      {
        hasDatabaseUrl: Boolean(rawUrl),
        hasDatabaseToken: Boolean(rawToken)
      }
    );

    return res.status(500).json({

      status: 'ERROR',

      error: 'MISSING_CREDENTIALS',

      connected: false,

      message:
        'TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is missing in Vercel Environment Variables.',

      diagnostics: {
        hasDatabaseUrl: Boolean(rawUrl),
        hasDatabaseToken: Boolean(rawToken)
      },

      requestId

    });

  }

  // ==========================================================
  // TOKEN SANITIZATION
  // ==========================================================

  const cleanToken =
    rawToken
      .replace(/^Bearer\s+/i, '')
      .replace(/["'\s\r\n]/g, '')
      .trim();

  // ==========================================================
  // URL SANITIZATION
  // ==========================================================

  const cleanUrl =
    rawUrl
      .replace(/^libsql:\/\//i, 'https://')
      .replace(/\/$/, '');

  const endpoint =
    `${cleanUrl}/v2/pipeline`;

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

    return res.status(400).json({

      status: 'ERROR',

      error: 'INVALID_JSON',

      message: 'Invalid JSON request body.',

      requestId

    });

  }

  // ==========================================================
  // REQUEST DATA
  // ==========================================================

  const {
    action,
    queryType,
    args = []
  } = bodyData;

  // ==========================================================
  // ADMIN AUTHENTICATION
  // ==========================================================

  const authorizationHeader =
    req.headers['authorization'];

  const adminHeader =
    req.headers['x-admin-key'];

  const reqAdminKey =
    adminHeader ||
    authorizationHeader?.replace(
      /^Bearer\s+/i,
      ''
    );

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

      message:
        'Valid x-admin-key or Authorization Bearer admin key is required.',

      requestId

    });

  }

  // ============================================================
  // ACTION 1: QUERY
  // ============================================================

  if (action === 'query') {

    // ----------------------------------------------------------
    // queryType check
    // ----------------------------------------------------------

    if (!queryType) {

      return res.status(400).json({

        status: 'ERROR',

        error: 'MISSING_QUERY_TYPE',

        message:
          'queryType is required.',

        requestId

      });

    }

    // ----------------------------------------------------------
    // Registry lookup
    // ----------------------------------------------------------

    const queryConfig =
      QUERY_REGISTRY[queryType];

    if (!queryConfig) {

      return res.status(400).json({

        status: 'ERROR',

        error: 'INVALID_QUERY',

        message:
          `Query type "${queryType}" is not allowed.`,

        allowedQueries:
          Object.keys(QUERY_REGISTRY),

        requestId

      });

    }

    // ----------------------------------------------------------
    // Argument validation
    // ----------------------------------------------------------

    const expectedArgNames =
      queryConfig.args;

    if (
      !Array.isArray(args) ||
      args.length !== expectedArgNames.length
    ) {

      return res.status(400).json({

        status: 'ERROR',

        error: 'INVALID_ARGS',

        message:
          `Expected ${expectedArgNames.length} argument(s), received ${Array.isArray(args) ? args.length : 'invalid value'}.`,

        expectedArguments:
          expectedArgNames,

        requestId

      });

    }

    // ========================================================
    // DATABASE TEST
    // ========================================================

    try {

      log(
        'info',
        'Attempting database query',
        {
          queryType
        }
      );

      // ------------------------------------------------------
      // IMPORTANT:
      // This uses the SAME getDb() used by processTask.
      // ------------------------------------------------------

      const db = getDb();

      if (!db) {

        throw new Error(
          'getDb() returned null or undefined.'
        );

      }

      log(
        'info',
        'getDb() initialized successfully',
        {
          queryType,
          hasDbObject: true
        }
      );

      // ------------------------------------------------------
      // Execute query
      // ------------------------------------------------------

      const result =
        await db.execute({
          sql: queryConfig.sql,
          args
        });

      const rows =
        result?.rows || [];

      log(
        'info',
        'Database query successful',
        {
          queryType,
          rowCount: rows.length
        }
      );

      // ------------------------------------------------------
      // SUCCESS
      // ------------------------------------------------------

      return res.status(200).json({

        status: 'SUCCESS',

        connected: true,

        message:
          'Database connected successfully and query executed.',

        queryType,

        rowCount:
          rows.length,

        data:
          rows,

        requestId

      });

    } catch (err) {

      // ======================================================
      // 🔥 EXACT DATABASE ERROR FOR REQBIN
      // ======================================================

      const errorName =
        err?.name || 'UnknownError';

      const errorMessage =
        err?.message ||
        'Unknown database error';

      const errorCode =
        err?.code ||
        err?.cause?.code ||
        null;

      const causeMessage =
        err?.cause?.message ||
        null;

      // ------------------------------------------------------
      // Server log
      // ------------------------------------------------------

      console.error(
        '===================================================='
      );

      console.error(
        'DATABASE QUERY ERROR'
      );

      console.error(
        'Request ID:',
        requestId
      );

      console.error(
        'Query Type:',
        queryType
      );

      console.error(
        'Error Name:',
        errorName
      );

      console.error(
        'Error Message:',
        errorMessage
      );

      console.error(
        'Error Code:',
        errorCode
      );

      console.error(
        'Cause:',
        causeMessage
      );

      console.error(
        'Stack:',
        err?.stack
      );

      console.error(
        '===================================================='
      );

      // ------------------------------------------------------
      // IMPORTANT:
      // URL/token are NEVER returned.
      // ------------------------------------------------------

      return res.status(500).json({

        status: 'ERROR',

        error: 'DATABASE_ERROR',

        connected: false,

        message:
          errorMessage,

        diagnostics: {

          errorName:
            errorName,

          errorCode:
            errorCode,

          cause:
            causeMessage,

          queryType:
            queryType,

          databaseClient:
            'getDb()',

          hint:
            'The request reached Vercel, but getDb().execute() failed.'

        },

        requestId

      });

    }

  }

  // ============================================================
  // ACTION 2: PROCESS TASK
  // ============================================================

  if (action === 'processTask') {

    let claimedTask = null;

    const workerId =
      `worker-${randomUUID().slice(0, 8)}`;

    try {

      const db =
        getDb();

      if (!db) {

        throw new Error(
          'getDb() returned null or undefined.'
        );

      }

      // ======================================================
      // ATOMIC TASK CLAIM
      // ======================================================

      const claimResult =
        await db.execute({

          sql: `
            UPDATE generation_tasks
            SET
              status = 'in_progress',
              locked_at = CURRENT_TIMESTAMP,
              locked_by = ?,
              attempt_count = COALESCE(attempt_count, 0) + 1,
              next_retry_at = NULL
            WHERE
              (
                status = 'pending'
                OR (
                  status = 'in_progress'
                  AND locked_at < datetime(
                    'now',
                    '-' || ? || ' seconds'
                  )
                )
              )
              AND (
                COALESCE(attempt_count, 0)
                < ?
              )
              AND (
                next_retry_at IS NULL
                OR next_retry_at <= CURRENT_TIMESTAMP
              )
            ORDER BY created_at ASC
            LIMIT 1
            RETURNING *
          `,

          args: [
            workerId,
            String(TASK_LEASE_TIMEOUT_SECONDS),
            String(MAX_RETRY_ATTEMPTS)
          ]

        });

      const task =
        claimResult?.rows?.[0];

      // ------------------------------------------------------
      // No task
      // ------------------------------------------------------

      if (!task) {

        log(
          'info',
          'No pending task available'
        );

        return res.status(200).json({

          status: 'SUCCESS',

          message:
            'No pending tasks available.',

          requestId

        });

      }

      claimedTask =
        task;

      const attemptsUsed =
        Number(task.attempt_count || 0);

      log(
        'info',
        'Task claimed',
        {
          taskId: task.id,
          workerId,
          attempt: attemptsUsed
        }
      );

      // ======================================================
      // PARSE RAW MCQs
      // ======================================================

      let rawMCQs = [];

      const mcqData =
        task.raw_mcqs ||
        task.payload ||
        task.raw_data;

      if (mcqData) {

        try {

          rawMCQs =
            typeof mcqData === 'string'
              ? JSON.parse(mcqData)
              : mcqData;

          if (
            !Array.isArray(rawMCQs) &&
            typeof rawMCQs === 'object'
          ) {

            rawMCQs =
              rawMCQs.mcqs ||
              rawMCQs.questions ||
              [rawMCQs];

          }

        } catch (err) {

          log(
            'warn',
            'Failed to parse raw MCQs',
            {
              taskId: task.id,
              error: err?.message
            }
          );

        }

      }

      // ======================================================
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

        } catch (err) {

          log(
            'warn',
            'Evidence retrieval failed',
            {
              taskId: task.id,
              error: err?.message
            }
          );

        }

      }

      // ======================================================
      // GENERATE + STORE MCQs
      // ======================================================

      const result =
        await generateAndStoreMCQs({

          subject:
            task.subject,

          chapter:
            task.chapter,

          rawMCQsInput:
            rawMCQs,

          evidenceText:
            evidenceText

        });

      // ======================================================
      // RESULT
      // ======================================================

      const success =
        result?.success === true;

      const canRetry =
        attemptsUsed < MAX_RETRY_ATTEMPTS;

      let newStatus;

      let finalError =
        null;

      const now =
        new Date().toISOString();

      // ------------------------------------------------------
      // SUCCESS
      // ------------------------------------------------------

      if (success) {

        newStatus =
          'completed';

      }

      // ------------------------------------------------------
      // RETRY
      // ------------------------------------------------------

      else if (canRetry) {

        newStatus =
          'pending';

        const delay =
          RETRY_DELAY_SECONDS *
          Math.pow(
            2,
            Math.max(0, attemptsUsed - 1)
          );

        await db.execute({

          sql: `
            UPDATE generation_tasks
            SET
              next_retry_at =
                datetime(
                  'now',
                  '+' || ? || ' seconds'
                )
            WHERE id = ?
              AND locked_by = ?
              AND status = 'in_progress'
          `,

          args: [
            String(delay),
            task.id,
            workerId
          ]

        });

      }

      // ------------------------------------------------------
      // PERMANENT FAILURE
      // ------------------------------------------------------

      else {

        newStatus =
          'failed';

        finalError =
          result?.error ||
          'Maximum retry attempts exceeded.';

      }

      // ======================================================
      // FINAL TASK UPDATE
      // ======================================================

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
              last_error = ?
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

            (!success && !canRetry)
              ? now
              : null,

            finalError,

            task.id,

            workerId

          ]

        });

      // ======================================================
      // OWNERSHIP CHECK
      // ======================================================

      if (
        !updateResult?.rows ||
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

          taskId:
            task.id,

          requestId

        });

      }

      // ======================================================
      // SUMMARY
      // ======================================================

      const summary = {

        generated:
          result?.count || 0,

        inserted:
          result?.count || 0,

        rejected:
          result?.rejectedTotal || 0,

        duplicates:
          result?.duplicates || 0

      };

      log(
        'info',
        'Task processed successfully',
        {
          taskId: task.id,
          status: newStatus
        }
      );

      return res.status(200).json({

        status:
          'SUCCESS',

        taskId:
          task.id,

        taskStatus:
          newStatus,

        message:
          success
            ? 'Task completed successfully.'
            : (
                canRetry
                  ? 'Task failed and will be retried.'
                  : 'Task failed permanently.'
              ),

        summary,

        requestId

      });

    } catch (err) {

      // ======================================================
      // 🔥 EXACT PROCESS TASK ERROR
      // ======================================================

      const errorName =
        err?.name || 'UnknownError';

      const errorMessage =
        err?.message ||
        'Unknown task processing error';

      const errorCode =
        err?.code ||
        err?.cause?.code ||
        null;

      const causeMessage =
        err?.cause?.message ||
        null;

      console.error(
        '===================================================='
      );

      console.error(
        'TASK PROCESSING ERROR'
      );

      console.error(
        'Request ID:',
        requestId
      );

      console.error(
        'Task ID:',
        claimedTask?.id || null
      );

      console.error(
        'Error Name:',
        errorName
      );

      console.error(
        'Error Message:',
        errorMessage
      );

      console.error(
        'Error Code:',
        errorCode
      );

      console.error(
        'Cause:',
        causeMessage
      );

      console.error(
        'Stack:',
        err?.stack
      );

      console.error(
        '===================================================='
      );

      // ======================================================
      // TRY TASK RECOVERY
      // ======================================================

      if (claimedTask) {

        try {

          const db =
            getDb();

          const attemptsUsed =
            Number(
              claimedTask.attempt_count || 0
            );

          const canRetry =
            attemptsUsed < MAX_RETRY_ATTEMPTS;

          const newStatus =
            canRetry
              ? 'pending'
              : 'failed';

          const now =
            new Date().toISOString();

          if (canRetry) {

            const delay =
              RETRY_DELAY_SECONDS *
              Math.pow(
                2,
                Math.max(0, attemptsUsed - 1)
              );

            await db.execute({

              sql: `
                UPDATE generation_tasks
                SET
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
                String(delay),
                claimedTask.id,
                workerId
              ]

            });

          }

          await db.execute({

            sql: `
              UPDATE generation_tasks
              SET
                status = ?,
                locked_at = NULL,
                locked_by = NULL,
                failed_at = ?,
                last_error = ?
              WHERE
                id = ?
                AND locked_by = ?
                AND status = 'in_progress'
            `,

            args: [

              newStatus,

              (!canRetry)
                ? now
                : null,

              errorMessage,

              claimedTask.id,

              workerId

            ]

          });

        } catch (recoveryError) {

          console.error(
            'Task recovery failed:',
            recoveryError?.message
          );

        }

      }

      // ======================================================
      // 🔥 DIRECT ERROR TO REQBin
      // ======================================================

      return res.status(500).json({

        status:
          'ERROR',

        error:
          'TASK_PROCESSING_ERROR',

        message:
          errorMessage,

        diagnostics: {

          errorName:
            errorName,

          errorCode:
            errorCode,

          cause:
            causeMessage,

          taskId:
            claimedTask?.id || null,

          workerId:
            workerId,

          hint:
            'Exact server-side error is returned above. No database credentials are exposed.'

        },

        requestId

      });

    }

  }

  // ============================================================
  // INVALID ACTION
  // ============================================================

  return res.status(400).json({

    status:
      'ERROR',

    error:
      'INVALID_ACTION',

    message:
      'Action must be "query" or "processTask".',

    requestId

  });

}
