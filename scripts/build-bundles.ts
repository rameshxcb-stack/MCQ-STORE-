import { createClient } from '@libsql/client';
import { existsSync, mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';

const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
const MAX_STORAGE_MB = 800;
const bundleDir = './public/bundles/';

function sanitizeFileName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9_-]/g, '_');
}

async function buildBundles() {
  if (!existsSync(bundleDir)) mkdirSync(bundleDir, { recursive: true });

  const { rows: popularChapters } = await db.execute({
    sql: `SELECT LOWER(TRIM(chapter)) as chapter, SUM(request_count) as total_req FROM chapter_stats GROUP BY LOWER(TRIM(chapter)) ORDER BY total_req DESC LIMIT 10`
  });
  if (popularChapters.length === 0) return console.log("No traffic data yet.");

  const rawChapters = popularChapters.map(row => row.chapter as string);
  console.log(`✅ Top 10: ${rawChapters.join(', ')}`);

  let totalSizeMB = 0;
  const generatedFiles = [];
  const manifest: Record<string, string> = {};

  for (const chapter of rawChapters) {
    const { rows: mcqs } = await db.execute({
      sql: `SELECT id, subject, chapter, question, option_a, option_b, option_c, option_d, answer, explanation FROM mcqs WHERE LOWER(chapter) = ?`,
      args: [chapter]
    });
    if (mcqs.length === 0) continue;

    const output = mcqs.map(m => ({ id: m.id, q: m.question, options: [m.option_a, m.option_b, m.option_c, m.option_d], answer: m.answer, exp: m.explanation || "" }));
    const jsonString = JSON.stringify(output);
    const safeFileName = `${sanitizeFileName(chapter)}.json`;
    const filePath = join(bundleDir, safeFileName);
    const fileSizeMB = Buffer.byteLength(jsonString, 'utf8') / (1024 * 1024);

    if (totalSizeMB + fileSizeMB > MAX_STORAGE_MB) break;
    writeFileSync(filePath, jsonString, 'utf-8');
    totalSizeMB += fileSizeMB;
    generatedFiles.push(safeFileName);
    manifest[chapter] = safeFileName;
  }

  writeFileSync(join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  generatedFiles.push('manifest.json');

  const existingFiles = readdirSync(bundleDir);
  for (const file of existingFiles) {
    if (file.endsWith('.json') && !generatedFiles.includes(file)) unlinkSync(join(bundleDir, file));
  }
  console.log(`✨ Done. Total size: ${totalSizeMB.toFixed(2)} MB`);
}
buildBundles();
