import { db } from '../../lib/db.js';
import { notifyTelegram } from '../../lib/notify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const now = Date.now();
  try {
    await db.execute({ sql: 'DELETE FROM audit_log WHERE timestamp < ?', args: [now - 30*24*60*60*1000] });
    await db.execute({ sql: 'DELETE FROM sessions WHERE expires_at < ?', args: [now - 24*60*60*1000] });
    await db.execute({ sql: 'DELETE FROM results WHERE created_at < ?', args: [now - 30*24*60*60*1000] });
    await db.execute({ sql: 'DELETE FROM rate_limits WHERE window_start < ?', args: [now - 60*60*1000] });
    await db.execute({ sql: 'DELETE FROM source_cache WHERE fetched_at < ?', args: [now - 30*24*60*60*1000] });
    await db.execute({ sql: 'DELETE FROM admin_nonces WHERE used_at < ?', args: [now - 60*60*1000] });

    res.json({ success: true, message: 'Cleanup completed' });
  } catch (e) {
    await notifyTelegram(`Cleanup error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}
