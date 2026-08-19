import { createClient } from '@libsql/client';
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=86400, stale-while-revalidate=604800');

  const { chapter } = req.query;
  if (!chapter) return res.status(400).json({ error: 'Chapter required' });

  try {
    const result = await db.execute({
      sql: "SELECT data FROM bundles WHERE chapter = ? ORDER BY version DESC LIMIT 1",
      args: [chapter.toLowerCase()]
    });
    if (result.rows.length === 0) return res.status(404).json({ error: 'Bundle not found' });
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(result.rows[0].data);
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
