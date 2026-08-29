import { createClient } from '@libsql/client';
import { randomUUID, createHash } from 'crypto';
import { z } from 'zod';

// ==========================================
// CONFIGURATION
// ==========================================
const QUALITY_GATE = 75;
const BATCH_CONCURRENCY = 5;
const BATCH_DELAY_MS = 1500;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const DISABLED_KEY_COOLDOWN = 5 * 60 * 1000;

let cachedGeminiModels = { data: null, timestamp: 0 };
let cachedDeepSeekModel = { data: null, timestamp: 0 };
const disabledKeys = new Map();

// ==========================================
// 🔐 TURSO DATABASE CONFIG
// ==========================================

function getTursoCredentials() {
  const rawUrl = String(process.env.TURSO_DATABASE_URL || '').trim();
  const rawToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();

  if (!rawUrl) {
    throw new Error('TURSO_DATABASE_URL is missing in Vercel environment.');
  }

  if (!rawToken) {
    throw new Error('TURSO_AUTH_TOKEN is missing in Vercel environment.');
  }

  // Remove only accidental Bearer prefix.
  // Do NOT aggressively modify the actual token.
  let token = rawToken.replace(/^Bearer\s+/i, '').trim();

  // Handle accidental surrounding quotes only.
  if (
    token.length >= 2 &&
    (
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith("'") && token.endsWith("'"))
    )
  ) {
    token = token.slice(1, -1).trim();
  }

  if (!token) {
    throw new Error('TURSO_AUTH_TOKEN became empty after sanitization.');
  }

  let url = rawUrl;

  // Remove accidental surrounding quotes.
  if (
    url.length >= 2 &&
    (
      (url.startsWith('"') && url.endsWith('"')) ||
      (url.startsWith("'") && url.endsWith("'"))
    )
  ) {
    url = url.slice(1, -1).trim();
  }

  // Only remove trailing slash.
  url = url.replace(/\/+$/, '');

  return {
    url,
    token
  };
}

// ==========================================
// ✅ SAFE DB CLIENT SINGLETON
// ==========================================

let _db = null;

export function getDb() {
  if (_db) return _db;

  const { url, token } = getTursoCredentials();

  _db = createClient({
    url,
    authToken: token
  });

  return _db;
}

// ==========================================
// 🔎 SAFE DB DIAGNOSTICS
// ==========================================

export function getDbDiagnostics() {
  try {
    const { url, token } = getTursoCredentials();

    let protocol = 'unknown';

    try {
      protocol = new URL(url).protocol;
    } catch {
      if (url.startsWith('libsql://')) {
        protocol = 'libsql:';
      }
    }

    return {
      urlConfigured: true,
      tokenConfigured: true,
      urlProtocol: protocol,
      urlHost: (() => {
        try {
          if (url.startsWith('libsql://')) {
            return new URL(url.replace(/^libsql:\/\//, 'https://')).hostname;
          }
          return new URL(url).hostname;
        } catch {
          return 'unparseable';
        }
      })(),
      tokenLength: token.length
    };
  } catch (error) {
    return {
      urlConfigured: Boolean(process.env.TURSO_DATABASE_URL),
      tokenConfigured: Boolean(process.env.TURSO_AUTH_TOKEN),
      configurationError: safeDbError(error)
    };
  }
}

export function safeDbError(error) {
  if (!error) {
    return {
      name: 'UnknownError',
      code: null,
      message: 'Unknown database error'
    };
  }

  return {
    name: error?.name || 'Error',
    code: error?.code || null,
    message: String(error?.message || error)
      .replace(/\s+/g, ' ')
      .slice(0, 1000)
  };
}

// ==========================================
// ZOD SCHEMAS
// ==========================================

const RawMCQSchema = z.object({
  question: z.string().min(10, 'Question too short (< 10 chars)'),
  options: z
    .array(z.string().min(1, 'Empty option found'))
    .length(4, 'Must have exactly 4 options'),
  answer: z.union([
    z.number().min(0).max(3),
    z.string()
  ]),
  difficulty: z.string().optional().default('Medium'),
  explanation: z.string().optional().default('No explanation provided.')
});

const AIJudgeResultSchema = z.object({
  passed: z.boolean(),
  confidence: z.number().min(0).max(100),
  options_quality: z.number().min(0).max(100),
  question_quality: z.number().min(0).max(100),
  explanation_valid: z.boolean(),
  contradiction: z.boolean(),
  evidence_sufficient: z.boolean(),
  unique_correct_option: z.boolean(),
  ambiguous: z.boolean(),
  reason: z.string().optional()
});

// ==========================================
// SMART API KEY ROTATION & RETRY
// ==========================================

function getRandomKey(envVarName) {
  const rawKeys = (process.env[envVarName] ?? '')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  if (rawKeys.length === 0) return null;

  const now = Date.now();

  const activeKeys = rawKeys.filter(key => {
    const disabledUntil = disabledKeys.get(key);

    if (disabledUntil && now < disabledUntil) {
      return false;
    }

    if (disabledUntil && now >= disabledUntil) {
      disabledKeys.delete(key);
    }

    return true;
  });

  return activeKeys.length > 0
    ? activeKeys[Math.floor(Math.random() * activeKeys.length)]
    : rawKeys[Math.floor(Math.random() * rawKeys.length)];
}

function markKeyAsRateLimited(key) {
  if (key) {
    disabledKeys.set(
      key,
      Date.now() + DISABLED_KEY_COOLDOWN
    );
  }
}

async function fetchWithRetry(
  resource,
  options = {},
  retries = 3,
  backoffMs = 1000
) {
  const {
    timeout = 15000,
    apiKeyUsed = null,
    ...fetchOptions
  } = options;

  let lastError = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();

    const id = setTimeout(
      () => controller.abort(),
      timeout
    );

    try {
      const response = await fetch(resource, {
        ...fetchOptions,
        signal: controller.signal
      });

      clearTimeout(id);

      if (
        response.status === 429 ||
        response.status === 403
      ) {
        markKeyAsRateLimited(apiKeyUsed);

        if (attempt < retries) {
          await new Promise(resolve =>
            setTimeout(
              resolve,
              backoffMs * Math.pow(2, attempt - 1)
            )
          );

          continue;
        }
      }

      return response;

    } catch (error) {
      clearTimeout(id);
      lastError = error;

      if (attempt === retries) {
        throw error;
      }

      await new Promise(resolve =>
        setTimeout(
          resolve,
          backoffMs * Math.pow(2, attempt - 1)
        )
      );
    }
  }

  throw lastError || new Error('Request failed.');
}

// ==========================================
// UTILITY FUNCTIONS
// ==========================================

function cleanJSONString(text) {
  if (!text) return '';

  const jsonMatch = text.match(
    /(\[[\s\S]*\]|\{[\s\S]*\})/
  );

  if (jsonMatch) {
    return jsonMatch[0];
  }

  return text
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function safeJsonParseAndValidate(
  text,
  schema,
  contextName = 'API'
) {
  if (!text) {
    throw new Error(
      `[${contextName}] Model returned empty/null response`
    );
  }

  const cleaned = cleanJSONString(text);

  if (!cleaned) {
    throw new Error(
      `[${contextName}] Failed to extract valid JSON`
    );
  }

  try {
    const rawParsed = JSON.parse(cleaned);

    if (
      !rawParsed ||
      typeof rawParsed !== 'object'
    ) {
      throw new Error(
        'Parsed JSON is null or not an object'
      );
    }

    const validated = schema.safeParse(rawParsed);

    if (!validated.success) {
      throw new Error(
        `Schema mismatch: ${validated.error.issues
          .map(i => i.message)
          .join(', ')}`
      );
    }

    return validated.data;

  } catch (error) {
    throw new Error(
      `[${contextName}] ${error.message}`
    );
  }
}

function normalizeMCQText(text) {
  if (!text) return '';

  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[^\w\s\u0900-\u097F]/gi, '');
}

function chunkArray(array, size) {
  if (!Array.isArray(array)) return [];

  const chunks = [];

  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }

  return chunks;
}

// ==========================================
// ADVANCED EVIDENCE RETRIEVER
// ==========================================

export async function retrieveEvidence(
  subject,
  chapter
) {
  const fetchWithTimeout = async (
    url,
    options = {},
    timeoutMs = 5000
  ) => {
    const controller = new AbortController();

    const id = setTimeout(
      () => controller.abort(),
      timeoutMs
    );

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      clearTimeout(id);

      return response;

    } catch (error) {
      clearTimeout(id);
      throw error;
    }
  };

  let targetUrl = null;

  try {
    const searchQuery =
      `site:ncert.nic.in ${subject} ${chapter} pdf textbook`;

    const ddgHtmlUrl =
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(searchQuery)}`;

    const ddgRes = await fetchWithTimeout(
      ddgHtmlUrl,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
        }
      },
      4000
    );

    if (ddgRes?.ok) {
      const htmlText = await ddgRes.text();

      if (
        htmlText.toLowerCase().includes('captcha') ||
        htmlText.includes('403')
      ) {
        throw new Error(
          'DDG returned CAPTCHA/Block.'
        );
      }

      const uddgMatches =
        htmlText.match(/uddg=([^&"']+)/g);

      if (
        uddgMatches &&
        uddgMatches.length > 0
      ) {
        for (const match of uddgMatches) {
          const decodedUrl = decodeURIComponent(
            match.replace('uddg=', '')
          );

          if (
            decodedUrl.includes('ncert.nic.in')
          ) {
            targetUrl = decodedUrl;
            break;
          }
        }

        if (!targetUrl) {
          targetUrl = decodeURIComponent(
            uddgMatches[0].replace('uddg=', '')
          );
        }
      }
    }

  } catch (error) {
    console.warn(
      'DDG failed:',
      error.message
    );
  }

  if (targetUrl) {
    try {
      const jinaRes = await fetchWithTimeout(
        `https://r.jina.ai/${targetUrl}`,
        {
          headers: {
            'X-No-Cache': 'true'
          }
        },
        7000
      );

      if (jinaRes?.ok) {
        const fullText =
          await jinaRes.text();

        if (
          fullText &&
          fullText.length > 300 &&
          !fullText
            .toLowerCase()
            .includes('not found')
        ) {
          const cleanedText =
            fullText
              .replace(
                /\[([^\]]+)\]\([^\)]+\)/g,
                '$1'
              )
              .replace(
                /https?:\/\/\S+/g,
                ''
              )
              .replace(
                /[#*`_~]/g,
                ''
              )
              .replace(
                /\s+/g,
                ' '
              )
              .trim();

          return cleanedText.substring(
            0,
            4000
          );
        }
      }

    } catch (error) {
      console.warn(
        'Jina Reader failed:',
        error.message
      );
    }
  }

  try {
    const backupUrl =
      `https://s.jina.ai/${encodeURIComponent(
        `NCERT ${subject} ${chapter} detailed notes`
      )}`;

    const backupRes =
      await fetchWithTimeout(
        backupUrl,
        {
          headers: {
            'X-No-Cache': 'true'
          }
        },
        5000
      );

    if (backupRes?.ok) {
      const text =
        await backupRes.text();

      if (
        text &&
        text.length > 200
      ) {
        const cleaned =
          text
            .replace(
              /\[([^\]]+)\]\([^\)]+\)/g,
              '$1'
            )
            .replace(
              /https?:\/\/\S+/g,
              ''
            )
            .replace(
              /[#*`_~]/g,
              ''
            )
            .replace(
              /\s+/g,
              ' '
            )
            .trim();

        return cleaned.substring(
          0,
          3500
        );
      }
    }

  } catch (error) {
    console.warn(
      'Backup search failed:',
      error.message
    );
  }

  try {
    const wikiUrl =
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(chapter)}`;

    const wikiRes =
      await fetchWithTimeout(
        wikiUrl,
        {},
        3000
      );

    if (wikiRes?.ok) {
      const wikiData =
        await wikiRes.json();

      if (
        wikiData?.extract &&
        wikiData.extract.length > 50
      ) {
        return wikiData.extract;
      }
    }

  } catch (error) {
    console.warn(
      'Wikipedia failed:',
      error.message
    );
  }

  return `Educational curriculum evidence for ${subject} - ${chapter}.`;
}

// ==========================================
// MODEL DISCOVERY
// ==========================================

async function getAvailableGeminiModels(apiKey) {
  if (process.env.GEMINI_MODELS) {
    return process.env.GEMINI_MODELS
      .split(',')
      .map(m => m.trim())
      .filter(Boolean);
  }

  if (
    cachedGeminiModels.data &&
    Date.now() -
      cachedGeminiModels.timestamp <
      CACHE_TTL
  ) {
    return cachedGeminiModels.data;
  }

  try {
    const res =
      await fetchWithRetry(
        `https://generativelanguage.googleapis.com/v1/models?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'GET',
          apiKeyUsed: apiKey
        },
        2
      );

    if (res?.ok) {
      const data = await res.json();

      const models =
        (data?.models || [])
          .filter(m =>
            m.supportedGenerationMethods
              ?.includes('generateContent')
          )
          .map(m =>
            m.name.replace(/^models\//, '')
          );

      if (models.length > 0) {
        cachedGeminiModels = {
          data: models,
          timestamp: Date.now()
        };

        return models;
      }
    }

  } catch (error) {
    console.warn(
      'Gemini model fetch failed:',
      error.message
    );
  }

  return ['gemini-1.5-flash'];
}

async function getAvailableDeepSeekModel(apiKey) {
  if (process.env.DEEPSEEK_MODEL) {
    return process.env.DEEPSEEK_MODEL.trim();
  }

  if (
    cachedDeepSeekModel.data &&
    Date.now() -
      cachedDeepSeekModel.timestamp <
      CACHE_TTL
  ) {
    return cachedDeepSeekModel.data;
  }

  try {
    const res =
      await fetchWithRetry(
        'https://api.deepseek.com/models',
        {
          method: 'GET',
          headers: {
            Authorization:
              `Bearer ${apiKey}`
          },
          apiKeyUsed: apiKey
        },
        2
      );

    if (res?.ok) {
      const data =
        await res.json();

      if (
        Array.isArray(data?.data) &&
        data.data.length > 0
      ) {
        cachedDeepSeekModel = {
          data: data.data[0].id,
          timestamp: Date.now()
        };

        return cachedDeepSeekModel.data;
      }
    }

  } catch (error) {
    console.warn(
      'DeepSeek model fetch failed:',
      error.message
    );
  }

  return 'deepseek-chat';
}

// ==========================================
// GEMINI
// ==========================================

async function callGeminiWithFallback(
  prompt,
  bodyModifier = {}
) {
  const initialKey =
    getRandomKey('GEMINI_KEYS');

  if (!initialKey) {
    throw new Error(
      'GEMINI_KEYS missing in environment.'
    );
  }

  const availableModels =
    await getAvailableGeminiModels(
      initialKey
    );

  let lastError = null;

  for (const model of availableModels) {
    const currentKey =
      getRandomKey('GEMINI_KEYS') ||
      initialKey;

    try {
      const body = {
        contents: [
          {
            parts: [
              {
                text: prompt
              }
            ]
          }
        ],
        generationConfig: {
          response_mime_type:
            'application/json',
          ...bodyModifier
        }
      };

      const res =
        await fetchWithRetry(
          `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${encodeURIComponent(currentKey)}`,
          {
            method: 'POST',
            headers: {
              'Content-Type':
                'application/json'
            },
            body: JSON.stringify(body),
            apiKeyUsed: currentKey
          }
        );

      const data =
        await res.json();

      if (!res.ok) {
        throw new Error(
          `Gemini HTTP ${res.status}: ${
            data?.error?.message ||
            'Unknown Gemini error'
          }`
        );
      }

      const text =
        data?.candidates?.[0]
          ?.content?.parts?.[0]?.text;

      return safeJsonParseAndValidate(
        text,
        AIJudgeResultSchema,
        `Gemini (${model})`
      );

    } catch (error) {
      console.warn(
        `Gemini ${model} failed:`,
        error.message
      );

      lastError = error;
    }
  }

  throw new Error(
    `All Gemini models failed. Last error: ${lastError?.message || 'Unknown error'}`
  );
}

// ==========================================
// AI JUDGES
// ==========================================

async function judgeWithGemini(
  question,
  options,
  answerText,
  explanation,
  evidence
) {
  const prompt =
    `Analyze this MCQ for factual accuracy based strictly on the provided evidence.

EVIDENCE:
${evidence}

QUESTION:
${question}

OPTIONS:
${JSON.stringify(options)}

ANSWER:
${answerText}

EXPLANATION:
${explanation}

Return JSON strictly:
{
  "passed": boolean,
  "confidence": number,
  "options_quality": number,
  "question_quality": number,
  "explanation_valid": boolean,
  "contradiction": boolean,
  "evidence_sufficient": boolean,
  "unique_correct_option": boolean,
  "ambiguous": boolean,
  "reason": "short explanation"
}`;

  return await callGeminiWithFallback(
    prompt
  );
}

async function judgeWithDeepSeek(
  question,
  options,
  answerText,
  explanation,
  evidence
) {
  const apiKey =
    getRandomKey('DEEPSEEK_KEYS');

  if (!apiKey) {
    throw new Error(
      'DEEPSEEK_KEYS missing in environment.'
    );
  }

  const activeModel =
    await getAvailableDeepSeekModel(
      apiKey
    );

  const prompt =
    `Analyze this MCQ for factual accuracy based ONLY on evidence provided.

EVIDENCE:
${evidence}

QUESTION:
${question}

OPTIONS:
A) ${options[0]}
B) ${options[1]}
C) ${options[2]}
D) ${options[3]}

SELECTED ANSWER:
${answerText}

EXPLANATION:
${explanation}

Return JSON strictly:
{
  "passed": boolean,
  "confidence": number,
  "options_quality": number,
  "question_quality": number,
  "explanation_valid": boolean,
  "contradiction": boolean,
  "evidence_sufficient": boolean,
  "unique_correct_option": boolean,
  "ambiguous": boolean,
  "reason": "short explanation"
}`;

  const res =
    await fetchWithRetry(
      'https://api.deepseek.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type':
            'application/json',
          Authorization:
            `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: activeModel,
          messages: [
            {
              role: 'user',
              content: prompt
            }
          ],
          response_format: {
            type: 'json_object'
          }
        }),
        apiKeyUsed: apiKey
      }
    );

  const resJson =
    await res.json();

  if (!res.ok) {
    throw new Error(
      `DeepSeek HTTP ${res.status}: ${
        resJson?.error?.message ||
        'Unknown DeepSeek error'
      }`
    );
  }

  const content =
    resJson?.choices?.[0]
      ?.message?.content;

  return safeJsonParseAndValidate(
    content,
    AIJudgeResultSchema,
    `DeepSeek (${activeModel})`
  );
}

// ==========================================
// QUALITY SCORE
// ==========================================

function calculateQualityScore(
  evidence,
  judgeResult,
  modelAgreementScore
) {
  const qQual =
    (Number(
      judgeResult?.question_quality
    ) || 0) * 0.35;

  const oQual =
    (Number(
      judgeResult?.options_quality
    ) || 0) * 0.35;

  const conf =
    (Number(
      judgeResult?.confidence
    ) || 0) * 0.20;

  const agree =
    (Number(modelAgreementScore) || 0) *
    0.10;

  const baseScore =
    qQual +
    oQual +
    conf +
    agree;

  return Math.round(
    Math.min(
      100,
      Math.max(0, baseScore)
    )
  );
}

// ==========================================
// RAW MCQ VALIDATION
// ==========================================

function validateRawMCQ(mcq) {
  if (
    !mcq ||
    typeof mcq !== 'object' ||
    Array.isArray(mcq)
  ) {
    return {
      valid: false,
      reason:
        'Invalid MCQ input',
      rawInput: mcq
    };
  }

  const result =
    RawMCQSchema.safeParse(mcq);

  if (!result.success) {
    return {
      valid: false,
      reason:
        result.error.issues
          .map(i => i.message)
          .join('; '),
      rawInput: mcq
    };
  }

  const data = result.data;

  const uniqueOpts =
    new Set(
      data.options.map(o =>
        normalizeMCQText(o)
      )
    );

  if (uniqueOpts.size !== 4) {
    return {
      valid: false,
      reason: 'Duplicate options',
      rawInput: mcq
    };
  }

  let answerIdx = -1;

  if (
    typeof data.answer === 'number'
  ) {
    answerIdx = data.answer;

  } else if (
    typeof data.answer === 'string'
  ) {
    const normalizedAns =
      normalizeMCQText(
        data.answer
      );

    answerIdx =
      data.options.findIndex(
        opt =>
          normalizeMCQText(opt) ===
          normalizedAns
      );

    if (answerIdx === -1) {
      const answerValue =
        data.answer
          .toLowerCase()
          .trim();

      const matchIdx =
        ['a', 'b', 'c', 'd', '0', '1', '2', '3']
          .indexOf(answerValue);

      if (matchIdx !== -1) {
        answerIdx =
          matchIdx % 4;
      }
    }
  }

  if (
    answerIdx < 0 ||
    answerIdx > 3
  ) {
    return {
      valid: false,
      reason:
        'Answer index not mapped',
      rawInput: mcq
    };
  }

  return {
    valid: true,
    mcq: {
      question:
        data.question.trim(),

      options:
        data.options.map(o =>
          o.trim()
        ),

      answer: answerIdx,

      difficulty:
        (
          data.difficulty ||
          'Medium'
        ).trim(),

      explanation:
        (
          data.explanation ||
          'No explanation provided.'
        ).trim()
    }
  };
}

// ==========================================
// MAIN GENERATOR
// ==========================================

export async function generateAndStoreMCQs({
  subject,
  chapter,
  rawMCQsInput,
  evidenceText
}) {
  const db = getDb();

  const safeEvidence =
    typeof evidenceText === 'string'
      ? evidenceText.slice(0, 10000)
      : '';

  const rejectedMCQs = [];

  const safeInputArray =
    Array.isArray(rawMCQsInput)
      ? rawMCQsInput
      : [];

  const initialValidated =
    safeInputArray
      .map(validateRawMCQ)
      .filter(result => {
        if (!result || !result.valid) {
          const qTitle =
            result?.rawInput?.question ||
            result?.mcq?.question ||
            'Unknown Question';

          rejectedMCQs.push({
            question: qTitle,
            reason:
              `Structural: ${
                result?.reason ||
                'Invalid structure'
              }`
          });

          return false;
        }

        return true;
      })
      .map(result => result.mcq);

  if (
    initialValidated.length === 0
  ) {
    return {
      success: false,
      count: 0,
      rejectedTotal:
        rejectedMCQs.length,
      rejectedDetails:
        rejectedMCQs
    };
  }

  const approvedMCQs = [];

  const chunks =
    chunkArray(
      initialValidated,
      BATCH_CONCURRENCY
    );

  for (
    let i = 0;
    i < chunks.length;
    i++
  ) {
    const chunkPromises =
      chunks[i].map(
        async mcq => {
          try {
            const geminiResult =
              await judgeWithGemini(
                mcq.question,
                mcq.options,
                mcq.options[mcq.answer],
                mcq.explanation,
                safeEvidence
              );

            let final =
              geminiResult;

            let agreement = 50;

            if (
              !geminiResult.passed ||
              geminiResult.confidence < 90 ||
              geminiResult.ambiguous ||
              !geminiResult.evidence_sufficient
            ) {
              try {
                const deepResult =
                  await judgeWithDeepSeek(
                    mcq.question,
                    mcq.options,
                    mcq.options[mcq.answer],
                    mcq.explanation,
                    safeEvidence
                  );

                if (
                  geminiResult.passed !==
                  deepResult.passed
                ) {
                  rejectedMCQs.push({
                    question:
                      mcq.question,
                    reason:
                      'Model disagreement'
                  });

                  return null;
                }

                agreement = 100;

                if (
                  geminiResult.passed &&
                  deepResult.passed
                ) {
                  final = {
                    ...geminiResult,
                    confidence:
                      Math.min(
                        geminiResult.confidence,
                        deepResult.confidence
                      )
                  };
                }

              } catch (error) {
                rejectedMCQs.push({
                  question:
                    mcq.question,
                  reason:
                    `DeepSeek failed: ${error.message}`
                });

                return null;
              }
            }

            if (
              !final ||
              !final.passed ||
              final.contradiction ||
              !final.explanation_valid ||
              !final.evidence_sufficient ||
              !final.unique_correct_option ||
              final.ambiguous
            ) {
              rejectedMCQs.push({
                question:
                  mcq.question,
                reason:
                  final?.reason ||
                  'Quality gate failed'
              });

              return null;
            }

            const score =
              calculateQualityScore(
                safeEvidence,
                final,
                agreement
              );

            if (
              score < QUALITY_GATE
            ) {
              rejectedMCQs.push({
                question:
                  mcq.question,
                reason:
                  `Score ${score} < ${QUALITY_GATE}`
              });

              return null;
            }

            return {
              mcq,
              score
            };

          } catch (error) {
            rejectedMCQs.push({
              question:
                mcq.question,
              reason:
                `Error: ${error.message}`
            });

            return null;
          }
        }
      );

    approvedMCQs.push(
      ...(await Promise.all(
        chunkPromises
      )).filter(Boolean)
    );

    if (
      i < chunks.length - 1
    ) {
      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            BATCH_DELAY_MS
          )
      );
    }
  }

  if (
    approvedMCQs.length === 0
  ) {
    return {
      success: false,
      count: 0,
      rejectedTotal:
        rejectedMCQs.length,
      rejectedDetails:
        rejectedMCQs
    };
  }

  const uniqueMap =
    new Map();

  for (
    const item of approvedMCQs
  ) {
    const hash =
      createHash('sha256')
        .update(
          normalizeMCQText(
            item.mcq.question
          )
        )
        .digest('hex');

    if (!uniqueMap.has(hash)) {
      uniqueMap.set(
        hash,
        item
      );
    }
  }

  const uniqueItems =
    [...uniqueMap.values()];

  const insertVals =
    uniqueItems
      .map(
        () =>
          '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .join(',');

  const args = [];

  for (
    const item of uniqueItems
  ) {
    const id =
      randomUUID();

    const hash =
      createHash('sha256')
        .update(
          normalizeMCQText(
            item.mcq.question
          )
        )
        .digest('hex');

    args.push(
      id,
      subject || '',
      chapter || '',
      item.mcq.difficulty,
      item.mcq.question,
      item.mcq.options[0],
      item.mcq.options[1],
      item.mcq.options[2],
      item.mcq.options[3],
      item.mcq.answer,
      item.mcq.explanation,
      hash,
      item.score,
      Date.now()
    );
  }

  const sql = `
    INSERT INTO mcqs (
      id,
      subject,
      chapter,
      difficulty,
      question,
      option_a,
      option_b,
      option_c,
      option_d,
      answer,
      explanation,
      hash,
      quality_score,
      created_at
    )
    VALUES ${insertVals}
    ON CONFLICT(hash) DO NOTHING;
  `;

  try {
    await db.execute({
      sql,
      args
    });
  } catch (error) {
    throw new Error(
      `MCQ database insert failed: ${
        safeDbError(error).message
      }`
    );
  }

  return {
    success: true,
    count: uniqueItems.length,
    rejectedTotal:
      rejectedMCQs.length,
    rejectedDetails:
      rejectedMCQs
  };
}
