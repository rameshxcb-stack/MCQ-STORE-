import { createClient } from '@libsql/client';

const ADMIN_KEY = process.env.ADMIN_API_KEY;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export default async function handler(req, res) {
  // ✅ CORS Headers को बिल्कुल शुरुआत में सेट करो
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  // OPTIONS (Preflight) request को हैंडल करो
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // बाकी का कोड वैसा ही रहेगा
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // यहाँ आपका Generate Logic
    return res.status(200).json({ 
      success: true, 
      message: 'Admin generate triggered successfully!' 
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
