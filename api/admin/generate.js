import { createClient } from '@libsql/client';

const ADMIN_KEY = process.env.ADMIN_API_KEY;

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(403).json({ error: 'Unauthorized' });

  try {
    // 1. Database से पेंडिंग टास्क ढूंढो
    const { rows: tasks } = await db.execute({
      sql: `SELECT * FROM generation_tasks WHERE status = 'pending' AND generated_count < target_count ORDER BY created_at ASC LIMIT 1`,
      args: []
    });

    if (tasks.length === 0) {
      return res.status(200).json({ message: 'No pending tasks available' });
    }

    const task = tasks[0];
    console.log(`🚀 Processing task: ${task.subject} - ${task.chapter}`);

    // 2. टास्क को लॉक करो (in_progress)
    await db.execute({
      sql: `UPDATE generation_tasks SET status = 'in_progress', updated_at = ? WHERE id = ?`,
      args: [Date.now(), task.id]
    });

    // 3. असली MCQ Generation कॉल करो (अगर `mcq-generator.js` मौजूद है)
    // ⚠️ यहाँ हमें यह मानकर चल रहे हैं कि आपने `lib/mcq-generator.js` बना लिया है
    // जो `generateAndStoreMCQs(subject, chapter, batchSize)` export करता है
    const { generateAndStoreMCQs } = await import('../../lib/mcq-generator.js');
    const batchSize = Math.min(100, task.target_count - task.generated_count);
    
    let generated = 0;
    try {
      generated = await generateAndStoreMCQs(task.subject, task.chapter, batchSize);
    } catch (genErr) {
      // अगर Generate में एरर आया, तो टास्क को वापस pending करो
      await db.execute({
        sql: `UPDATE generation_tasks SET status = 'pending', retry_count = retry_count + 1, last_error = ?, updated_at = ? WHERE id = ?`,
        args: [genErr.message, Date.now(), task.id]
      });
      throw genErr;
    }

    // 4. टास्क अपडेट करो
    const newCount = task.generated_count + generated;
    const newStatus = newCount >= task.target_count ? 'completed' : 'pending';
    
    await db.execute({
      sql: `UPDATE generation_tasks SET generated_count = ?, status = ?, updated_at = ? WHERE id = ?`,
      args: [newCount, newStatus, Date.now(), task.id]
    });

    console.log(`✅ Generated ${generated} MCQs for ${task.subject} - ${task.chapter}`);
    return res.status(200).json({ 
      success: true, 
      message: `Generated ${generated} MCQs for ${task.chapter}` 
    });

  } catch (e) {
    console.error('🔥 Generation Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}
