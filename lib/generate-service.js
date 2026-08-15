import { db } from './db.js';
import { generateAndStoreMCQs } from './generator.js';

export async function runGenerationTask() {
  const claim = await db.execute({
    sql: `UPDATE generation_tasks
          SET status = 'in_progress', updated_at = ?
          WHERE id = (
            SELECT id FROM generation_tasks
            WHERE status = 'pending' AND generated_count < target_count
            ORDER BY created_at ASC LIMIT 1
          )
          AND status = 'pending'
          RETURNING *`,
    args: [Date.now()]
  });

  if (claim.rows.length === 0) return { message: 'No pending tasks' };

  const task = claim.rows[0];
  try {
    const inserted = await generateAndStoreMCQs(task);
    const newCount = task.generated_count + inserted;
    const newStatus = newCount >= task.target_count ? 'completed' : 'pending';
    await db.execute({
      sql: "UPDATE generation_tasks SET generated_count = ?, status = ?, updated_at = ? WHERE id = ?",
      args: [newCount, newStatus, Date.now(), task.id]
    });
    return { success: true, task_id: task.id, inserted };
  } catch (e) {
    await db.execute({
      sql: "UPDATE generation_tasks SET status = 'pending', retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?",
      args: [e.message, Date.now(), task.id]
    });
    throw e;
  }
      }
