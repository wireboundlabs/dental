import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runListen } from "../src/agents/listen";
import { getCursor, recordApiCall } from "../src/db/queries";
import { RedditSource } from "../src/sources/reddit";
import type { Source, SourceItem } from "../src/sources/types";

const db = env.DB;
const now = new Date("2026-09-29T12:00:00Z");
const cenv = { ...env, DAILY_BUDGET_USD: "3", CLAUDE_MODEL: "claude-haiku-4-5" };

const mk = (id: string, createdUtc: number, text = "Our front desk spends all day on insurance calls and scheduling."): SourceItem => ({
  source: "test:src",
  externalId: id,
  url: `https://example.com/${id}`,
  author: "dr_smith",
  text,
  createdUtc,
});

const fakeSource = (items: SourceItem[]): Source & { since: (number | null)[] } => {
  const since: (number | null)[] = [];
  return {
    key: "test:src",
    since,
    async fetchRecent(s) {
      since.push(s);
      return items.filter((i) => s === null || i.createdUtc > s);
    },
  };
};

/** Claude stub: replies by item id embedded in the prompt. */
function claudeStub(replyFor: (prompt: string) => string) {
  let calls = 0;
  const fn = (async (_u: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: replyFor(body.messages[0].content) }],
        usage: { input_tokens: 400, output_tokens: 50 },
      }),
    );
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

const high = '{"relevance":0.9,"pain_summary":"phones and insurance","patient_info_present":false}';
const low = '{"relevance":0.1,"pain_summary":"unrelated","patient_info_present":false}';

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

describe("runListen", () => {
  it("stores qualified leads, keeps unqualified items for dedupe, advances the cursor", async () => {
    const stub = claudeStub((p) => (p.includes("KEEP") ? high : low));
    const src = fakeSource([
      mk("a", 100, "KEEP: front desk drowning in insurance calls, hours every day"),
      mk("b", 200, "Just a general question about dental school interviews and applications"),
    ]);
    const out = await runListen(cenv, [src], now, stub.fn);
    expect(out).toMatchObject({ seen: 2, scored: 2, leads: 1, stoppedByBudget: false });
    const leads = await db.prepare("SELECT pain_summary FROM leads").all();
    expect(leads.results).toHaveLength(1);
    const items = await db.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    expect(items?.n).toBe(2);
    expect(await getCursor(db, "test:src")).toBe("200");
  });

  it("does not rescore items it has already seen", async () => {
    const stub = claudeStub(() => high);
    const src = fakeSource([mk("a", 100)]);
    await runListen(cenv, [src], now, stub.fn);
    await db.prepare("DELETE FROM cursors").run(); // force re-fetch of the same item
    await runListen(cenv, [src], now, stub.fn);
    expect(stub.calls()).toBe(1);
  });

  it("skips very short items without spending", async () => {
    const stub = claudeStub(() => high);
    await runListen(cenv, [fakeSource([mk("s", 100, "too short")])], now, stub.fn);
    expect(stub.calls()).toBe(0);
  });

  it("does not store malformed-output items, and counts them", async () => {
    const stub = claudeStub(() => "not json");
    const out = await runListen(cenv, [fakeSource([mk("m", 100)])], now, stub.fn);
    expect(out.skippedMalformed).toBe(1);
    expect(out.leads).toBe(0);
  });

  it("withholds the excerpt when patient info is flagged", async () => {
    const stub = claudeStub(() => '{"relevance":0.9,"pain_summary":"x","patient_info_present":true}');
    await runListen(cenv, [fakeSource([mk("p", 100, "Patient John Doe called about his bill again and again today")])], now, stub.fn);
    const row = await db.prepare("SELECT excerpt FROM items").first<{ excerpt: string }>();
    expect(row?.excerpt).not.toContain("John");
  });

  it("hashes the author name", async () => {
    const stub = claudeStub(() => high);
    await runListen(cenv, [fakeSource([mk("h", 100)])], now, stub.fn);
    const row = await db.prepare("SELECT author_hash FROM items").first<{ author_hash: string }>();
    expect(row?.author_hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("stops at the daily cap, makes no further calls, and leaves the cursor before unscored items", async () => {
    // Already at the cap.
    await recordApiCall(
      db,
      { agent: "t", model: "claude-haiku-4-5", inputTokens: 1, outputTokens: 1, costUsd: 3 },
      now,
    );
    const stub = claudeStub(() => high);
    const out = await runListen(cenv, [fakeSource([mk("a", 100), mk("b", 200)])], now, stub.fn);
    expect(out.stoppedByBudget).toBe(true);
    expect(stub.calls()).toBe(0);
    expect(await getCursor(db, "test:src")).toBeNull();
    const cap = await db.prepare("SELECT COUNT(*) AS n FROM budget_events").first<{ n: number }>();
    expect(cap?.n).toBe(1);
  });
});

describe("RedditSource", () => {
  const listing = (children: object[]) => ({ data: { children: children.map((data) => ({ kind: "t3", data })) } });

  function redditFetch(log: { method: string; url: string }[]) {
    return (async (url: string, init: RequestInit) => {
      log.push({ method: init.method ?? "GET", url });
      if (url.includes("access_token")) return new Response(JSON.stringify({ access_token: "tok" }));
      if (url.includes("/new")) {
        return new Response(
          JSON.stringify(
            listing([
              { id: "1", name: "t3_1", author: "a", title: "Insurance hell", selftext: "so many calls", permalink: "/r/dentistry/1", created_utc: 300 },
              { id: "2", name: "t3_2", author: "b", title: "old", selftext: "", permalink: "/r/dentistry/2", created_utc: 50 },
              { id: "3", name: "t3_3", author: "c", title: "gone", selftext: "[removed]", permalink: "/r/dentistry/3", created_utc: 400 },
            ]),
          ),
        );
      }
      return new Response(
        JSON.stringify(listing([{ id: "4", name: "t1_4", author: "d", body: "same here", permalink: "/r/dentistry/c4", created_utc: 310 }])),
      );
    }) as unknown as typeof fetch;
  }

  it("fetches posts and comments, drops old and removed items", async () => {
    const log: { method: string; url: string }[] = [];
    const src = new RedditSource("dentistry", "id", "secret", redditFetch(log));
    const items = await src.fetchRecent(100);
    expect(items.map((i) => i.externalId).sort()).toEqual(["t1_4", "t3_1"]);
    expect(items[0].url).toMatch(/^https:\/\/www\.reddit\.com\/r\/dentistry/);
  });

  it("only ever issues GETs to the data API (POST only for the token exchange)", async () => {
    const log: { method: string; url: string }[] = [];
    await new RedditSource("dentistry", "id", "secret", redditFetch(log)).fetchRecent(null);
    const nonGet = log.filter((r) => r.method !== "GET");
    expect(nonGet).toHaveLength(1);
    expect(nonGet[0].url).toContain("/api/v1/access_token");
  });

  it("filters broad subreddits by keyword", async () => {
    const fn = (async (url: string) => {
      if (url.includes("access_token")) return new Response(JSON.stringify({ access_token: "t" }));
      return new Response(
        JSON.stringify(
          url.includes("/new")
            ? listing([
                { id: "1", name: "t3_1", title: "Dental office payroll", selftext: "help", permalink: "/p1", created_utc: 10 },
                { id: "2", name: "t3_2", title: "Coffee shop lease", selftext: "help", permalink: "/p2", created_utc: 11 },
              ])
            : listing([]),
        ),
      );
    }) as unknown as typeof fetch;
    const items = await new RedditSource("smallbusiness", "id", "s", fn).fetchRecent(null);
    expect(items.map((i) => i.externalId)).toEqual(["t3_1"]);
  });

  it("throws on API errors", async () => {
    const fn = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(new RedditSource("dentistry", "id", "s", fn).fetchRecent(null)).rejects.toThrow(/401/);
  });
});
