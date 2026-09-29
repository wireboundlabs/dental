import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { BudgetExceededError, assertWithinBudget, getDailyCap } from "../src/budget";
import { callClaude } from "../src/claude/client";
import { costUsd } from "../src/claude/pricing";
import { getCapHit, recordApiCall, spentOnDay } from "../src/db/queries";

const db = env.DB;
const now = new Date("2026-09-29T12:00:00Z");
const day = "2026-09-29";

const spend = (cost: number, at = now) =>
  recordApiCall(db, { agent: "t", model: "claude-haiku-4-5", inputTokens: 1, outputTokens: 1, costUsd: cost }, at);

const claudeEnv = { ...env, DAILY_BUDGET_USD: "3", CLAUDE_MODEL: "claude-haiku-4-5" };

function fakeFetch(usage = { input_tokens: 1000, output_tokens: 200 }) {
  const calls: unknown[] = [];
  const fn = (async (_url: unknown, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    return new Response(JSON.stringify({ content: [{ type: "text", text: "hello" }], usage }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM api_calls"), db.prepare("DELETE FROM budget_events")]);
});

describe("pricing", () => {
  it("computes Haiku 4.5 cost", () => {
    expect(costUsd("claude-haiku-4-5", 1_000_000, 1_000_000)).toBe(6);
    expect(costUsd("claude-haiku-4-5", 1000, 200)).toBeCloseTo(0.002);
  });
  it("fails closed on unknown model", () => {
    expect(() => costUsd("mystery", 1, 1)).toThrow();
  });
});

describe("getDailyCap", () => {
  it("parses valid values", () => expect(getDailyCap("3")).toBe(3));
  it.each([undefined, "", "abc", "0", "-1"])("rejects %s", (v) => {
    expect(() => getDailyCap(v as string | undefined)).toThrow();
  });
});

describe("assertWithinBudget", () => {
  it("allows spend under the cap", async () => {
    await spend(1);
    await expect(assertWithinBudget(db, 3, 0.01, now)).resolves.toBeUndefined();
    expect(await getCapHit(db, day)).toBeNull();
  });

  it("blocks when spend equals the cap and records the hit", async () => {
    await spend(3);
    await expect(assertWithinBudget(db, 3, 0, now)).rejects.toBeInstanceOf(BudgetExceededError);
    expect((await getCapHit(db, day))?.spent_usd).toBe(3);
  });

  it("blocks when worst case would exceed the cap", async () => {
    await spend(2.999);
    await expect(assertWithinBudget(db, 3, 0.01, now)).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it("resets on a new UTC day", async () => {
    await spend(3);
    const tomorrow = new Date("2026-09-30T00:00:01Z");
    await expect(assertWithinBudget(db, 3, 0.01, tomorrow)).resolves.toBeUndefined();
  });
});

describe("callClaude", () => {
  const req = { agent: "score", system: "sys", user: "hi", maxTokens: 100 };

  it("calls the API, records cost, returns text", async () => {
    const { fn, calls } = fakeFetch();
    const out = await callClaude(claudeEnv, req, now, fn);
    expect(out.text).toBe("hello");
    expect(calls).toHaveLength(1);
    expect(await spentOnDay(db, day)).toBeCloseTo(0.002);
  });

  it("makes no API call once the cap is reached", async () => {
    await spend(3);
    const { fn, calls } = fakeFetch();
    await expect(callClaude(claudeEnv, req, now, fn)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(calls).toHaveLength(0);
  });

  it("records the cap hit when a call pushes spend to the cap", async () => {
    await spend(2.999);
    const { fn } = fakeFetch({ input_tokens: 1000, output_tokens: 200 });
    await callClaude(claudeEnv, { ...req, maxTokens: 1 }, now, fn);
    expect(await getCapHit(db, day)).not.toBeNull();
  });

  it("fails closed on a bad budget var", async () => {
    const { fn, calls } = fakeFetch();
    await expect(callClaude({ ...claudeEnv, DAILY_BUDGET_USD: "nope" }, req, now, fn)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("does not record spend when the API errors", async () => {
    const bad = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(callClaude(claudeEnv, req, now, bad)).rejects.toThrow(/500/);
    expect(await spentOnDay(db, day)).toBe(0);
  });
});
