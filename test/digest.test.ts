import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { buildDigest } from "../src/digest/build";
import { sendDigest } from "../src/digest/send";
import { insertDraft, insertItemIfNew, insertLead, recordApiCall, recordCapHit, transitionDraft } from "../src/db/queries";

const db = env.DB;
const now = new Date("2026-09-29T13:00:00Z");
const yesterdayTs = new Date("2026-09-28T15:00:00Z");
const denv = { ...env, DAILY_BUDGET_USD: "3" };

const spend = (cost: number, at: Date) =>
  recordApiCall(db, { agent: "t", model: "claude-haiku-4-5", inputTokens: 1, outputTokens: 1, costUsd: cost }, at);

async function seedLead(id: string, score: number, at: Date) {
  const itemId = await insertItemIfNew(
    db,
    { source: "reddit:dentistry", externalId: id, url: `https://reddit.com/${id}`, authorHash: null, excerpt: "e", createdUtc: 1 },
    at,
  );
  return insertLead(db, { itemId: itemId!, score, painSummary: `pain ${id}` }, at);
}

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM drafts"),
    db.prepare("DELETE FROM leads"),
    db.prepare("DELETE FROM items"),
    db.prepare("DELETE FROM api_calls"),
    db.prepare("DELETE FROM budget_events"),
  ]);
});

describe("buildDigest", () => {
  it("reports an empty day", async () => {
    const d = await buildDigest(denv, now);
    expect(d.text).toContain("New leads (last 24h): 0");
    expect(d.text).toContain("Drafts waiting for your review: 0");
    expect(d.text).toContain("spend yesterday (2026-09-28): $0.00 of $3.00 cap");
    expect(d.text).not.toContain("BUDGET CAP HIT");
    expect(d.subject).toBe("Discovery digest: 0 new leads");
  });

  it("lists new leads (last 24h only), pending drafts, and yesterday's spend", async () => {
    const recent = await seedLead("new1", 0.9, yesterdayTs);
    await seedLead("old1", 0.95, new Date("2026-09-20T00:00:00Z"));
    await insertDraft(db, { leadId: recent, kind: "reply", body: "hi" }, yesterdayTs);
    await spend(0.4, yesterdayTs);
    await spend(0.35, yesterdayTs);
    await spend(9, now); // today, must not count as yesterday

    const d = await buildDigest(denv, now);
    expect(d.text).toContain("New leads (last 24h): 1");
    expect(d.text).toContain("pain new1");
    expect(d.text).toContain("https://reddit.com/new1");
    expect(d.text).not.toContain("pain old1");
    expect(d.text).toContain("Drafts waiting for your review: 1");
    expect(d.text).toContain("spend yesterday (2026-09-28): $0.75");
    expect(d.text).toContain("so far today (2026-09-29): $9.00");
    expect(d.subject).toContain("1 new leads");
    expect(d.subject).toContain("1 drafts");
  });

  it("counts approved-but-unsent drafts separately", async () => {
    const lead = await seedLead("a", 0.9, yesterdayTs);
    const id = await insertDraft(db, { leadId: lead, kind: "reply", body: "hi" }, yesterdayTs);
    await transitionDraft(db, id, "approved", yesterdayTs);
    const d = await buildDigest(denv, now);
    expect(d.text).toContain("Drafts waiting for your review: 0");
    expect(d.text).toContain("Approved, not yet marked sent: 1");
  });

  it("reports when the cap was hit", async () => {
    await recordCapHit(db, "2026-09-28", 3.02, new Date("2026-09-28T18:30:00Z"));
    const d = await buildDigest(denv, now);
    expect(d.text).toContain("BUDGET CAP HIT on 2026-09-28");
    expect(d.text).toContain("$3.02");
    expect(d.subject).toContain("CAP HIT");
  });

  it("fails closed on a bad budget var", async () => {
    await expect(buildDigest({ ...denv, DAILY_BUDGET_USD: "x" }, now)).rejects.toThrow();
  });
});

describe("sendDigest", () => {
  const mkEnv = (overrides: object = {}) => {
    const sent: { to: string; from: string; subject: string; text: string }[] = [];
    return {
      sent,
      env: {
        ...denv,
        OWNER_EMAIL: "owner@example.com",
        DIGEST_FROM: "digest@example.com",
        EMAIL: { send: async (m: (typeof sent)[number]) => void sent.push(m) },
        ...overrides,
      },
    };
  };

  it("sends exactly one email, only to the owner", async () => {
    const { sent, env: e } = mkEnv();
    await sendDigest(e, now);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@example.com");
    expect(sent[0].from).toBe("digest@example.com");
    expect(sent[0].text).toContain("Nothing was sent or posted automatically");
  });

  it("refuses to send without configured addresses", async () => {
    const { sent, env: e } = mkEnv({ OWNER_EMAIL: "" });
    await expect(sendDigest(e, now)).rejects.toThrow();
    expect(sent).toHaveLength(0);
  });
});
