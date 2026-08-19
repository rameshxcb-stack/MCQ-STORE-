export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { userId, token, chapter, answers } = req.body;
    console.log(`Submission received: User ${userId}, Chapter ${chapter}`);
    return res.status(200).json({ success: true, message: 'Answers recorded (test mode)' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
