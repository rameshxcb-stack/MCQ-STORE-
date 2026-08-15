import { verifyAdminHMAC } from '../../lib/admin-auth.js';
import { runGenerationTask } from '../../lib/generate-service.js';
import { notifyTelegram } from '../../lib/notify.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const isHMACValid = await verifyAdminHMAC(req);
  if (!isHMACValid) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const result = await runGenerationTask();
    res.json(result);
  } catch (e) {
    await notifyTelegram(`Admin generate error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
}
