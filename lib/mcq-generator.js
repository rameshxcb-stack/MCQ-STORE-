// lib/mcq-generator.js
import { createClient } from '@libsql/client';
import { randomUUID } from 'crypto';

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

function normalizeMCQText(text) {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/[^\w\s\u0900-\u097F]/g, "").trim();
}

async function computeHash(text) {
  const data = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function getRandomKey(envVar) {
  const keys = (process.env[envVar] || "").split(",").filter(Boolean);
  return keys.length > 0 ? keys[Math.floor(Math.random() * keys.length)] : null;
}

// ✅ नया Model: Gemini 1.5 Flash (तेज़ और सटीक)
async function callGemini(prompt) {
  const key = getRandomKey("GEMINI_KEYS");
  if (!key) throw new Error("GEMINI_KEYS is missing or invalid.");
  
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  // मॉडल को अपडेट करके gemini-1.5-flash कर दिया
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`;
  
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

// ✅ DeepSeek V3 (अगर चाहें तो deepseek-chat या deepseek-v3)
async function callDeepSeek(prompt) {
  const key = getRandomKey("DEEPSEEK_KEYS");
  if (!key) throw new Error("DEEPSEEK_KEYS is missing or invalid.");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const url = "https://api.deepseek.com/v1/chat/completions";
  
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{ role: "system", content: "Return ONLY a valid JSON array." }, { role: "user", content: prompt }],
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

export async function generateAndStoreMCQs(subject, chapter, count) {
  // ✅ प्रॉम्प्ट को और सख्त किया ताकि AI सही फॉर्मेट दे
  const prompt = `Generate ${count} multiple-choice questions in Hinglish for subject "${subject}", chapter "${chapter}".
  Return ONLY a valid JSON array. Each object must EXACTLY contain these keys:
  "question", "options" (array of 4 strings), "correct_answer" (string), "explanation" (string), "difficulty" ("Easy", "Medium", or "Hard").
  Strictly follow this format. Do not add any extra text or comments outside the JSON.`;

  let raw = [];
  try {
    raw = await callGemini(prompt);
  } catch (err) {
    console.warn("Gemini failed:", err.message);
    try {
      raw = await callDeepSeek(prompt);
    } catch (deepErr) {
      throw new Error(`Both Gemini and DeepSeek failed. Gemini: ${err.message}, DeepSeek: ${deepErr.message}`);
    }
  }

  if (!Array.isArray(raw) || raw.length === 0) throw new Error("AI returned empty or invalid response");

  const newHashes = [];
  const mcqMap = new Map();
  for (const mcq of raw) {
    if (!mcq.question) continue; // अगर JSON सही नहीं है तो स्किप करो
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
        answerIndex, mcq.explanation || "", hash, 70, Date.now()
      ],
    });
    stored++;
  }
  return stored;
}
