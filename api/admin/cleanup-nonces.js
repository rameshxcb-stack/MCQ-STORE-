import { db } from '../../lib/db.js';
import { notifyTelegram } from '../../lib/notify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    await db.execute({
      sql: 'DELETE FROM admin_nonces WHERE used_at < ?',
      args: [Date.now() - 60*60*1000]
    });
    res.json({ success: true });
  } catch (e) {
    await notifyTelegram(`Nonce cleanup error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}
