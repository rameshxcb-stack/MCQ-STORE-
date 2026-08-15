import { runGenerationTask } from '../../lib/generate-service.js';
import { notifyTelegram } from '../../lib/notify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  if (req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runGenerationTask();
    res.json(result);
  } catch (e) {
    await notifyTelegram(`Cron generate error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}
