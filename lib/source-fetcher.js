import { db } from './db.js';
import * as cheerio from 'cheerio';

const SOURCE_TTL_DEFAULT = 7 * 24 * 60 * 60 * 1000;
const SOURCE_TTL_CURRENT = 6 * 60 * 60 * 1000;

function normalizeKey(input) {
  return String(input || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export async function fetchSourceContent(subject, chapter, topic) {
  const safeSubject = normalizeKey(subject);
  const safeChapter = normalizeKey(chapter);
  const safeTopic = normalizeKey(topic || chapter || subject);
  const cacheKey = `${safeSubject}_${safeChapter}_${safeTopic}`;

  const ttl = subject.toLowerCase().includes('current affairs') ? SOURCE_TTL_CURRENT : SOURCE_TTL_DEFAULT;

  const cached = await db.execute({
    sql: 'SELECT content, fetched_at FROM source_cache WHERE cache_key = ?',
    args: [cacheKey]
  });
  if (cached.rows.length > 0 && Date.now() - cached.rows[0].fetched_at < ttl) {
    return JSON.parse(cached.rows[0].content);
  }

  let source = null;

  const officialType = detectOfficialType(subject);
  if (officialType) {
    source = await fetchOfficialSearch(officialType, topic || chapter || subject);
    if (source) source.sourceType = 'official';
  }

  if (!source) {
    source = await fetchWikipediaSummary(topic || chapter || subject);
    if (source) source.sourceType = 'wikipedia';
  }

  if (source) {
    await db.execute({
      sql: `INSERT INTO source_cache (cache_key, content, fetched_at)
            VALUES (?,?,?)
            ON CONFLICT(cache_key) DO UPDATE SET content=excluded.content, fetched_at=excluded.fetched_at`,
      args: [cacheKey, JSON.stringify(source), Date.now()]
    });
  }
  return source;
}

function detectOfficialType(subject) {
  const s = subject.toLowerCase();
  if (s.includes('polity') || s.includes('constitution')) return 'constitution';
  if (s.includes('economy') || s.includes('rbi')) return 'rbi';
  if (s.includes('current affairs')) return 'pib';
  return null;
}

async function fetchOfficialSearch(type, searchTerm) {
  const searchUrls = {
    constitution: `https://legislative.gov.in/?s=${encodeURIComponent(searchTerm)}`,
    rbi: `https://www.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?search=${encodeURIComponent(searchTerm)}`,
    pib: `https://pib.gov.in/PressReleaseSearch.aspx?search=${encodeURIComponent(searchTerm)}`
  };
  const url = searchUrls[type];
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const extract = $('div.content, article, #content, main, body').first().text()
      .replace(/\s+/g, ' ').trim();
    if (extract.length < 100) return null;
    return { title: searchTerm, extract: extract.slice(0, 5000), content_urls: url, timestamp: new Date().toISOString() };
  } catch {
    return null;
  }
}

async function fetchWikipediaSummary(searchTerm) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(searchTerm)}`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    return { title: data.title, extract: data.extract, content_urls: data.content_urls?.desktop?.page, timestamp: data.timestamp };
  } catch {
    return null;
  }
}
