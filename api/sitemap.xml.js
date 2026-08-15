import { db } from '../lib/db.js';

const DOMAIN = process.env.DOMAIN || 'https://your-domain.com';

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export default async function handler(req, res) {
  const chapters = await db.execute('SELECT DISTINCT chapter FROM mcqs');
  const urls = chapters.rows.map(r => `${DOMAIN}/chapter/${encodeURIComponent(r.chapter)}`);
  urls.push(`${DOMAIN}/`);
  urls.push(`${DOMAIN}/about.html`);
  urls.push(`${DOMAIN}/contact.html`);
  urls.push(`${DOMAIN}/privacy.html`);
  urls.push(`${DOMAIN}/terms.html`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>${escapeXml(u)}</loc></url>`).join('\n')}
</urlset>`;

  res.setHeader('Content-Type', 'application/xml');
  res.send(xml);
}
