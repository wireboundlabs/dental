import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runListen } from "../src/agents/listen";
import { buildSources } from "../src/scheduler";
import type { Env } from "../src/env";
import { YouTubeSource } from "../src/sources/youtube";
import type { Source } from "../src/sources/types";

const KEY = "AIza-test-key";
const longText = "Our front desk spends hours every day on insurance verification calls.";

type Req = { url: string; method: string; headers: Record<string, string> };

function ytFetch(opts: { disabledFor?: string[]; failWith?: { status: number; reason: string } } = {}) {
  const log: Req[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    log.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string> });
    if (opts.failWith) {
      return new Response(JSON.stringify({ error: { errors: [{ reason: opts.failWith.reason }] } }), {
        status: opts.failWith.status,
      });
    }
    const u = new URL(url);
    if (u.pathname.endsWith("/search")) {
      return new Response(
        JSON.stringify({
          items: [
            { id: { videoId: "vid1" }, snippet: { title: "Dental insurance tips" } },
            { id: { videoId: "vid2" }, snippet: { title: "Comments off video" } },
            { id: {}, snippet: { title: "channel result, no video id" } },
          ],
        }),
      );
    }
    if (u.pathname.endsWith("/videos")) {
      const ids = u.searchParams.get("id")!.split(",");
      return new Response(JSON.stringify({ items: ids.map((id) => ({ id, statistics: { commentCount: "5" } })) }));
    }
    const videoId = u.searchParams.get("videoId")!;
    if (opts.disabledFor?.includes(videoId)) {
      return new Response(JSON.stringify({ error: { errors: [{ reason: "commentsDisabled" }] } }), { status: 403 });
    }
    return new Response(
      JSON.stringify({
        items: [
          { snippet: { topLevelComment: { id: "c_new", snippet: { authorDisplayName: "Dr A", textDisplay: longText, publishedAt: "2026-09-29T10:00:00Z" } } } },
          { snippet: { topLevelComment: { id: "c_old", snippet: { authorDisplayName: "Dr B", textDisplay: longText, publishedAt: "2026-01-01T00:00:00Z" } } } },
          { snippet: { topLevelComment: { id: "c_short", snippet: { authorDisplayName: "C", textDisplay: "nice", publishedAt: "2026-09-29T11:00:00Z" } } } },
        ],
      }),
    );
  }) as unknown as typeof fetch;
  return { fn, log };
}

describe("YouTubeSource", () => {
  it("returns recent, long-enough comments with the video title as context", async () => {
    const { fn } = ytFetch({ disabledFor: ["vid2"] });
    const items = await new YouTubeSource("dental insurance", KEY, fn).fetchRecent(null);
    expect(items.map((i) => i.externalId).sort()).toEqual(["yt_c_new", "yt_c_old"]);
    const item = items.find((i) => i.externalId === "yt_c_new")!;
    expect(item.text).toContain("Dental insurance tips");
    expect(item.text).toContain("insurance verification");
    expect(item.url).toBe("https://www.youtube.com/watch?v=vid1&lc=c_new");
    expect(item.createdUtc).toBe(Math.floor(Date.parse("2026-09-29T10:00:00Z") / 1000));
  });

  it("ignores the run-wide cursor: progress is tracked per video instead", async () => {
    const { fn } = ytFetch({ disabledFor: ["vid2"] });
    const since = Math.floor(Date.parse("2026-06-01T00:00:00Z") / 1000);
    const items = await new YouTubeSource("q", KEY, fn).fetchRecent(since);
    expect(items.map((i) => i.externalId).sort()).toEqual(["yt_c_new", "yt_c_old"]);
  });

  it("skips videos with comments disabled and results without a video id", async () => {
    const { fn, log } = ytFetch({ disabledFor: ["vid1", "vid2"] });
    expect(await new YouTubeSource("q", KEY, fn).fetchRecent(null)).toEqual([]);
    expect(log.filter((r) => r.url.includes("commentThreads"))).toHaveLength(2); // vid1, vid2 only
  });

  it("only issues GETs and keeps the API key out of URLs", async () => {
    const { fn, log } = ytFetch({ disabledFor: ["vid2"] });
    await new YouTubeSource("q", KEY, fn).fetchRecent(null);
    expect(log.length).toBeGreaterThan(1);
    for (const r of log) {
      expect(r.method).toBe("GET");
      expect(r.url).not.toContain(KEY);
      expect(r.url).not.toContain("key=");
      expect(r.headers["x-goog-api-key"]).toBe(KEY);
    }
  });

  it("throws on quota errors, with a message that contains no key or URL", async () => {
    const { fn } = ytFetch({ failWith: { status: 403, reason: "quotaExceeded" } });
    await expect(new YouTubeSource("q", KEY, fn).fetchRecent(null)).rejects.toThrow(
      /^YouTube API error 403 \(quotaExceeded\)$/,
    );
  });

  it("derives a stable, safe cursor key from the query", () => {
    expect(new YouTubeSource("Dentrix vs. Eaglesoft!", KEY).key).toBe("youtube:dentrix-vs-eaglesoft");
  });
});

describe("source selection and isolation", () => {
  const base = { ...env, REDDIT_CLIENT_ID: undefined, REDDIT_CLIENT_SECRET: undefined, YOUTUBE_API_KEY: undefined } as unknown as Env;

  it("enables sources only when their credentials are set", () => {
    expect(buildSources(base)).toHaveLength(0);
    expect(buildSources({ ...base, YOUTUBE_API_KEY: "k" }).every((s) => s.key.startsWith("youtube:"))).toBe(true);
    expect(buildSources({ ...base, REDDIT_CLIENT_ID: "id" })).toHaveLength(0); // needs both
    const reddit = buildSources({ ...base, REDDIT_CLIENT_ID: "id", REDDIT_CLIENT_SECRET: "s" });
    expect(reddit.length).toBeGreaterThan(0);
    expect(reddit.every((s) => s.key.startsWith("reddit:"))).toBe(true);
  });

  describe("runListen", () => {
    beforeEach(async () => {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM leads"),
        env.DB.prepare("DELETE FROM items"),
        env.DB.prepare("DELETE FROM api_calls"),
        env.DB.prepare("DELETE FROM budget_events"),
        env.DB.prepare("DELETE FROM cursors"),
      ]);
    });

    it("a failing source does not stop the others", async () => {
      const broken: Source = { key: "broken", fetchRecent: async () => { throw new Error("boom"); } };
      const good: Source = {
        key: "good",
        fetchRecent: async () => [
          { source: "good", externalId: "g1", url: "https://x/1", author: null, text: longText, createdUtc: 5 },
        ],
      };
      const claude = (async () =>
        new Response(
          JSON.stringify({
            content: [{ type: "text", text: '{"relevance":0.9,"pain_summary":"insurance","patient_info_present":false}' }],
            usage: { input_tokens: 100, output_tokens: 20 },
          }),
        )) as unknown as typeof fetch;
      const cenv = { ...env, DAILY_BUDGET_USD: "3", CLAUDE_MODEL: "claude-haiku-4-5" };
      const out = await runListen(cenv, [broken, good], new Date("2026-09-29T12:00:00Z"), claude);
      expect(out).toMatchObject({ sourceErrors: 1, leads: 1 });
    });
  });
});
