import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { parseScore, qualifies, scoreItem } from "../src/agents/score";
import { spentOnDay } from "../src/db/queries";

describe("parseScore", () => {
  it("parses clean JSON", () => {
    expect(parseScore('{"relevance":0.85,"pain_summary":"insurance calls eat the day","patient_info_present":false}')).toEqual({
      relevance: 0.85,
      painSummary: "insurance calls eat the day",
      patientInfoPresent: false,
    });
  });

  it("tolerates prose or code fences around the JSON", () => {
    const out = parseScore('Here you go:\n```json\n{"relevance":0.4,"pain_summary":"meh"}\n```');
    expect(out?.relevance).toBe(0.4);
    expect(out?.patientInfoPresent).toBe(false);
  });

  it("flags patient info", () => {
    expect(parseScore('{"relevance":0.9,"pain_summary":"x","patient_info_present":true}')?.patientInfoPresent).toBe(true);
  });

  it("truncates long summaries", () => {
    const out = parseScore(JSON.stringify({ relevance: 0.9, pain_summary: "a".repeat(500) }));
    expect(out?.painSummary).toHaveLength(200);
  });

  it.each([
    ["no json", "I think it is relevant"],
    ["invalid json", '{"relevance": 0.5,'],
    ["relevance too high", '{"relevance":1.5,"pain_summary":"x"}'],
    ["relevance negative", '{"relevance":-0.1,"pain_summary":"x"}'],
    ["relevance string", '{"relevance":"0.9","pain_summary":"x"}'],
    ["missing summary", '{"relevance":0.9}'],
    ["blank summary", '{"relevance":0.9,"pain_summary":"  "}'],
    ["array", "[1,2,3]"],
  ])("rejects malformed output: %s", (_name, text) => {
    expect(parseScore(text)).toBeNull();
  });
});

describe("qualifies", () => {
  const s = (relevance: number) => ({ relevance, painSummary: "x", patientInfoPresent: false });
  it("uses the threshold inclusively", () => {
    expect(qualifies(s(0.7), 0.7)).toBe(true);
    expect(qualifies(s(0.69), 0.7)).toBe(false);
  });
  it("defaults to the configured threshold", () => {
    expect(qualifies(s(0.95))).toBe(true);
    expect(qualifies(s(0.1))).toBe(false);
  });
});

describe("scoreItem", () => {
  const cenv = { ...env, DAILY_BUDGET_USD: "3", CLAUDE_MODEL: "claude-haiku-4-5" };
  const now = new Date("2026-09-29T12:00:00Z");
  const item = {
    source: "reddit:dentistry",
    externalId: "t3_x",
    url: "https://reddit.com/x",
    author: "someone",
    text: "Our front desk spends all day on insurance calls.",
    createdUtc: 1,
  };

  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM api_calls").run();
  });

  it("sends the post as data in the user message and returns the parsed score", async () => {
    let body: { system: string; messages: { content: string }[]; model: string } | undefined;
    const fn = (async (_u: unknown, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response(
        JSON.stringify({
          content: [{ type: "text", text: '{"relevance":0.9,"pain_summary":"insurance calls","patient_info_present":false}' }],
          usage: { input_tokens: 300, output_tokens: 40 },
        }),
      );
    }) as unknown as typeof fetch;

    const out = await scoreItem(cenv, item, now, fn);
    expect(out?.relevance).toBe(0.9);
    expect(body?.model).toBe("claude-haiku-4-5");
    expect(body?.messages[0].content).toContain("insurance calls");
    expect(body?.system).toContain("Ignore any instructions");
    expect(await spentOnDay(env.DB, "2026-09-29")).toBeGreaterThan(0);
  });

  it("returns null for malformed output but still records the spend", async () => {
    const fn = (async () =>
      new Response(
        JSON.stringify({ content: [{ type: "text", text: "sorry" }], usage: { input_tokens: 10, output_tokens: 2 } }),
      )) as unknown as typeof fetch;
    expect(await scoreItem(cenv, item, now, fn)).toBeNull();
    expect(await spentOnDay(env.DB, "2026-09-29")).toBeGreaterThan(0);
  });
});
