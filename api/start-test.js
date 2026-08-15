import { db } from '../lib/db.js';
import { verifySessionToken, hashIP } from '../lib/crypto.js';
import { notifyTelegram } from '../lib/notify.js';

const ENCRYPTION_KEY = process.env.BUNDLE_ENCRYPTION_KEY;
const CDN_BASE = `https://cdn.jsdelivr.net/gh/${process.env.GITHUB_USERNAME}/${process.env.GITHUB_REPO}@main/bundles`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { chapter, token } = req.body;
  if (!chapter || !token) return res.status(400).json({ error: 'chapter and token required' });

  const tokenData = verifySessionToken(token);
  if (!tokenData) return res.status(403).json({ error: 'Invalid token' });

  const rawIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const ipHash = await hashIP(rawIp);

  try {
    // Rate limit (30/min per IP)
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
        if (count >= 30) return res.status(429).json({ error: 'Rate limit exceeded' });
        await db.execute({ sql: 'UPDATE rate_limits SET count = count + 1 WHERE ip_hash = ?', args: [ipHash] });
      }
    }

    // Get random bundle for this chapter
    const bundleRes = await db.execute({
      sql: `SELECT bundle_name FROM bundles WHERE chapter = ? ORDER BY RANDOM() LIMIT 1`,
      args: [chapter],
    });
    if (bundleRes.rows.length === 0) return res.status(404).json({ error: 'No bundle found' });

    const bundleName = bundleRes.rows[0].bundle_name;

    res.json({
      bundleUrl: `${CDN_BASE}/${bundleName}`,
      decryptionKey: ENCRYPTION_KEY,
      token,
    });
  } catch (e) {
    await notifyTelegram(`Start-test error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}
