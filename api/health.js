// api/health.js
export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Return success JSON
  return res.status(200).json({ 
    status: 'ok', 
    timestamp: Date.now(),
    message: 'Vercel Backend is Live!' 
  });
}
