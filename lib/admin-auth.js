import { createHmac, timingSafeEqual } from 'crypto';
import { db } from './db.js';

const ADMIN_SECRET = process.env.ADMIN_HMAC_SECRET || process.env.JWT_SECRET;
const MAX_AGE_MS = 5 * 60 * 1000;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    Object.keys(value).sort().forEach(key => sorted[key] = canonicalize(value[key]));
    return sorted;
  }
  return value;
}

export async function verifyAdminHMAC(req) {
  const timestamp = parseInt(req.headers['x-timestamp'] || '0');
  const nonce = req.headers['x-nonce'] || '';
  const signature = req.headers['x-signature'] || '';
  if (!timestamp || !nonce || !signature) return false;
  if (!/^[a-zA-Z0-9]{16,64}$/.test(nonce)) return false;

  if (Date.now() - timestamp > MAX_AGE_MS || Date.now() - timestamp < 0) return false;

  const insertResult = await db.execute({
    sql: 'INSERT OR IGNORE INTO admin_nonces (nonce, used_at) VALUES (?, ?)',
    args: [nonce, Date.now()]
  });
  if (insertResult.rowsAffected === 0) return false;

  const bodyText = JSON.stringify(canonicalize(req.body || {}));
  const data = `${timestamp}:${nonce}:${bodyText}`;
  const expected = createHmac('sha256', ADMIN_SECRET).update(data).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
