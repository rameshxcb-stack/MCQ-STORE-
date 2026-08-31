// api/admin/generate.js - ✅ Includes hardcoded_test action

import { generateAndStoreMCQs, retrieveEvidence, getDb, getDbDiagnostics, safeDbError } from '../../lib/mcq-generator.js';
import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const MAX_RETRY_ATTEMPTS = 3;
const TASK_LEASE_TIMEOUT_SECONDS = 120;
const RETRY_DELAY_SECONDS = 30;

// ============================================================
// QUERY REGISTRY
// ============================================================
const QUERY_REGISTRY = {
  check_connection: {
    sql: 'SELECT 1 AS is_active;',
    args: []
  },
  get_mcqs_by_chapter: {
    sql: `
      SELECT id, subject, chapter, difficulty, question, option_a, option_b, option_c, option_d, answer, explanation
      FROM mcqs
      WHERE subject = ? AND chapter = ?
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
  if (!error) return 'Unknown error';
  return String(error?.message || error).replace(/\s+/g, ' ').slice(0, 1000);
}

function parseTaskMCQs(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.mcqs)) return parsed.mcqs;
      if (Array.isArray(parsed.questions)) return parsed.questions;
      return [parsed];
    }
    return [];
  } catch {
    return [];
  }
}

function getRetryDelaySeconds(attemptNumber) {
  return RETRY_DELAY_SECONDS * Math.pow(2, Math.max(0, attemptNumber - 1));
}

function getAdminKey(req) {
  const headerKey = req.headers['x-admin-key'];
  if (headerKey) return String(headerKey);
  const auth = req.headers['authorization'];
  return auth ? auth.replace(/^Bearer\s+/i, '') : null;
}

// ============================================================
// MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
  const requestId = randomUUID().slice(0, 8);
  const startedAt = Date.now();

  const log = (level, message, meta = {}) => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      level,
      message,
      durationMs: Date.now() - startedAt,
      ...meta
    }));
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'ERROR', error: 'METHOD_NOT_ALLOWED', message: 'Only POST allowed.', requestId });
  }

  // Parse body
  let bodyData = {};
  try {
    bodyData = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (error) {
    log('error', 'Invalid JSON', { error: safeErrorMessage(error) });
    return res.status(400).json({ status: 'ERROR', error: 'INVALID_JSON', message: 'Invalid JSON.', requestId });
  }

  const { action, queryType, args = [] } = bodyData;

  // Admin auth (except for hardcoded_test – we'll skip admin key for this test)
  if (action !== 'hardcoded_test') {
    const reqAdminKey = getAdminKey(req);
    if (!ADMIN_KEY || !reqAdminKey || reqAdminKey !== ADMIN_KEY) {
      log('warn', 'Unauthorized request', { action });
      return res.status(403).json({ status: 'ERROR', error: 'UNAUTHORIZED', message: 'Valid x-admin-key required.', requestId });
    }
  }

  // ============================================================
  // 🧪 ACTION: hardcoded_test (Diagnostic – SKIPS ADMIN AUTH)
  // ============================================================
  if (action === 'hardcoded_test') {
    // 🔥 Insert YOUR working URL and token here
    const HARDCODED_URL = 'libsql://mcq-rameshxcb-stack.aws-ap-south-1.turso.io';
    const HARDCODED_TOKEN = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3ODc5NzU1ODAsImlkIjoiMDFhMDA5NTgtMWQwMS03YzQ4LWI2ZDktMmI4OGQwMDgyNTY1Iiwia2lkIjoiQ185cDN0WVAzRW1yb2xaa2hvUGlMWDNaeHVxSWxROUU4dGJLQXp5a1lEdyIsInJpZCI6ImY0M2VhNzc1LTNkMjYtNDZhMi05NmY4LThlNzRiM2NlNDJlZiJ9.8cGh7_MyO9SePYKJvjm0wrz56yGRwfuXHeOoslaAO9o-TbkSfoO456tYCL1Bz2MBqQM4jLRkG-wJJPvc3yk9BA';

    try {
      const db = createClient({ url: HARDCODED_URL, authToken: HARDCODED_TOKEN });
      const result = await db.execute('SELECT 1 AS is_active');

      return res.status(200).json({
        status: 'SUCCESS',
        message: 'Hardcoded Turso credentials accepted.',
        connected: true,
        test: 'SELECT 1',
        rows: result.rows || [],
        requestId
      });
    } catch (error) {
      return res.status(401).json({
        status: 'ERROR',
        message: 'Hardcoded Turso credentials were rejected.',
        connected: false,
        errorName: error?.name || 'UnknownError',
        errorCode: error?.code || null,
        errorMessage: String(error?.message || error).slice(0, 500),
        requestId
      });
    }
  }

  // ============================================================
  // ACTION: query
  // ============================================================
  if (action === 'query') {
    // ... (your existing query logic – unchanged)
    if (!queryType) {
      return res.status(400).json({ status: 'ERROR', error: 'MISSING_QUERY_TYPE', message: 'queryType required.', requestId });
    }
    const queryConfig = QUERY_REGISTRY[queryType];
    if (!queryConfig) {
      return res.status(400).json({ status: 'ERROR', error: 'INVALID_QUERY', message: `Query type "${queryType}" not allowed.`, requestId });
    }
    if (!Array.isArray(args) || args.length !== queryConfig.args.length) {
      return res.status(400).json({ status: 'ERROR', error: 'INVALID_ARGS', message: `Expected ${queryConfig.args.length} args.`, requestId });
    }
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] !== 'string' || args[i].trim() === '') {
        return res.status(400).json({ status: 'ERROR', error: 'INVALID_ARG', message: `Argument ${i+1} must be non-empty string.`, requestId });
      }
    }

    try {
      const db = getDb();
      const result = await db.execute({ sql: queryConfig.sql, args });
      const rows = result.rows || [];
      log('info', 'Query successful', { queryType, rowCount: rows.length });
      return res.status(200).json({
        status: 'SUCCESS',
        connected: true,
        message: 'Database connected successfully.',
        data: rows,
        diagnostics: { queryType, rowCount: rows.length },
        requestId
      });
    } catch (error) {
      const dbError = safeDbError(error);
      const diagnostics = getDbDiagnostics();
      log('error', 'Query failed', { queryType, error: dbError.message, diagnostics });
      return res.status(500).json({
        status: 'ERROR',
        error: 'DATABASE_ERROR',
        connected: false,
        message: 'Database query failed.',
        diagnostics: {
          errorName: dbError.name,
          errorCode: dbError.code,
          cause: dbError.message,
          databaseConfig: {
            urlConfigured: diagnostics.urlConfigured,
            tokenConfigured: diagnostics.tokenConfigured,
            urlProtocol: diagnostics.urlProtocol || null,
            urlHost: diagnostics.urlHost || null,
            tokenLength: diagnostics.tokenLength || null
          },
          hint: '401 means the Turso server rejected authentication. No database token is exposed.'
        },
        requestId
      });
    }
  }

  // ============================================================
  // ACTION: processTask
  // ============================================================
  if (action === 'processTask') {
    // ... (your existing processTask logic – unchanged) ...
    const workerId = `worker-${randomUUID().slice(0,8)}`;
    let claimedTask = null;

    try {
      const db = getDb();

      // Recover max attempts
      await db.execute({
        sql: `
          UPDATE generation_tasks
          SET status = 'failed', locked_at = NULL, locked_by = NULL, failed_at = CURRENT_TIMESTAMP,
              last_error = 'Maximum retry attempts exceeded.', next_retry_at = NULL
          WHERE (status = 'pending' OR status = 'in_progress')
            AND COALESCE(attempt_count, 0) >= ?
            AND (status = 'pending' OR locked_at IS NULL OR locked_at < datetime('now', '-' || ? || ' seconds'))
        `,
        args: [MAX_RETRY_ATTEMPTS, String(TASK_LEASE_TIMEOUT_SECONDS)]
      });

      // Atomic claim
      const claimResult = await db.execute({
        sql: `
          UPDATE generation_tasks
          SET status = 'in_progress', locked_at = CURRENT_TIMESTAMP, locked_by = ?,
              attempt_count = COALESCE(attempt_count, 0) + 1, next_retry_at = NULL
          WHERE id = (
            SELECT id FROM generation_tasks
            WHERE (
              (status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= CURRENT_TIMESTAMP))
              OR (status = 'in_progress' AND locked_at IS NOT NULL
                  AND locked_at < datetime('now', '-' || ? || ' seconds'))
            )
            AND COALESCE(attempt_count, 0) < ?
            ORDER BY created_at ASC, id ASC
            LIMIT 1
          )
          RETURNING *
        `,
        args: [workerId, String(TASK_LEASE_TIMEOUT_SECONDS), MAX_RETRY_ATTEMPTS]
      });

      const task = claimResult.rows?.[0] || null;
      if (!task) {
        log('info', 'No task available');
        return res.status(200).json({ status: 'SUCCESS', taskStatus: 'idle', message: 'No pending tasks available.', requestId });
      }

      claimedTask = task;
      const attemptsUsed = Number(task.attempt_count || 0);
      log('info', 'Task claimed', { taskId: task.id, attempt: attemptsUsed, workerId });

      // Parse MCQs, get evidence, generate
      const rawMCQs = parseTaskMCQs(task.raw_mcqs || task.payload || task.raw_data);
      let evidenceText = task.evidence || '';
      if (!evidenceText && task.subject && task.chapter) {
        try {
          evidenceText = await retrieveEvidence(task.subject, task.chapter);
        } catch (error) {
          log('warn', 'Evidence retrieval failed', { taskId: task.id, error: safeErrorMessage(error) });
        }
      }

      const result = await generateAndStoreMCQs({
        subject: task.subject,
        chapter: task.chapter,
        rawMCQsInput: rawMCQs,
        evidenceText
      });

      const success = result?.success === true;
      const canRetry = !success && attemptsUsed < MAX_RETRY_ATTEMPTS;
      const finalError = success ? null : (result?.error || 'MCQ generation failed.');
      const now = new Date().toISOString();

      if (canRetry) {
        const delaySeconds = getRetryDelaySeconds(attemptsUsed);
        await db.execute({
          sql: `
            UPDATE generation_tasks
            SET status = 'pending', locked_at = NULL, locked_by = NULL,
                completed_at = NULL, failed_at = NULL, last_error = ?,
                next_retry_at = datetime('now', '+' || ? || ' seconds')
            WHERE id = ? AND locked_by = ? AND status = 'in_progress'
          `,
          args: [finalError, String(delaySeconds), task.id, workerId]
        });
        log('warn', 'Task scheduled for retry', { taskId: task.id, attempt: attemptsUsed, retryAfter: delaySeconds });
        return res.status(200).json({
          status: 'SUCCESS',
          taskId: task.id,
          taskStatus: 'pending',
          message: 'Task failed, will retry later.',
          summary: { generated: 0, inserted: 0, rejected: result?.rejectedTotal || 0 },
          requestId
        });
      }

      const newStatus = success ? 'completed' : 'failed';
      const updateResult = await db.execute({
        sql: `
          UPDATE generation_tasks
          SET status = ?, locked_at = NULL, locked_by = NULL,
              completed_at = ?, failed_at = ?, last_error = ?, next_retry_at = NULL
          WHERE id = ? AND locked_by = ? AND status = 'in_progress'
          RETURNING id
        `,
        args: [newStatus, success ? now : null, !success ? now : null, finalError, task.id, workerId]
      });

      if (!updateResult.rows || updateResult.rows.length === 0) {
        log('warn', 'Task ownership lost', { taskId: task.id });
        return res.status(409).json({ status: 'ERROR', error: 'TASK_OWNERSHIP_LOST', message: 'Task reclaimed by another worker.', requestId });
      }

      log('info', 'Task finalized', { taskId: task.id, status: newStatus });
      return res.status(200).json({
        status: 'SUCCESS',
        taskId: task.id,
        taskStatus: newStatus,
        message: success ? 'Task completed successfully.' : 'Task failed permanently.',
        summary: {
          generated: result?.count || 0,
          inserted: result?.count || 0,
          rejected: result?.rejectedTotal || 0,
          duplicates: result?.duplicates || 0
        },
        requestId
      });

    } catch (error) {
      const dbError = safeDbError(error);
      const errorMessage = dbError.message;
      log('error', 'Task processing exception', { taskId: claimedTask?.id || null, workerId, error: errorMessage });

      if (claimedTask?.id) {
        try {
          const db = getDb();
          const attemptsUsed = Number(claimedTask.attempt_count || 0);
          const canRetry = attemptsUsed < MAX_RETRY_ATTEMPTS;
          if (canRetry) {
            const delay = getRetryDelaySeconds(attemptsUsed);
            await db.execute({
              sql: `
                UPDATE generation_tasks
                SET status = 'pending', locked_at = NULL, locked_by = NULL, failed_at = NULL,
                    last_error = ?, next_retry_at = datetime('now', '+' || ? || ' seconds')
                WHERE id = ? AND locked_by = ? AND status = 'in_progress'
              `,
              args: [errorMessage, String(delay), claimedTask.id, workerId]
            });
          } else {
            await db.execute({
              sql: `
                UPDATE generation_tasks
                SET status = 'failed', locked_at = NULL, locked_by = NULL,
                    failed_at = CURRENT_TIMESTAMP, last_error = ?, next_retry_at = NULL
                WHERE id = ? AND locked_by = ? AND status = 'in_progress'
              `,
              args: [errorMessage, claimedTask.id, workerId]
            });
          }
        } catch (recoveryError) {
          log('error', 'Recovery failed', { taskId: claimedTask.id, error: safeErrorMessage(recoveryError) });
        }
      }

      const diagnostics = getDbDiagnostics();
      return res.status(500).json({
        status: 'ERROR',
        error: 'TASK_PROCESSING_ERROR',
        message: errorMessage,
        diagnostics: {
          errorName: dbError.name,
          errorCode: dbError.code,
          cause: errorMessage,
          taskId: claimedTask?.id || null,
          workerId,
          databaseConfig: {
            urlConfigured: diagnostics.urlConfigured,
            tokenConfigured: diagnostics.tokenConfigured,
            urlProtocol: diagnostics.urlProtocol || null,
            urlHost: diagnostics.urlHost || null,
            tokenLength: diagnostics.tokenLength || null
          },
          hint: dbError.code === 'SERVER_ERROR' && errorMessage.includes('401')
            ? 'Turso rejected the authentication request. Verify your credentials.'
            : 'Exact non-secret error is returned above.'
        },
        requestId
      });
    }
  }

  // Invalid action
  return res.status(400).json({
    status: 'ERROR',
    error: 'INVALID_ACTION',
    message: 'Action must be "query", "processTask", or "hardcoded_test".',
    requestId
  });
}
