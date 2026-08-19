import { randomUUID } from 'crypto';
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId } = req.body;
    const sessionId = randomUUID();
    const token = `mock-jwt-token-${Date.now()}-${sessionId}`;
    return res.status(200).json({ token, userId: userId || `anon_${sessionId.slice(0,8)}` });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
