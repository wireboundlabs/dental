-- Every post/comment we have seen (dedupe + provenance).
CREATE TABLE items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,
  external_id  TEXT NOT NULL,
  url          TEXT NOT NULL,
  author_hash  TEXT,
  excerpt      TEXT NOT NULL,
  created_utc  INTEGER NOT NULL,
  fetched_at   TEXT NOT NULL,
  UNIQUE (source, external_id)
);

CREATE TABLE leads (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id      INTEGER NOT NULL UNIQUE REFERENCES items(id),
  score        REAL NOT NULL,
  pain_summary TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'new'
               CHECK (status IN ('new','drafted','contacted','dismissed')),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_leads_status ON leads(status);

CREATE TABLE drafts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id      INTEGER NOT NULL REFERENCES leads(id),
  kind         TEXT NOT NULL CHECK (kind IN ('reply','email')),
  body         TEXT NOT NULL,
  edited_body  TEXT,
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','approved','rejected','sent')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  sent_at      TEXT
);
CREATE INDEX idx_drafts_status ON drafts(status);

CREATE TABLE api_calls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT NOT NULL,
  day           TEXT NOT NULL,
  agent         TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd      REAL NOT NULL,
  lead_id       INTEGER
);
CREATE INDEX idx_api_calls_day ON api_calls(day);

-- One row per UTC day on which the spend cap was hit.
CREATE TABLE budget_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL UNIQUE,
  cap_hit_at  TEXT NOT NULL,
  spent_usd   REAL NOT NULL
);

CREATE TABLE cursors (
  source_key TEXT PRIMARY KEY,
  last_seen  TEXT NOT NULL
);
