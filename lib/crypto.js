import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET;

export function hmac(secret, data) {
  return createHmac('sha256', secret).update(data).digest('base64');
}

export function generateNonce() {
  return randomBytes(12).toString('hex');
}

export function createSessionToken(userId) {
  const timestamp = Date.now();
  const nonce = generateNonce();
  const data = `${userId}:${timestamp}:${nonce}`;
  const sig = hmac(JWT_SECRET, data);
  return Buffer.from(`${data}:${sig}`).toString('base64');
}

export function verifySessionToken(token, maxAgeMs = 30 * 60 * 1000) {
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    const parts = decoded.split(':');
    if (parts.length !== 4) return null;
    const [userId, tsStr, nonce, sig] = parts;
    const timestamp = parseInt(tsStr);
    if (Date.now() - timestamp > maxAgeMs) return null;
    const data = `${userId}:${timestamp}:${nonce}`;
    const expectedSig = hmac(JWT_SECRET, data);
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    return { userId, nonce };
  } catch {
    return null;
  }
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export async function hashIP(ip) {
  return hmac(JWT_SECRET, ip);
}
