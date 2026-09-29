import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { DRAFT_SYSTEM, findDraftIssues, runDraft } from "../src/agents/draft";
import { insertItemIfNew, insertLead, listDraftsByStatus, recordApiCall } from "../src/db/queries";

const db = env.DB;
const now = new Date("2026-09-29T12:00:00Z");
const cenv = { ...env, DAILY_BUDGET_USD: "3", CLAUDE_MODEL: "claude-haiku-4-5" };

async function seedLead(id: string) {
  const itemId = await insertItemIfNew(
    db,
    { source: "reddit:dentistry", externalId: id, url: `https://reddit.com/${id}`, authorHash: null, excerpt: "insurance calls all day", createdUtc: 1 },
    now,
  );
  return insertLead(db, { itemId: itemId!, score: 0.9, painSummary: "insurance calls" }, now);
}

function stub(reply = "That sounds exhausting. How do you handle verification today?") {
  const bodies: { system: string; messages: { content: string }[] }[] = [];
  const fn = (async (_u: unknown, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return new Response(
      JSON.stringify({ content: [{ type: "text", text: reply }], usage: { input_tokens: 300, output_tokens: 40 } }),
    );
  }) as unknown as typeof fetch;
  return { fn, bodies };
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

describe("runDraft", () => {
  it("drafts pending replies for new leads only, once per lead", async () => {
    await seedLead("a");
    await seedLead("b");
    const s = stub();
    expect((await runDraft(cenv, now, s.fn)).drafted).toBe(2);
    const pending = await listDraftsByStatus(db, "pending");
    expect(pending).toHaveLength(2);
    expect(pending.every((d) => d.kind === "reply")).toBe(true);
    // Second run has nothing new to draft and makes no calls.
    const s2 = stub();
    expect((await runDraft(cenv, now, s2.fn)).drafted).toBe(0);
    expect(s2.bodies).toHaveLength(0);
  });

  it("puts the voice guide in the system prompt and the post in the user message", async () => {
    await seedLead("a");
    const s = stub();
    await runDraft(cenv, now, s.fn);
    expect(s.bodies[0].system).toBe(DRAFT_SYSTEM);
    expect(s.bodies[0].system).toMatch(/never pitch/i);
    expect(s.bodies[0].messages[0].content).toContain("insurance calls");
  });

  it("stops when the budget is exhausted", async () => {
    await seedLead("a");
    await recordApiCall(db, { agent: "t", model: "claude-haiku-4-5", inputTokens: 1, outputTokens: 1, costUsd: 3 }, now);
    const s = stub();
    const out = await runDraft(cenv, now, s.fn);
    expect(out).toEqual({ drafted: 0, stoppedByBudget: true, stoppedByRateLimit: false });
    expect(s.bodies).toHaveLength(0);
    expect(await listDraftsByStatus(db, "pending")).toHaveLength(0);
  });

  it("ignores empty model output", async () => {
    await seedLead("a");
    expect((await runDraft(cenv, now, stub("   ").fn)).drafted).toBe(0);
  });
});

describe("findDraftIssues", () => {
  it("passes a curious, non-pitching reply", () => {
    expect(findDraftIssues("That sounds draining. How are you handling insurance verification today?")).toEqual([]);
  });
  it("flags links, pitches and exclamation marks", () => {
    expect(findDraftIssues("Check out https://example.com")).toEqual(expect.arrayContaining(["contains a link", "sounds like a pitch"]));
    expect(findDraftIssues("Great post!")).toContain("has an exclamation mark");
    expect(findDraftIssues("We offer a tool for this")).toContain("sounds like a pitch");
  });
});
