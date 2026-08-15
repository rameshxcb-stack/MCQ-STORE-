-- MCQs (Raw Text, Dual Language, No Compression)
CREATE TABLE IF NOT EXISTS mcqs (
  id TEXT PRIMARY KEY,
  exam_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  chapter TEXT NOT NULL,
  topic TEXT,
  difficulty TEXT DEFAULT 'medium',
  question_hi TEXT NOT NULL,
  question_en TEXT NOT NULL,
  option_a_hi TEXT NOT NULL,
  option_a_en TEXT NOT NULL,
  option_b_hi TEXT NOT NULL,
  option_b_en TEXT NOT NULL,
  option_c_hi TEXT NOT NULL,
  option_c_en TEXT NOT NULL,
  option_d_hi TEXT NOT NULL,
  option_d_en TEXT NOT NULL,
  answer INTEGER NOT NULL,
  explanation_hi TEXT,
  explanation_en TEXT,
  hash TEXT UNIQUE NOT NULL,
  quality_score REAL DEFAULT 0,
  is_gold INTEGER DEFAULT 0,
  source_url TEXT,
  retrieval_score REAL,
  random_key INTEGER DEFAULT 0,
  version INTEGER DEFAULT 1,
  parent_qid TEXT,
  attempt_count INTEGER DEFAULT 0,
  correct_count INTEGER DEFAULT 0,
  wrong_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mcqs_chapter ON mcqs(chapter);
CREATE INDEX IF NOT EXISTS idx_mcqs_exam ON mcqs(exam_type);
CREATE INDEX IF NOT EXISTS idx_mcqs_hash ON mcqs(hash);
CREATE INDEX IF NOT EXISTS idx_mcqs_chapter_random ON mcqs(chapter, random_key);

-- Generation tasks
CREATE TABLE IF NOT EXISTS generation_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  chapter TEXT NOT NULL,
  topic TEXT,
  target_count INTEGER NOT NULL,
  generated_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Audit log
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  details TEXT,
  timestamp INTEGER NOT NULL
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  nonce TEXT,
  submitted INTEGER DEFAULT 0,
  expires_at INTEGER NOT NULL
);

-- Rate limits (hashed IP)
CREATE TABLE IF NOT EXISTS rate_limits (
  ip_hash TEXT PRIMARY KEY,
  count INTEGER DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- Results (cleanup 30 days)
CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  chapter TEXT NOT NULL,
  qid TEXT NOT NULL,
  selected INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- Source cache
CREATE TABLE IF NOT EXISTS source_cache (
  cache_key TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- Admin nonces (HMAC replay protection)
CREATE TABLE IF NOT EXISTS admin_nonces (
  nonce TEXT PRIMARY KEY,
  used_at INTEGER NOT NULL
);

-- Bundle metadata (encrypted bundles)
CREATE TABLE IF NOT EXISTS bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chapter TEXT NOT NULL,
  bundle_name TEXT NOT NULL,
  version INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE(chapter, bundle_name)
);

-- Telegram alert dedup
CREATE TABLE IF NOT EXISTS telegram_log (
  id TEXT PRIMARY KEY,
  event TEXT,
  sent_at INTEGER NOT NULL
);

-- Schema migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL,
  rollback_sql TEXT
);
