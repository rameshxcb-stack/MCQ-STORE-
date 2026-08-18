// lib/mcq-generator.js
import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';

// Node.js में Deno.env की जगह process.env use होता है
const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// Helper function to normalize text
function normalizeMCQText(text) {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s\u0900-\u097F]/g, "")
    .trim();
}

// Helper function to compute SHA-256 hash
async function computeHash(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getRandomKey(envVar) {
  const keys = (process.env[envVar] || "").split(",").filter(Boolean);
  if (keys.length === 0) throw new Error(`No keys for ${envVar}`);
  return keys[Math.floor(Math.random() * keys.length)];
}

// Call Gemini API
async function callGemini(prompt) {
  const key = getRandomKey("GEMINI_KEYS");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${key}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { response_mime_type: "application/json" }
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error("Invalid Gemini response");
    return JSON.parse(text);
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// Call DeepSeek API (Fallback)
async function callDeepSeek(prompt) {
  const key = getRandomKey("DEEPSEEK_KEYS");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const url = "https://api.deepseek.com/v1/chat/completions";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "system", content: "Return ONLY JSON array." }, { role: "user", content: prompt }],
        response_format: { type: "json_object" }
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Invalid DeepSeek response");
    return JSON.parse(text);
  } catch (e) {
    clearTimeout(timeout);
    throw e;
  }
}

// Main Generation Function (YAHAN SE MCQs INSERT HONGE)
export async function generateAndStoreMCQs(subject, chapter, count) {
  const prompt = `Generate ${count} MCQs for subject "${subject}", chapter "${chapter}" in Hinglish in JSON array format.`;
  
  let raw = [];
  try {
    raw = await callGemini(prompt);
  } catch (err) {
    console.warn("Gemini failed, trying DeepSeek:", err.message);
    raw = await callDeepSeek(prompt);
  }

  if (!Array.isArray(raw) || raw.length === 0) throw new Error("AI returned empty response");

  // ✅ Remove duplicates and INSERT to mcqs table
  const newHashes = [];
  const mcqMap = new Map();
  for (const mcq of raw) {
    const hash = await computeHash(normalizeMCQText(mcq.question));
    newHashes.push(hash);
    mcqMap.set(hash, mcq);
  }

  const placeholders = newHashes.map(() => '?').join(',');
  const { rows: existingRows } = await db.execute({
    sql: `SELECT hash FROM mcqs WHERE hash IN (${placeholders})`,
    args: newHashes,
  });
  const existingSet = new Set(existingRows.map(r => r.hash));

  let stored = 0;
  for (const hash of newHashes) {
    if (existingSet.has(hash)) continue;

    const mcq = mcqMap.get(hash);
    const answerIndex = mcq.options.indexOf(mcq.correct_answer);
    if (answerIndex === -1) continue;

    const id = randomUUID();
    await db.execute({
      sql: `INSERT INTO mcqs (id, subject, chapter, difficulty, question, option_a, option_b, option_c, option_d, answer, explanation, hash, quality_score, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id, subject, chapter, mcq.difficulty || "medium",
        mcq.question, mcq.options[0], mcq.options[1], mcq.options[2], mcq.options[3],
        answerIndex, mcq.explanation, hash, 70, Date.now()
      ],
    });
    stored++;
  }
  return stored;
}
