import { createClient } from '@libsql/client';
import { createCipheriv, randomBytes } from 'crypto';
import { writeFileSync, mkdirSync } from 'fs';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const ENCRYPTION_KEY = process.env.BUNDLE_ENCRYPTION_KEY; // 32 bytes hex

function encrypt(text, keyHex) {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

async function main() {
  const chaptersRes = await db.execute('SELECT DISTINCT chapter FROM mcqs');
  const chapters = chaptersRes.rows.map(r => r.chapter);

  mkdirSync('./bundles', { recursive: true });

  for (const chapter of chapters) {
    const mcqRes = await db.execute({
      sql: `SELECT id, question_hi, question_en, option_a_hi, option_a_en, option_b_hi, option_b_en, option_c_hi, option_c_en, option_d_hi, option_d_en, answer, explanation_hi, explanation_en
            FROM mcqs WHERE chapter = ?`,
      args: [chapter],
    });
    const mcqs = mcqRes.rows;
    if (mcqs.length === 0) continue;

    const shuffled = mcqs.sort(() => Math.random() - 0.5);
    const batchSize = 25;
    for (let i = 0; i < shuffled.length; i += batchSize) {
      const batch = shuffled.slice(i, i + batchSize);
      const bundle = {
        version: 1,
        chapter,
        questions: batch.map(q => ({
          id: q.id,
          q_hi: q.question_hi,
          q_en: q.question_en,
          opts_hi: [q.option_a_hi, q.option_b_hi, q.option_c_hi, q.option_d_hi],
          opts_en: [q.option_a_en, q.option_b_en, q.option_c_en, q.option_d_en],
          answer: q.answer,
          exp_hi: q.explanation_hi,
          exp_en: q.explanation_en,
        })),
      };

      const json = JSON.stringify(bundle);
      const encrypted = encrypt(json, ENCRYPTION_KEY);

      const bundleName = `${chapter}_${Math.floor(i / batchSize) + 1}.json.enc`;
      writeFileSync(`./bundles/${bundleName}`, JSON.stringify(encrypted));

      await db.execute({
        sql: `INSERT INTO bundles (chapter, bundle_name, version, created_at)
              VALUES (?, ?, 1, ?)
              ON CONFLICT(chapter, bundle_name) DO UPDATE SET version = bundles.version + 1`,
        args: [chapter, bundleName, Date.now()],
      });
      console.log(`✅ Created ${bundleName}`);
    }
  }
}

await main();
