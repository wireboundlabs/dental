// All D1 access lives here. Every statement is parameterized.

type LeadStatus = "new" | "drafted" | "contacted" | "dismissed";
export type DraftStatus = "pending" | "approved" | "rejected" | "sent";
export type DraftKind = "reply" | "email";

export interface NewItem {
  source: string;
  externalId: string;
  url: string;
  authorHash: string | null;
  excerpt: string;
  createdUtc: number;
  /** The model's 0-1 relevance, kept for every scored item. */
  relevance?: number | null;
  /** One-line pain summary; null when patient details may be present. */
  painSummary?: string | null;
  /** Commenter display name. Only pass it for items that become leads. */
  authorName?: string | null;
}

export interface DraftRow {
  id: number;
  lead_id: number;
  kind: DraftKind;
  body: string;
  edited_body: string | null;
  status: DraftStatus;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  // joined
  url: string;
  pain_summary: string;
  score: number;
  excerpt: string;
  author_name: string | null;
  /** When the comment was posted (unix seconds). */
  created_utc: number;
}

export interface LeadForDraft {
  id: number;
  score: number;
  pain_summary: string;
  excerpt: string;
  url: string;
}

/** UTC day key, e.g. "2026-09-29". Budget and digest both use this. */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function insertItemIfNew(db: D1Database, item: NewItem, now: Date): Promise<number | null> {
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO items (source, external_id, url, author_hash, excerpt, created_utc, fetched_at, relevance, pain_summary, author_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      item.source,
      item.externalId,
      item.url,
      item.authorHash,
      item.excerpt,
      item.createdUtc,
      now.toISOString(),
      item.relevance ?? null,
      item.painSummary ?? null,
      item.authorName ?? null,
    )
    .run();
  return res.meta.changes > 0 ? res.meta.last_row_id : null;
}

export async function insertLead(
  db: D1Database,
  lead: { itemId: number; score: number; painSummary: string },
  now: Date,
): Promise<number> {
  const res = await db
    .prepare(`INSERT INTO leads (item_id, score, pain_summary, status, created_at) VALUES (?, ?, ?, 'new', ?)`)
    .bind(lead.itemId, lead.score, lead.painSummary, now.toISOString())
    .run();
  return res.meta.last_row_id;
}

export async function listLeadsNeedingDraft(db: D1Database, limit: number): Promise<LeadForDraft[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id, l.score, l.pain_summary, i.excerpt, i.url
         FROM leads l JOIN items i ON i.id = l.item_id
        WHERE l.status = 'new'
        ORDER BY l.score DESC, l.id
        LIMIT ?`,
    )
    .bind(limit)
    .all<LeadForDraft>();
  return results;
}

export async function insertDraft(
  db: D1Database,
  draft: { leadId: number; kind: DraftKind; body: string },
  now: Date,
): Promise<number> {
  const ts = now.toISOString();
  const [ins] = await db.batch([
    db
      .prepare(
        `INSERT INTO drafts (lead_id, kind, body, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)`,
      )
      .bind(draft.leadId, draft.kind, draft.body, ts, ts),
    db.prepare(`UPDATE leads SET status = 'drafted' WHERE id = ? AND status = 'new'`).bind(draft.leadId),
  ]);
  return ins.meta.last_row_id;
}

export async function listDraftsByStatus(db: D1Database, status: DraftStatus): Promise<DraftRow[]> {
  const { results } = await db
    .prepare(
      `SELECT d.*, i.url, i.excerpt, i.author_name, i.created_utc, l.pain_summary, l.score
         FROM drafts d
         JOIN leads l ON l.id = d.lead_id
         JOIN items i ON i.id = l.item_id
        WHERE d.status = ?
        ORDER BY d.created_at DESC, d.id DESC`,
    )
    .bind(status)
    .all<DraftRow>();
  return results;
}

export async function getDraft(db: D1Database, id: number): Promise<DraftRow | null> {
  return db
    .prepare(
      `SELECT d.*, i.url, i.excerpt, i.author_name, i.created_utc, l.pain_summary, l.score
         FROM drafts d
         JOIN leads l ON l.id = d.lead_id
         JOIN items i ON i.id = l.item_id
        WHERE d.id = ?`,
    )
    .bind(id)
    .first<DraftRow>();
}

/**
 * Allowed human transitions. "sent" only means the human says they sent it themselves.
 * A rejection can be undone (back to pending, or straight to approved); sending stays terminal.
 */
const TRANSITIONS: Record<DraftStatus, DraftStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["sent", "rejected"],
  rejected: ["pending", "approved"],
  sent: [],
};

export async function transitionDraft(
  db: D1Database,
  id: number,
  to: DraftStatus,
  now: Date,
): Promise<boolean> {
  const draft = await getDraft(db, id);
  if (!draft || !TRANSITIONS[draft.status].includes(to)) return false;
  const ts = now.toISOString();
  const stmts = [
    db
      .prepare(`UPDATE drafts SET status = ?, updated_at = ?, sent_at = ? WHERE id = ? AND status = ?`)
      .bind(to, ts, to === "sent" ? ts : null, id, draft.status),
  ];
  if (to === "sent") {
    stmts.push(db.prepare(`UPDATE leads SET status = 'contacted' WHERE id = ?`).bind(draft.lead_id));
  }
  const [first] = await db.batch(stmts);
  return first.meta.changes > 0;
}

/** Edit text of a draft that has not been sent or rejected. */
export async function editDraft(db: D1Database, id: number, body: string, now: Date): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE drafts SET edited_body = ?, updated_at = ? WHERE id = ? AND status IN ('pending','approved')`,
    )
    .bind(body, now.toISOString(), id)
    .run();
  return res.meta.changes > 0;
}

// ---- API spend ----

export async function recordApiCall(
  db: D1Database,
  call: {
    agent: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    leadId?: number | null;
  },
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_calls (ts, day, agent, model, input_tokens, output_tokens, cost_usd, lead_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      now.toISOString(),
      utcDay(now),
      call.agent,
      call.model,
      call.inputTokens,
      call.outputTokens,
      call.costUsd,
      call.leadId ?? null,
    )
    .run();
}

export async function spentOnDay(db: D1Database, day: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM api_calls WHERE day = ?`)
    .bind(day)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Records the first time the cap is hit on a given day; later calls are no-ops. Returns true if newly recorded. */
export async function recordCapHit(db: D1Database, day: string, spentUsd: number, now: Date): Promise<boolean> {
  const res = await db
    .prepare(`INSERT OR IGNORE INTO budget_events (day, cap_hit_at, spent_usd) VALUES (?, ?, ?)`)
    .bind(day, now.toISOString(), spentUsd)
    .run();
  return res.meta.changes > 0;
}

export async function getCapHit(
  db: D1Database,
  day: string,
): Promise<{ cap_hit_at: string; spent_usd: number } | null> {
  return db
    .prepare(`SELECT cap_hit_at, spent_usd FROM budget_events WHERE day = ?`)
    .bind(day)
    .first<{ cap_hit_at: string; spent_usd: number }>();
}

// ---- cursors ----

export async function getCursor(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare(`SELECT last_seen FROM cursors WHERE source_key = ?`).bind(key).first<{
    last_seen: string;
  }>();
  return row?.last_seen ?? null;
}

/** Several cursors in one round trip (missing keys are absent from the map). */
export async function getCursors(db: D1Database, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < keys.length; i += IN_CHUNK) {
    const chunk = keys.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT source_key, last_seen FROM cursors WHERE source_key IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ source_key: string; last_seen: string }>();
    for (const r of results) out.set(r.source_key, r.last_seen);
  }
  return out;
}

export async function setCursor(db: D1Database, key: string, lastSeen: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO cursors (source_key, last_seen) VALUES (?, ?)
       ON CONFLICT(source_key) DO UPDATE SET last_seen = excluded.last_seen`,
    )
    .bind(key, lastSeen)
    .run();
}

// ---- digest ----

export async function countLeadsSince(db: D1Database, sinceIso: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM leads WHERE created_at >= ?`)
    .bind(sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function listLeadsSince(
  db: D1Database,
  sinceIso: string,
  limit: number,
): Promise<{ pain_summary: string; score: number; url: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT l.pain_summary, l.score, i.url
         FROM leads l JOIN items i ON i.id = l.item_id
        WHERE l.created_at >= ?
        ORDER BY l.score DESC
        LIMIT ?`,
    )
    .bind(sinceIso, limit)
    .all<{ pain_summary: string; score: number; url: string }>();
  return results;
}

export async function countDraftsByStatus(db: D1Database, status: DraftStatus): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM drafts WHERE status = ?`)
    .bind(status)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** D1 allows at most 100 bound parameters per statement. */
const IN_CHUNK = 90;

/** Which of these external ids are already stored for the source. One query per 90 ids, not one per id. */
export async function existingExternalIds(db: D1Database, source: string, ids: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { results } = await db
      .prepare(`SELECT external_id FROM items WHERE source = ? AND external_id IN (${chunk.map(() => "?").join(",")})`)
      .bind(source, ...chunk)
      .all<{ external_id: string }>();
    for (const r of results) found.add(r.external_id);
  }
  return found;
}

