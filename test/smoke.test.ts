import { env } from "cloudflare:test";
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { CRON_AGENTS, CRON_DIGEST, runScheduled } from "../src/index";
import { listDraftsByStatus } from "../src/db/queries";
import type { Env } from "../src/env";
import type { Source } from "../src/sources/types";

const now = new Date("2026-09-29T12:00:00Z");

describe("worker", () => {
  it("denies the dashboard without Access", async () => {
    const res = await SELF.fetch("https://example.com/");
    expect(res.status).toBe(403);
  });

  it("wrangler.jsonc crons match the router constants", async () => {
    const raw = await (await import("../wrangler.jsonc?raw")).default;
    expect(raw).toContain(`"${CRON_AGENTS}"`);
    expect(raw).toContain(`"${CRON_DIGEST}"`);
  });
});

describe("runScheduled (end to end with fakes)", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM drafts"),
      env.DB.prepare("DELETE FROM leads"),
      env.DB.prepare("DELETE FROM items"),
      env.DB.prepare("DELETE FROM api_calls"),
      env.DB.prepare("DELETE FROM budget_events"),
      env.DB.prepare("DELETE FROM cursors"),
    ]);
  });

  const sent: { to: string }[] = [];
  const full = {
    ...env,
    DAILY_BUDGET_USD: "3",
    CLAUDE_MODEL: "claude-haiku-4-5",
    OWNER_EMAIL: "owner@example.com",
    DIGEST_FROM: "digest@example.com",
    EMAIL: { send: async (m: { to: string }) => void sent.push(m) },
  } as unknown as Env;

  const source: Source = {
    key: "fake:dentistry",
    async fetchRecent() {
      return [
        {
          source: "fake:dentistry",
          externalId: "t3_1",
          url: "https://reddit.com/r/dentistry/1",
          author: "dr",
          text: "Our front desk spends the whole day on insurance verification calls.",
          createdUtc: 1000,
        },
      ];
    },
  };

  // First Claude call scores, second drafts.
  const claude = (async (_u: unknown, init: RequestInit) => {
    const isScore = JSON.parse(init.body as string).system.includes("screen public online posts");
    const text = isScore
      ? '{"relevance":0.92,"pain_summary":"insurance calls consume the front desk","patient_info_present":false}'
      : "That sounds exhausting. How does your team handle verification today?";
    return new Response(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 300, output_tokens: 50 } }));
  }) as unknown as typeof fetch;

  it("agents cron: listen -> score -> lead -> pending draft, and nothing is sent", async () => {
    await runScheduled(CRON_AGENTS, full, { sources: [source], fetchFn: claude, now });
    const pending = await listDraftsByStatus(env.DB, "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0].pain_summary).toContain("insurance");
    expect(sent).toHaveLength(0);
  });

  it("digest cron sends one email to the owner", async () => {
    await runScheduled(CRON_DIGEST, full, { now });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("owner@example.com");
  });

  it("ignores unknown crons", async () => {
    const before = sent.length;
    await runScheduled("* * * * *", full, { now });
    expect(sent).toHaveLength(before);
  });
});
