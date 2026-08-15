import { createHmac } from 'crypto';
import { db } from './db.js';
import { generateNonce } from './crypto.js';
import { fetchSourceContent } from './source-fetcher.js';

const MCQ_HASH_SECRET = process.env.MCQ_HASH_SECRET;

function normalizeText(text) {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export async function computeHash(questionEn, questionHi) {
  const data = normalizeText(`${questionEn}|${questionHi}`);
  return createHmac('sha256', MCQ_HASH_SECRET).update(data).digest('hex');
}

function getRandomKey(envVar) {
  const keys = (process.env[envVar] || '').split(',').filter(Boolean);
  if (keys.length === 0) throw new Error(`No keys for ${envVar}`);
  return keys[Math.floor(Math.random() * keys.length)];
}

async function withRetry(fn, retries = 3, baseDelay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      const delay = baseDelay * Math.pow(2, i) + Math.random() * 500;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function callGemini(prompt) {
  const key = getRandomKey('GEMINI_KEYS');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: 'application/json' }
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini response missing text');
    return JSON.parse(text);
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

async function callDeepSeek(prompt) {
  const key = getRandomKey('DEEPSEEK_KEYS');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'You are an expert MCQ generator. Return only a JSON array.' },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' }
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error('DeepSeek response missing text');
    return JSON.parse(text);
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

function buildPrompt(examType, subject, chapter, topic, sourceContent, examples, count) {
  const examplesText = examples.length > 0
    ? `Here are some high-quality MCQ examples (previously generated) for this topic:\n${JSON.stringify(examples, null, 2)}\n\n`
    : '';
  return `You are an expert question setter for **${examType}** exam. Generate ${count} multiple-choice questions in **two languages** (Hindi and English) for subject "${subject}", chapter "${chapter}"${topic ? `, topic "${topic}"` : ''}.

Use the following **Trusted Source Text** as your ONLY evidence. Do not include any fact not present in the source.
Source: "${sourceContent.extract}"

${examplesText}

Each MCQ must follow this EXACT JSON structure:
{
  "question_hi": "...",
  "question_en": "...",
  "options_hi": ["...", "...", "...", "..."],
  "options_en": ["...", "...", "...", "..."],
  "correct_answer": "...",
  "explanation_hi": "...",
  "explanation_en": "...",
  "difficulty": "Easy/Medium/Hard"
}

Rules:
- Both Hindi and English versions must be native, not literal translation.
- Options must be plausible and based on common misconceptions.
- Explanation must be detailed (5-6 lines) in both languages.
- Ensure factual accuracy against the source text.
- Return ONLY a valid JSON array.`;
}

function validateMCQ(mcq) {
  if (!mcq || typeof mcq !== 'object') return false;
  const required = ['question_hi','question_en','options_hi','options_en','correct_answer','explanation_hi','explanation_en','difficulty'];
  for (const field of required) if (!mcq[field]) return false;
  if (!Array.isArray(mcq.options_hi) || mcq.options_hi.length !== 4) return false;
  if (!Array.isArray(mcq.options_en) || mcq.options_en.length !== 4) return false;
  if (mcq.options_hi.some(o => typeof o !== 'string' || o.trim() === '')) return false;
  if (mcq.options_en.some(o => typeof o !== 'string' || o.trim() === '')) return false;
  if (!mcq.options_en.includes(mcq.correct_answer)) return false;
  const idxEn = mcq.options_en.indexOf(mcq.correct_answer);
  const correctHi = mcq.options_hi[idxEn];
  if (!correctHi || mcq.options_hi.indexOf(correctHi) !== idxEn) return false;
  return true;
}

async function rateMCQsWithAI(mcqs, sourceContent, examType) {
  const prompt = `Rate the following MCQs on a scale of 0-100 for:
- Factual correctness (verified against source)
- Option quality (plausibility, no grammatical clues)
- Exam similarity for ${examType}
- Explanation clarity

Source: "${sourceContent.extract}"

MCQs: ${JSON.stringify(mcqs)}

Return a JSON array of numbers only.`;
  try {
    return await withRetry(() => callDeepSeek(prompt));
  } catch (e) {
    console.error('DeepSeek rating failed, using Gemini fallback:', e.message);
    const key = getRandomKey('GEMINI_KEYS');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${key}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: 'application/json' }
      }),
    });
    if (!res.ok) throw new Error('Gemini rating failed');
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return JSON.parse(text);
  }
}

export async function generateAndStoreMCQs(task) {
  const { exam_type, subject, chapter, topic, target_count, generated_count } = task;
  const batchSize = 15;

  const sourceContent = await fetchSourceContent(subject, chapter, topic);
  if (!sourceContent) throw new Error('Source content not available');

  const examples = await db.execute({
    sql: `SELECT question_en, option_a_en, option_b_en, option_c_en, option_d_en, answer, explanation_en
          FROM mcqs WHERE exam_type = ? AND subject = ? AND chapter = ? AND quality_score > 80
          ORDER BY quality_score DESC LIMIT 5`,
    args: [exam_type, subject, chapter]
  });

  const prompt = buildPrompt(exam_type, subject, chapter, topic, sourceContent, examples, batchSize);

  let raw;
  try {
    raw = await withRetry(() => callGemini(prompt));
  } catch (e) {
    console.error('Gemini generation failed after retries, trying DeepSeek:', e.message);
    raw = await withRetry(() => callDeepSeek(prompt));
  }

  if (!Array.isArray(raw) || raw.length === 0) throw new Error('AI returned empty response');

  const scores = await withRetry(() => rateMCQsWithAI(raw, sourceContent, exam_type));
  const reliability = sourceContent.sourceType === 'official' ? 1.0 : 0.8;
  const avgScore = scores.reduce((a,b)=>a+b,0)/scores.length;
  if (avgScore * reliability < 80) throw new Error(`Batch quality too low (avg ${avgScore.toFixed(1)})`);

  const insertStatements = [];
  for (let i = 0; i < raw.length; i++) {
    const mcq = raw[i];
    if (!validateMCQ(mcq)) {
      console.warn('MCQ schema invalid, skipping');
      continue;
    }

    const questionHash = await computeHash(mcq.question_en, mcq.question_hi);
    const existing = await db.execute({ sql: 'SELECT id FROM mcqs WHERE hash = ?', args: [questionHash] });
    if (existing.rows.length > 0) continue;

    const answerIndex = mcq.options_en.indexOf(mcq.correct_answer);
    if (answerIndex === -1) continue;

    const id = `${subject.slice(0,3).toUpperCase()}_${chapter.slice(0,3).toUpperCase()}_${String(generated_count + i + 1).padStart(6,'0')}_v1`;
    const now = Date.now();
    const randomKey = Math.floor(Math.random() * 1000000);

    insertStatements.push({
      sql: `INSERT INTO mcqs (
        id, exam_type, subject, chapter, topic, difficulty,
        question_hi, question_en,
        option_a_hi, option_a_en, option_b_hi, option_b_en,
        option_c_hi, option_c_en, option_d_hi, option_d_en,
        answer, explanation_hi, explanation_en,
        hash, quality_score, source_url, retrieval_score, random_key, version, parent_qid, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id, exam_type, subject, chapter, topic, mcq.difficulty || 'medium',
        mcq.question_hi, mcq.question_en,
        mcq.options_hi[0], mcq.options_en[0],
        mcq.options_hi[1], mcq.options_en[1],
        mcq.options_hi[2], mcq.options_en[2],
        mcq.options_hi[3], mcq.options_en[3],
        answerIndex, mcq.explanation_hi, mcq.explanation_en,
        questionHash, scores[i] * reliability, sourceContent.content_urls || '', 0.9, randomKey, 1, null, now
      ]
    });
  }

  if (insertStatements.length > 0) {
    try {
      await db.transaction(async (tx) => {
        for (const stmt of insertStatements) {
          await tx.execute(stmt.sql, stmt.args);
        }
      });
    } catch (e) {
      await db.batch(insertStatements);
    }
  }

  return insertStatements.length;
        }
