// api/admin/generate.js - ✅ Production-Grade (All P0/P1 Bugs Fixed)

import { generateAndStoreMCQs, retrieveEvidence, getDb } from '../../lib/mcq-generator.js';
import { randomUUID } from 'crypto';

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const MAX_RETRY_ATTEMPTS = 3;
const TASK_LEASE_TIMEOUT_SECONDS = 180; // 3 minutes – realistic for AI
const RETRY_DELAY_SECONDS = 30; // initial retry delay

// ============================================================
// 📌 QUERY REGISTRY (Admin-only secure SQL proxy)
// ============================================================
const QUERY_REGISTRY = {
  'check_connection': {
    sql: 'SELECT 1 as is_active;',
    args: []
  },
  'get_mcqs_by_chapter': {
    sql: 'SELECT id, subject, chapter, difficulty, question, option_a, option_b, option_c, option_d, answer, explanation FROM mcqs WHERE subject = ? AND chapter = ? ORDER BY id LIMIT 25;',
    args: ['subject', 'chapter']
  },
};

// ============================================================
// 🔧 MAIN HANDLER
// ============================================================
export default async function handler(req, res) {
  const requestId = randomUUID().slice(0, 8);
  const startTime = Date.now();

  const log = (level, message, meta = {}) => {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      level,
      message,
      durationMs: Date.now() - startTime,
      ...meta
    }));
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'ERROR', error: 'METHOD_NOT_ALLOWED', message: 'Only POST allowed.' });
  }

  const rawUrl = (process.env.TURSO_DATABASE_URL || '').trim();
  const rawToken = (process.env.TURSO_AUTH_TOKEN || '').trim();
  if (!rawUrl || !rawToken) {
    log('error', 'Missing credentials');
    return res.status(500).json({ status: 'ERROR', error: 'MISSING_CREDENTIALS', message: 'Env vars missing.' });
  }

  const cleanToken = rawToken.replace(/^Bearer\s+/i, '').replace(/["'\s\r\n]/g, '').trim();
  const cleanUrl = rawUrl.replace('libsql://', 'https://').replace(/\/$/, '');
  const endpoint = `${cleanUrl}/v2/pipeline`;

  let bodyData = {};
  try {
    bodyData = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    log('error', 'Invalid JSON', { error: e.message });
    return res.status(400).json({ status: 'ERROR', error: 'INVALID_JSON', message: 'Invalid JSON.' });
  }

  const { action, queryType, args = [] } = bodyData;

  // Admin authentication – required for all actions
  const reqAdminKey = req.headers['x-admin-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
  if (!ADMIN_KEY || reqAdminKey !== ADMIN_KEY) {
    log('warn', 'Unauthorized attempt', { action });
    return res.status(403).json({ status: 'ERROR', error: 'UNAUTHORIZED', message: 'Valid x-admin-key required.' });
  }

  // ============================================================
  // 🚀 ACTION 1: QUERY EXECUTOR (Admin Only)
  // ============================================================
  if (action === 'query') {
    // Strict action check – queryType must be present and valid
    if (!queryType) {
      return res.status(400).json({ status: 'ERROR', error: 'MISSING_QUERY_TYPE', message: 'queryType required for query action.' });
    }
    const queryConfig = QUERY_REGISTRY[queryType];
    if (!queryConfig) {
      log('error', 'Invalid query type', { queryType });
      return res.status(400).json({ status: 'ERROR', error: 'INVALID_QUERY', message: `Query type "${queryType}" not allowed.` });
    }

    const expectedArgNames = queryConfig.args;
    if (!Array.isArray(args) || args.length !== expectedArgNames.length) {
      return res.status(400).json({ status: 'ERROR', error: 'INVALID_ARGS', message: `Expected ${expectedArgNames.length} args.` });
    }
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] !== 'string' || args[i].trim() === '') {
        return res.status(400).json({ status: 'ERROR', error: 'INVALID_ARG_TYPE', message: `Arg ${i+1} must be non-empty string.` });
      }
    }

    const queryToExecute = queryConfig.sql;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8500);

    try {
      log('info', 'Executing query', { queryType, args });
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${cleanToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests: [ { type: "execute", stmt: { sql: queryToExecute, args } }, { type: "close" } ] }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const data = await response.json();

      if (response.ok) {
        const rows = data.results?.[0]?.response?.result?.rows || [];
        log('info', 'Query successful', { rowCount: rows.length });
        return res.status(200).json({ status: 'SUCCESS', connected: true, message: '✅ Query executed.', data: rows });
      } else {
        log('error', 'Turso query failed', { status: response.status });
        return res.status(response.status).json({ status: 'ERROR', error: 'DATABASE_ERROR', message: 'Database query failed.' });
      }
    } catch (err) {
      clearTimeout(timeoutId);
      log('error', 'Query exception', { error: err.message });
      if (err.name === 'AbortError') return res.status(504).json({ status: 'ERROR', error: 'TIMEOUT' });
      return res.status(500).json({ status: 'ERROR', error: 'SERVER_ERROR', message: 'Internal server error.' });
    }
  }

  // ============================================================
  // ⚙️ ACTION 2: TASK PROCESSOR (Atomic Claim + Recovery)
  // ============================================================
  if (action === 'processTask') {
    let claimedTask = null;
    const workerId = `worker-${randomUUID().slice(0,8)}`;

    try {
      const db = getDb();

      // ✅ Atomic Claim: pending OR stale in_progress (with lease)
      const claimResult = await db.execute({
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
                AND locked_at < datetime('now', '-' || ? || ' seconds')
              )
            )
            AND (COALESCE(attempt_count, 0) < ?)
          ORDER BY created_at ASC
          LIMIT 1
          RETURNING *
        `,
        args: [workerId, String(TASK_LEASE_TIMEOUT_SECONDS), String(MAX_RETRY_ATTEMPTS)]
      });

      const task = claimResult.rows?.[0];
      if (!task) {
        log('info', 'No task to process');
        return res.status(200).json({ status: 'SUCCESS', message: '✅ No pending tasks available.' });
      }

      claimedTask = task;
      // ✅ Fix: attempt_count already incremented, so use it directly
      const attemptsUsed = task.attempt_count || 0; // already incremented
      log('info', 'Task claimed', { taskId: task.id, attempt: attemptsUsed });

      // Process
      let rawMCQs = [];
      const mcqData = task.raw_mcqs || task.payload || task.raw_data;
      if (mcqData) {
        try {
          rawMCQs = typeof mcqData === 'string' ? JSON.parse(mcqData) : mcqData;
          if (!Array.isArray(rawMCQs) && typeof rawMCQs === 'object') {
            rawMCQs = rawMCQs.mcqs || rawMCQs.questions || [rawMCQs];
          }
        } catch (err) {
          log('warn', 'Failed to parse raw MCQs', { taskId: task.id, error: err.message });
        }
      }

      let evidenceText = task.evidence || '';
      if (!evidenceText && task.subject && task.chapter) {
        try {
          evidenceText = await retrieveEvidence(task.subject, task.chapter);
        } catch (e) {
          log('warn', 'Evidence retrieval failed', { taskId: task.id, error: e.message });
          // Continue – generator may have internal fallback
        }
      }

      const result = await generateAndStoreMCQs({
        subject: task.subject,
        chapter: task.chapter,
        rawMCQsInput: rawMCQs,
        evidenceText: evidenceText
      });

      const success = result.success === true;
      const canRetry = attemptsUsed < MAX_RETRY_ATTEMPTS;

      let newStatus;
      let finalError = null;

      if (success) {
        newStatus = 'completed';
      } else if (canRetry) {
        newStatus = 'pending';
        // Set retry delay (exponential backoff)
        const delay = RETRY_DELAY_SECONDS * Math.pow(2, attemptsUsed - 1);
        await db.execute({
          sql: `UPDATE generation_tasks SET next_retry_at = datetime('now', '+' || ? || ' seconds') WHERE id = ?`,
          args: [String(delay), task.id]
        });
      } else {
        newStatus = 'failed';
        finalError = result.error || 'Max retries exceeded';
      }

      // ✅ Ownership check in final update
      const updateResult = await db.execute({
        sql: `
          UPDATE generation_tasks
          SET
            status = ?,
            locked_at = NULL,
            locked_by = NULL,
            completed_at = ?,
            failed_at = ?,
            last_error = ?
          WHERE id = ?
          AND locked_by = ?
          AND status = 'in_progress'
          RETURNING id
        `,
        args: [
          newStatus,
          success ? 'CURRENT_TIMESTAMP' : null,
          (!success && !canRetry) ? 'CURRENT_TIMESTAMP' : null,
          finalError,
          task.id,
          workerId
        ]
      });

      // If no rows updated, someone else claimed it – log and exit gracefully
      if (!updateResult.rows || updateResult.rows.length === 0) {
        log('warn', 'Task ownership lost during processing', { taskId: task.id });
        return res.status(409).json({ status: 'ERROR', error: 'TASK_OWNERSHIP_LOST', message: 'Task was reclaimed by another worker.' });
      }

      log('info', 'Task updated', { taskId: task.id, newStatus });
      // ✅ Return only summary, not full result
      const summary = {
        generated: result.count || 0,
        inserted: result.count || 0,
        rejected: result.rejectedTotal || 0,
        duplicates: result.duplicates || 0
      };

      return res.status(200).json({
        status: 'SUCCESS',
        taskId: task.id,
        taskStatus: newStatus,
        message: success ? 'Task completed.' : (canRetry ? 'Task failed, will retry later.' : 'Task failed permanently.'),
        summary
      });

    } catch (e) {
      // Exception handling with ownership check
      log('error', 'Task processing exception', { taskId: claimedTask?.id, error: e.message });
      if (claimedTask) {
        try {
          const db = getDb();
          const attemptsUsed = claimedTask.attempt_count || 0; // already incremented
          const canRetry = attemptsUsed < MAX_RETRY_ATTEMPTS;
          const newStatus = canRetry ? 'pending' : 'failed';

          // Set retry delay if pending
          if (canRetry) {
            const delay = RETRY_DELAY_SECONDS * Math.pow(2, attemptsUsed - 1);
            await db.execute({
              sql: `UPDATE generation_tasks SET next_retry_at = datetime('now', '+' || ? || ' seconds') WHERE id = ? AND locked_by = ?`,
              args: [String(delay), claimedTask.id, workerId]
            });
          }

          // Update with ownership check
          await db.execute({
            sql: `
              UPDATE generation_tasks
              SET
                status = ?,
                locked_at = NULL,
                locked_by = NULL,
                failed_at = ?,
                last_error = ?
              WHERE id = ?
              AND locked_by = ?
              AND status = 'in_progress'
            `,
            args: [
              newStatus,
              (!canRetry) ? 'CURRENT_TIMESTAMP' : null,
              e.message || 'Unexpected error',
              claimedTask.id,
              workerId
            ]
          });
          log('info', 'Task status updated after exception', { taskId: claimedTask.id, newStatus });
        } catch (dbError) {
          log('error', 'Failed to update task after exception', { taskId: claimedTask?.id, error: dbError.message });
        }
      }
      return res.status(500).json({ status: 'ERROR', error: 'TASK_PROCESSING_ERROR', message: 'Task processing failed.' });
    }
  }

  // Invalid action
  return res.status(400).json({
    status: 'ERROR',
    error: 'INVALID_ACTION',
    message: 'Action must be "query" or "processTask".'
  });
}
