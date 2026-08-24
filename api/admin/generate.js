// api/admin/generate.js
import { createClient } from '@libsql/client';
import { generateAndStoreMCQs } from '../../lib/mcq-generator.js';

const ADMIN_KEY = process.env.ADMIN_API_KEY;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });

  // 🛡️ Env Variables check (Error aane se rokta hai)
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  const tursoToken = process.env.TURSO_AUTH_TOKEN;
  if (!tursoUrl || !tursoToken) {
    return res.status(500).json({ error: 'Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN environment variable' });
  }

  try {
    // 🛡️ DB client को अंदर बनाओ (Safe - कभी crash नहीं होगा)
    const db = createClient({ url: tursoUrl, authToken: tursoToken });

    const { rows: tasks } = await db.execute({
      sql: `SELECT * FROM generation_tasks WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
    });
    if (tasks.length === 0) return res.status(200).json({ message: 'No pending tasks' });
    const task = tasks[0];
    await db.execute({ sql: `UPDATE generation_tasks SET status = 'in_progress' WHERE id = ?`, args: [task.id] });

    // ✅ सिर्फ इतना भेजो - Generator को सही object मिलेगा
    const result = await generateAndStoreMCQs({
      subject: task.subject,
      chapter: task.chapter,
      rawMCQsInput: [],
      evidenceText: ""
    });

    return res.status(200).json({ success: true, result });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
