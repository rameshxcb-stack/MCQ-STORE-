import { db } from '../lib/db.js';
import { verifySessionToken, hashIP } from '../lib/crypto.js';
import { notifyTelegram } from '../lib/notify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { token, userId, chapter, answers } = req.body;
  if (!token || !userId || !chapter || !Array.isArray(answers)) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  const tokenData = verifySessionToken(token);
  if (!tokenData || tokenData.userId !== userId) {
    return res.status(403).json({ error: 'Invalid token' });
  }

  try {
    const sessionRows = await db.execute({
      sql: 'SELECT submitted, expires_at FROM sessions WHERE session_id = ?',
      args: [tokenData.nonce]
    });
    if (sessionRows.rows.length === 0 || sessionRows.rows[0].expires_at < Date.now()) {
      return res.status(403).json({ error: 'Session expired' });
    }
    if (sessionRows.rows[0].submitted === 1) {
      return res.status(409).json({ error: 'Already submitted' });
    }

    await db.execute({ sql: 'UPDATE sessions SET submitted = 1 WHERE session_id = ?', args: [tokenData.nonce] });

    const updateStatements = [];
    const insertStatements = [];

    for (const ans of answers) {
      const { qid, selected } = ans;
      const qRows = await db.execute({ sql: 'SELECT answer FROM mcqs WHERE id = ?', args: [qid] });
      if (qRows.rows.length === 0) continue;
      const isCorrect = selected === qRows.rows[0].answer ? 1 : 0;

      updateStatements.push({
        sql: `UPDATE mcqs SET attempt_count = attempt_count + 1, correct_count = correct_count + ?, wrong_count = wrong_count + ? WHERE id = ?`,
        args: [isCorrect, isCorrect ? 0 : 1, qid]
      });
      insertStatements.push({
        sql: `INSERT INTO results (user_id, chapter, qid, selected, correct, created_at) VALUES (?,?,?,?,?,?)`,
        args: [userId, chapter, qid, selected, isCorrect, Date.now()]
      });
    }

    if (updateStatements.length > 0) await db.batch(updateStatements);
    if (insertStatements.length > 0) await db.batch(insertStatements);

    res.json({ success: true, message: 'Answers recorded' });
  } catch (e) {
    await notifyTelegram(`Submit-test error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}
