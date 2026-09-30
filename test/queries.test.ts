import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  countDraftsByStatus,
  countLeadsSince,
  editDraft,
  existingExternalIds,
  getCapHit,
  getCursor,
  getCursors,
  getDraft,
  insertDraft,
  insertItemIfNew,
  insertLead,
  listDraftsByStatus,
  listLeadsNeedingDraft,
  recordApiCall,
  recordCapHit,
  setCursor,
  spentOnDay,
  transitionDraft,
  utcDay,
} from "../src/db/queries";

const db = env.DB;
const now = new Date("2026-09-29T12:00:00Z");

const item = (externalId: string) => ({
  source: "reddit",
  externalId,
  url: `https://reddit.com/r/dentistry/comments/${externalId}`,
  authorHash: "abc",
  excerpt: "front desk is drowning in insurance calls",
  createdUtc: 1_790_000_000,
});

async function seedLead(externalId = "p1", score = 0.9) {
  const itemId = await insertItemIfNew(db, item(externalId), now);
  return insertLead(db, { itemId: itemId!, score, painSummary: "insurance calls" }, now);
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM drafts"),
    db.prepare("DELETE FROM leads"),
    db.prepare("DELETE FROM items"),
    db.prepare("DELETE FROM api_calls"),
    db.prepare("DELETE FROM budget_events"),
    db.prepare("DELETE FROM cursors"),
  ]);
});

describe("items and leads", () => {
  it("dedupes items by (source, external_id)", async () => {
    expect(await insertItemIfNew(db, item("a"), now)).not.toBeNull();
    expect(await insertItemIfNew(db, item("a"), now)).toBeNull();
    expect(await insertItemIfNew(db, item("b"), now)).not.toBeNull();
  });

  it("lists new leads for drafting, best score first, and respects limit", async () => {
    await seedLead("lo", 0.72);
    await seedLead("hi", 0.95);
    const leads = await listLeadsNeedingDraft(db, 1);
    expect(leads).toHaveLength(1);
    expect(leads[0].score).toBe(0.95);
  });

  it("counts leads since a timestamp", async () => {
    await seedLead("x");
    expect(await countLeadsSince(db, "2026-09-29T00:00:00Z")).toBe(1);
    expect(await countLeadsSince(db, "2026-09-30T00:00:00Z")).toBe(0);
  });
});

describe("drafts", () => {
  it("inserts a pending draft and marks the lead drafted", async () => {
    const leadId = await seedLead();
    const draftId = await insertDraft(db, { leadId, kind: "reply", body: "Curious how you handle this?" }, now);
    const draft = await getDraft(db, draftId);
    expect(draft?.status).toBe("pending");
    expect(draft?.url).toContain("reddit.com");
    expect(await listLeadsNeedingDraft(db, 10)).toHaveLength(0);
    expect(await countDraftsByStatus(db, "pending")).toBe(1);
    expect(await listDraftsByStatus(db, "pending")).toHaveLength(1);
  });

  it("allows only valid transitions", async () => {
    const leadId = await seedLead();
    const id = await insertDraft(db, { leadId, kind: "reply", body: "hi" }, now);
    expect(await transitionDraft(db, id, "sent", now)).toBe(false); // must be approved first
    expect(await transitionDraft(db, id, "approved", now)).toBe(true);
    expect(await transitionDraft(db, id, "pending" as never, now)).toBe(false);
    expect(await transitionDraft(db, id, "sent", now)).toBe(true);
    expect((await getDraft(db, id))?.sent_at).toBe(now.toISOString());
    expect(await transitionDraft(db, id, "rejected", now)).toBe(false); // terminal
    const lead = await db.prepare("SELECT status FROM leads WHERE id = ?").bind(leadId).first<{ status: string }>();
    expect(lead?.status).toBe("contacted");
  });

  it("a rejected draft cannot be edited or sent, but the rejection can be undone", async () => {
    const leadId = await seedLead();
    const id = await insertDraft(db, { leadId, kind: "email", body: "hi" }, now);
    expect(await transitionDraft(db, id, "rejected", now)).toBe(true);
    expect(await transitionDraft(db, id, "sent", now)).toBe(false);
    expect(await editDraft(db, id, "changed", now)).toBe(false);

    expect(await transitionDraft(db, id, "pending", now)).toBe(true); // restore
    expect((await getDraft(db, id))?.status).toBe("pending");
    expect(await editDraft(db, id, "changed", now)).toBe(true);

    expect(await transitionDraft(db, id, "rejected", now)).toBe(true);
    expect(await transitionDraft(db, id, "approved", now)).toBe(true); // straight to approved
    expect((await getDraft(db, id))?.status).toBe("approved");
  });

  it("sending stays terminal", async () => {
    const leadId = await seedLead();
    const id = await insertDraft(db, { leadId, kind: "reply", body: "hi" }, now);
    await transitionDraft(db, id, "approved", now);
    await transitionDraft(db, id, "sent", now);
    for (const to of ["pending", "approved", "rejected"] as const) expect(await transitionDraft(db, id, to, now)).toBe(false);
  });

  it("edits keep the original body", async () => {
    const leadId = await seedLead();
    const id = await insertDraft(db, { leadId, kind: "reply", body: "orig" }, now);
    expect(await editDraft(db, id, "edited", now)).toBe(true);
    const d = await getDraft(db, id);
    expect(d?.body).toBe("orig");
    expect(d?.edited_body).toBe("edited");
  });

  it("returns false for unknown draft ids", async () => {
    expect(await transitionDraft(db, 9999, "approved", now)).toBe(false);
  });
});

describe("api spend", () => {
  const call = (costUsd: number) => ({
    agent: "score",
    model: "claude-haiku-4-5",
    inputTokens: 100,
    outputTokens: 20,
    costUsd,
  });

  it("sums spend per UTC day", async () => {
    await recordApiCall(db, call(0.5), now);
    await recordApiCall(db, call(0.25), now);
    await recordApiCall(db, call(1), new Date("2026-09-30T00:00:01Z"));
    expect(await spentOnDay(db, "2026-09-29")).toBeCloseTo(0.75);
    expect(await spentOnDay(db, "2026-09-30")).toBeCloseTo(1);
    expect(await spentOnDay(db, "2026-01-01")).toBe(0);
  });

  it("records the cap hit only once per day", async () => {
    const day = utcDay(now);
    expect(await recordCapHit(db, day, 3.01, now)).toBe(true);
    expect(await recordCapHit(db, day, 4, new Date("2026-09-29T15:00:00Z"))).toBe(false);
    const hit = await getCapHit(db, day);
    expect(hit?.spent_usd).toBeCloseTo(3.01);
    expect(await getCapHit(db, "2026-09-28")).toBeNull();
  });
});

describe("cursors", () => {
  it("upserts", async () => {
    expect(await getCursor(db, "reddit:dentistry")).toBeNull();
    await setCursor(db, "reddit:dentistry", "t3_a");
    await setCursor(db, "reddit:dentistry", "t3_b");
    expect(await getCursor(db, "reddit:dentistry")).toBe("t3_b");
  });
});

describe("batch lookups", () => {
  it("existingExternalIds returns only stored ids for that source, across chunks", async () => {
    await db.prepare("DELETE FROM leads").run();
    await db.prepare("DELETE FROM items").run();
    const ids = Array.from({ length: 200 }, (_, i) => `x${i}`);
    for (const id of ids.filter((_, i) => i % 50 === 0)) await insertItemIfNew(db, { ...item(id), source: "yt" }, now);
    await insertItemIfNew(db, { ...item("x1"), source: "other" }, now);
    const found = await existingExternalIds(db, "yt", ids);
    expect([...found].sort()).toEqual(["x0", "x100", "x150", "x50"]);
    expect((await existingExternalIds(db, "yt", [])).size).toBe(0);
  });

  it("getCursors reads many keys at once and omits missing ones", async () => {
    await db.prepare("DELETE FROM cursors").run();
    for (let i = 0; i < 150; i++) await setCursor(db, `k${i}`, String(i));
    const keys = [...Array.from({ length: 150 }, (_, i) => `k${i}`), "missing"];
    const got = await getCursors(db, keys);
    expect(got.size).toBe(150);
    expect(got.get("k149")).toBe("149");
    expect(got.has("missing")).toBe(false);
  });
});
