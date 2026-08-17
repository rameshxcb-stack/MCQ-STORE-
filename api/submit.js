export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
  try {
    const { userId, token, chapter, answers } = req.body;
    // यहाँ आपका सबमिट और Session Verify का लॉजिक आएगा।
    // क्योंकि हमने डेटाबेस क्लियर किया है, फिलहाल बस Success भेज दो।
    console.log(`Submit received: User ${userId}, Chapter ${chapter}`);
    return res.status(200).json({ success: true, message: 'Answers recorded (test mode)' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
