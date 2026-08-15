import { createSessionToken, hashIP } from '../lib/crypto.js';
import { db } from '../lib/db.js';
import { notifyTelegram } from '../lib/notify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ipHash = await hashIP(rawIp);

  try {
    const now = Date.now();
    const windowStart = now - 60_000;
    const rows = await db.execute({ sql: 'SELECT count, window_start FROM rate_limits WHERE ip_hash = ?', args: [ipHash] });

    if (rows.rows.length === 0) {
      await db.execute({ sql: 'INSERT INTO rate_limits (ip_hash, count, window_start) VALUES (?, 1, ?)', args: [ipHash, now] });
    } else {
      const { count, window_start } = rows.rows[0];
      if (window_start < windowStart) {
        await db.execute({ sql: 'UPDATE rate_limits SET count = 1, window_start = ? WHERE ip_hash = ?', args: [now, ipHash] });
      } else {
        if (count >= 5) return res.status(429).json({ error: 'Too many token requests' });
        await db.execute({ sql: 'UPDATE rate_limits SET count = count + 1 WHERE ip_hash = ?', args: [ipHash] });
      }
    }

    let userId = req.body?.userId;
    if (!userId) userId = 'anon_' + Math.random().toString(36).slice(2, 8);
    const token = createSessionToken(userId);
    const decoded = Buffer.from(token, 'base64').toString();
    const sessionId = decoded.split(':')[2];
    const expiresAt = Date.now() + 30 * 60 * 1000;

    await db.execute({
      sql: 'INSERT INTO sessions (session_id, user_id, nonce, submitted, expires_at) VALUES (?,?,?,0,?)',
      args: [sessionId, userId, sessionId, expiresAt]
    });

    res.json({ token, userId });
  } catch (e) {
    await notifyTelegram(`Session token error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}
