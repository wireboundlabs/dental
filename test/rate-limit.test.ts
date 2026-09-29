import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runDraft } from "../src/agents/draft";
import { runListen } from "../src/agents/listen";
import { backoffFromHeaders, MAX_BACKOFF_SEC, MIN_BACKOFF_SEC, RateLimitError } from "../src/rate-limit";
import { RedditSource } from "../src/sources/reddit";
import type { KeyValueStore, Source } from "../src/sources/types";
import { YouTubeSource } from "../src/sources/youtube";

const longText = "Our front desk spends hours every day on insurance verification calls.";
const now = new Date("2026-09-29T12:00:00Z");
const cenv = { ...env, DAILY_BUDGET_USD: "3", CLAUDE_MODEL: "claude-haiku-4-5" };

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, get: async (k) => data.get(k) ?? null, set: async (k, v) => void data.set(k, v) };
}

function ytFetch(quota?: { status: number; reason: string }) {
  const paths: string[] = [];
  const orders: string[] = [];
  const fn = (async (url: string) => {
    const u = new URL(url);
    paths.push(u.pathname.split("/").pop()!);
    if (u.pathname.endsWith("/search")) orders.push(u.searchParams.get("order")!);
    if (quota) {
      return new Response(JSON.stringify({ error: { errors: [{ reason: quota.reason }] } }), { status: quota.status });
    }
    if (u.pathname.endsWith("/search")) {
      return new Response(JSON.stringify({ items: [{ id: { videoId: "vid1" }, snippet: { title: "T" } }] }));
    }
    return new Response(JSON.stringify({ items: [] }));
  }) as unknown as typeof fetch;
  return { fn, paths, orders };
}

describe("backoffFromHeaders", () => {
  it("uses Retry-After, clamped to sane bounds", () => {
    expect(backoffFromHeaders(new Headers({ "retry-after": "120" }), 10)).toBe(120);
    expect(backoffFromHeaders(new Headers({ "retry-after": "1" }), 10)).toBe(MIN_BACKOFF_SEC);
    expect(backoffFromHeaders(new Headers({ "retry-after": "999999" }), 10)).toBe(MAX_BACKOFF_SEC);
    expect(backoffFromHeaders(new Headers(), 300)).toBe(300);
  });
});

describe("YouTube search cache", () => {
  it("searches (relevance + date) once, then reuses the cached videos for later runs", async () => {
    const { fn, paths } = ytFetch();
    const cache = memoryStore();
    const src = new YouTubeSource("q", "k", fn, cache);
    await src.fetchRecent(null);
    await src.fetchRecent(null);
    await src.fetchRecent(null);
    expect(paths.filter((p) => p === "search")).toHaveLength(2);
    expect(paths.filter((p) => p === "commentThreads")).toHaveLength(3);
  });

  it("re-searches when the cache entry is expired or corrupt", async () => {
    const { fn, paths } = ytFetch();
    const cache = memoryStore();
    const src = new YouTubeSource("q", "k", fn, cache);
    cache.data.set(`yt-search:${src.key}`, JSON.stringify({ at: 0, videos: [{ id: "old", title: "" }] }));
    await src.fetchRecent(null);
    cache.data.set(`yt-search:${src.key}`, "not json");
    await src.fetchRecent(null);
    expect(paths.filter((p) => p === "search")).toHaveLength(3); // relevance x2, date x1 (its cache is still fresh)
  });

  it("works without a cache", async () => {
    const { fn, paths } = ytFetch();
    const src = new YouTubeSource("q", "k", fn);
    await src.fetchRecent(null);
    await src.fetchRecent(null);
    expect(paths.filter((p) => p === "search")).toHaveLength(4);
  });

  it("runs one relevance and one date-ordered search, and reads each video once", async () => {
    const { fn, paths, orders } = ytFetch();
    await new YouTubeSource("q", "k", fn).fetchRecent(null);
    expect(orders.sort()).toEqual(["date", "relevance"]);
    // both searches return the same video; it is only read once
    expect(paths.filter((p) => p === "commentThreads")).toHaveLength(1);
  });

  it("caches the date search separately from the relevance search", async () => {
    const { fn } = ytFetch();
    const cache = memoryStore();
    const src = new YouTubeSource("q", "k", fn, cache);
    await src.fetchRecent(null);
    expect([...cache.data.keys()].sort()).toEqual([`yt-search-new:${src.key}`, `yt-search:${src.key}`]);
  });
});

describe("rate limit signals", () => {
  it("YouTube quota errors and 429s become RateLimitError", async () => {
    for (const q of [
      { status: 403, reason: "quotaExceeded" },
      { status: 403, reason: "rateLimitExceeded" },
      { status: 429, reason: "unknown" },
    ]) {
      const err = await new YouTubeSource("q", "k", ytFetch(q).fn).fetchRecent(null).catch((e) => e);
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err.retryAfterSec).toBeGreaterThanOrEqual(MIN_BACKOFF_SEC);
    }
  });

  it("other YouTube 403s (bad key) stay ordinary errors", async () => {
    const err = await new YouTubeSource("q", "k", ytFetch({ status: 403, reason: "forbidden" }).fn)
      .fetchRecent(null)
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(RateLimitError);
  });

  it("Reddit 429 becomes RateLimitError with Retry-After honored", async () => {
    const fn = (async (url: string) => {
      if (url.includes("access_token")) return new Response(JSON.stringify({ access_token: "t" }));
      return new Response("slow down", { status: 429, headers: { "retry-after": "600" } });
    }) as unknown as typeof fetch;
    const err = await new RedditSource("dentistry", "id", "secret", fn).fetchRecent(null).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterSec).toBe(600);
  });
});

describe("runListen / runDraft under rate limits", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM leads"),
      env.DB.prepare("DELETE FROM drafts"),
      env.DB.prepare("DELETE FROM items"),
      env.DB.prepare("DELETE FROM api_calls"),
      env.DB.prepare("DELETE FROM budget_events"),
      env.DB.prepare("DELETE FROM cursors"),
    ]);
  });

  it("backs a rate-limited source off, without calling it again until the window passes", async () => {
    let calls = 0;
    const limited: Source = {
      key: "limited",
      fetchRecent: async () => {
        calls++;
        throw new RateLimitError("slow down", 3600);
      },
    };
    const first = await runListen(cenv, [limited], now, fetch);
    expect(first).toMatchObject({ sourceErrors: 1, sourcesBackedOff: 0 });

    const soon = await runListen(cenv, [limited], new Date(now.getTime() + 5 * 60_000), fetch);
    expect(soon).toMatchObject({ sourceErrors: 0, sourcesBackedOff: 1 });
    expect(calls).toBe(1);

    await runListen(cenv, [limited], new Date(now.getTime() + 61 * 60_000), fetch);
    expect(calls).toBe(2);
  });

  it("stops the run cleanly when Claude returns 429, keeping the item for the next run", async () => {
    const source: Source = {
      key: "s",
      fetchRecent: async () => [
        { source: "s", externalId: "a", url: "https://x/a", author: null, text: longText, createdUtc: 5 },
      ],
    };
    const throttled = (async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } })) as unknown as typeof fetch;
    const out = await runListen(cenv, [source], now, throttled);
    expect(out).toMatchObject({ stoppedByRateLimit: true, scored: 0, leads: 0 });
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    expect(row!.n).toBe(0);
    expect(await env.DB.prepare("SELECT last_seen FROM cursors WHERE source_key = 's'").first()).toBeNull();
  });

  it("draft stops cleanly on a Claude 429", async () => {
    const itemId = (
      await env.DB.prepare(
        "INSERT INTO items (source, external_id, url, author_hash, excerpt, created_utc, fetched_at) VALUES ('s','a','https://x/a',NULL,'x',1,?) RETURNING id",
      )
        .bind(now.toISOString())
        .first<{ id: number }>()
    )!.id;
    await env.DB.prepare("INSERT INTO leads (item_id, score, pain_summary, status, created_at) VALUES (?, 0.9, 'p', 'new', ?)")
      .bind(itemId, now.toISOString())
      .run();
    const throttled = (async () => new Response("{}", { status: 529 })) as unknown as typeof fetch;
    const out = await runDraft(cenv, now, throttled);
    expect(out).toEqual({ drafted: 0, stoppedByBudget: false, stoppedByRateLimit: true });
  });
});

describe("fetch invocation", () => {
  // The Workers runtime throws "Illegal invocation" if fetch is called with any `this` but the global.
  function strictFetch(body: unknown) {
    return function (this: unknown): Promise<Response> {
      if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
      return Promise.resolve(new Response(JSON.stringify(body)));
    } as unknown as typeof fetch;
  }

  it("YouTube source calls fetch without binding it to the source", async () => {
    const src = new YouTubeSource("q", "k", strictFetch({ items: [] }));
    await expect(src.fetchRecent(null)).resolves.toEqual([]);
  });

  it("Reddit source calls fetch without binding it to the source", async () => {
    const src = new RedditSource("dentistry", "id", "secret", strictFetch({ access_token: "t", data: { children: [] } }));
    await expect(src.fetchRecent(null)).resolves.toEqual([]);
  });
});
