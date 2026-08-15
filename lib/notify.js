import { db } from './db.js';

export async function notifyTelegram(message, eventId = null) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  if (eventId) {
    const existing = await db.execute({
      sql: 'SELECT 1 FROM telegram_log WHERE id = ? AND sent_at > ?',
      args: [eventId, Date.now() - 5 * 60 * 1000]
    });
    if (existing.rows.length > 0) return;
  }

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message })
    });
    if (eventId) {
      await db.execute({
        sql: 'INSERT OR IGNORE INTO telegram_log (id, event, sent_at) VALUES (?,?,?)',
        args: [eventId, message, Date.now()]
      });
    }
  } catch (e) {
    console.error('Telegram notify fail:', e);
  }
}
