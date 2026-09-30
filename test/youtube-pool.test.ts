import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YOUTUBE_POOL_PAGE_INTERVAL_HOURS, YOUTUBE_POOL_RESTART_DAYS, YOUTUBE_VIDEOS_PER_VISIT } from "../src/config";
import { pickDueVideos, recheckIntervalMs, YouTubeSource, type PoolVideo, type VideoState } from "../src/sources/youtube";
import { memoryStore } from "./kv";

const NOW = Date.parse("2026-09-29T12:00:00Z");
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const longText = "Our front desk spends hours every day on insurance verification calls.";

const iso = (ms: number) => new Date(ms).toISOString();
const found = (id: string, publishedMs = NOW - 2 * DAY) => ({
  id: { videoId: id },
  snippet: { title: `Title ${id}`, publishedAt: iso(publishedMs) },
});
const thread = (id: string, whenMs: number) => ({
  snippet: { topLevelComment: { id, snippet: { authorDisplayName: "A", textDisplay: longText, publishedAt: iso(whenMs) } } },
});

interface World {
  /** relevance pages by page token ("" = first page) */
  pages: Record<string, { items: unknown[]; nextPageToken?: string }>;
  newest: { items: unknown[] };
  /** comment counts as returned by videos.list; a missing id means comments are off */
  counts: Record<string, string>;
  comments: Record<string, unknown[]>;
}

function makeWorld(w: Partial<World> = {}) {
  const world: World = {
    pages: {
      "": { items: [found("a1"), found("a2")], nextPageToken: "P2" },
      P2: { items: [found("b1")], nextPageToken: "P3" },
      P3: { items: [found("c1")] },
    },
    newest: { items: [found("n1", NOW - HOUR)] },
    counts: { a1: "5", a2: "5", b1: "5", c1: "5", n1: "1" },
    comments: {},
    ...w,
  };
  const calls: { path: string; params: URLSearchParams }[] = [];
  const fn = (async (url: string) => {
    const u = new URL(url);
    const path = u.pathname.split("/").pop()!;
    calls.push({ path, params: u.searchParams });
    if (path === "search") {
      if (u.searchParams.get("order") === "date") return new Response(JSON.stringify(world.newest));
      return new Response(JSON.stringify(world.pages[u.searchParams.get("pageToken") ?? ""]));
    }
    if (path === "videos") {
      const ids = u.searchParams.get("id")!.split(",");
      const items = ids.map((id) => ({ id, statistics: id in world.counts ? { commentCount: world.counts[id] } : {} }));
      return new Response(JSON.stringify({ items }));
    }
    return new Response(JSON.stringify({ items: world.comments[u.searchParams.get("videoId")!] ?? [] }));
  }) as unknown as typeof fetch;
  const count = (path: string) => calls.filter((c) => c.path === path).length;
  const readVideos = () => calls.filter((c) => c.path === "commentThreads").map((c) => c.params.get("videoId")!);
  const relevanceTokens = () =>
    calls.filter((c) => c.path === "search" && c.params.get("order") === "relevance").map((c) => c.params.get("pageToken"));
  const dateSearches = () => calls.filter((c) => c.path === "search" && c.params.get("order") === "date").length;
  return { world, fn, calls, count, readVideos, relevanceTokens, dateSearches };
}

const video = (id: string, p: number | null = NOW - 2 * DAY): PoolVideo => ({ id, t: id, p, cc: 5 });

describe("recheck schedule and picking", () => {
  it("re-reads young videos far more often than old ones", () => {
    expect(recheckIntervalMs(NOW - DAY, NOW)).toBeLessThan(recheckIntervalMs(NOW - 20 * DAY, NOW));
    expect(recheckIntervalMs(NOW - 20 * DAY, NOW)).toBeLessThan(recheckIntervalMs(NOW - 100 * DAY, NOW));
    expect(recheckIntervalMs(NOW - 100 * DAY, NOW)).toBeLessThan(recheckIntervalMs(NOW - 900 * DAY, NOW));
  });

  it("orders: unprocessed backlog, then never-read (newest upload first), then most overdue; skips not-yet-due", () => {
    const videos = [
      video("fresh-read", NOW - DAY),
      video("never-old", NOW - 400 * DAY),
      video("never-new", NOW - DAY),
      video("backlog"),
      video("overdue-a", NOW - DAY),
      video("overdue-b", NOW - DAY),
    ];
    const states = new Map<string, VideoState>([
      ["fresh-read", { checked: NOW - HOUR, last: 1, more: false }], // 3h interval: not due
      ["backlog", { checked: NOW - HOUR, last: 1, more: true }],
      ["overdue-a", { checked: NOW - 4 * HOUR, last: 1, more: false }], // 4h of 3h
      ["overdue-b", { checked: NOW - 12 * HOUR, last: 1, more: false }], // 12h of 3h: more overdue
    ]);
    expect(pickDueVideos(videos, states, NOW, 10).map((v) => v.id)).toEqual([
      "backlog",
      "never-new",
      "never-old",
      "overdue-b",
      "overdue-a",
    ]);
    expect(pickDueVideos(videos, states, NOW, 2).map((v) => v.id)).toEqual(["backlog", "never-new"]);
  });
});

describe("YouTubeSource pools", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("takes a full page of results per search", async () => {
    const { fn, calls } = makeWorld();
    await new YouTubeSource("q", "k", fn, memoryStore()).fetchRecent(null);
    const searches = calls.filter((c) => c.path === "search");
    expect(searches).toHaveLength(2);
    for (const s of searches) expect(s.params.get("maxResults")).toBe("50");
  });

  it("drops videos with comments off, and old videos with no comments; keeps new empty ones", async () => {
    const w = makeWorld({
      pages: { "": { items: [found("ok"), found("off"), found("empty-old", NOW - 400 * DAY), found("empty-new", NOW - DAY)] } },
      counts: { ok: "3", "empty-old": "0", "empty-new": "0", n1: "1" }, // "off" has no commentCount
    });
    await new YouTubeSource("q", "k", w.fn, memoryStore()).fetchRecent(null);
    expect(w.readVideos().sort()).toEqual(["empty-new", "n1", "ok"]);
  });

  it("adds one relevance page per day up to the pool's end, and never before the interval passes", async () => {
    const w = makeWorld();
    const src = new YouTubeSource("q", "k", w.fn, memoryStore());
    await src.fetchRecent(null);
    expect(w.relevanceTokens()).toEqual([null]);

    vi.setSystemTime(NOW + (YOUTUBE_POOL_PAGE_INTERVAL_HOURS - 1) * HOUR);
    await src.fetchRecent(null);
    expect(w.relevanceTokens()).toEqual([null]);

    vi.setSystemTime(NOW + (YOUTUBE_POOL_PAGE_INTERVAL_HOURS + 1) * HOUR);
    await src.fetchRecent(null);
    expect(w.relevanceTokens()).toEqual([null, "P2"]);

    vi.setSystemTime(NOW + 2 * (YOUTUBE_POOL_PAGE_INTERVAL_HOURS + 1) * HOUR);
    await src.fetchRecent(null);
    expect(w.relevanceTokens()).toEqual([null, "P2", "P3"]);

    // page 3 has no next token: nothing more to fetch even days later
    vi.setSystemTime(NOW + 6 * DAY);
    await src.fetchRecent(null);
    expect(w.relevanceTokens()).toEqual([null, "P2", "P3"]);
  });

  it("rebuilds the best pool from page 1 after the restart period", async () => {
    const w = makeWorld();
    const src = new YouTubeSource("q", "k", w.fn, memoryStore());
    await src.fetchRecent(null);
    vi.setSystemTime(NOW + (YOUTUBE_POOL_RESTART_DAYS + 1) * DAY);
    await src.fetchRecent(null);
    expect(w.relevanceTokens()).toEqual([null, null]);
  });

  it("refreshes the newest-uploads pool every 12 hours, not before", async () => {
    const w = makeWorld();
    const src = new YouTubeSource("q", "k", w.fn, memoryStore());
    await src.fetchRecent(null);
    vi.setSystemTime(NOW + 11 * HOUR);
    await src.fetchRecent(null);
    expect(w.dateSearches()).toBe(1);
    vi.setSystemTime(NOW + 13 * HOUR);
    await src.fetchRecent(null);
    expect(w.dateSearches()).toBe(2);
  });

  it("reads at most YOUTUBE_VIDEOS_PER_VISIT videos per visit", async () => {
    const many = Array.from({ length: 30 }, (_, i) => `v${i}`);
    const w = makeWorld({
      pages: { "": { items: many.map((id) => found(id)) } },
      counts: Object.fromEntries(many.map((id) => [id, "5"])),
    });
    await new YouTubeSource("q", "k", w.fn, memoryStore()).fetchRecent(null);
    expect(w.count("commentThreads")).toBe(YOUTUBE_VIDEOS_PER_VISIT);
  });
});

describe("YouTubeSource per-video progress", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  const oneVideo = (comments: unknown[]) =>
    makeWorld({
      pages: { "": { items: [found("v")] } },
      newest: { items: [] },
      counts: { v: "9" },
      comments: { v: comments },
    });

  it("does not re-read a video until it is due, and only offers comments at or past the marker", async () => {
    const t1 = NOW - 3 * HOUR;
    const t2 = NOW - 2 * HOUR;
    const w = oneVideo([thread("c2", t2), thread("c1", t1)]);
    const src = new YouTubeSource("q", "k", w.fn, memoryStore());

    const first = await src.fetchRecent(null);
    expect(first.map((i) => i.externalId).sort()).toEqual(["yt_c1", "yt_c2"]);
    expect(first.every((i) => i.group === "v")).toBe(true);
    await src.acknowledge(first);

    // 1 hour later: a young video (3h interval) is not due, so it is not read at all
    vi.setSystemTime(NOW + HOUR);
    expect(await src.fetchRecent(null)).toEqual([]);
    expect(w.count("commentThreads")).toBe(1);

    // 4 hours later it is due. c1 is strictly older than the marker and dropped; c2 sits on the marker and is
    // re-offered (the caller dedupes it); c3 is new.
    vi.setSystemTime(NOW + 4 * HOUR);
    w.world.comments.v = [thread("c3", NOW + 3 * HOUR), thread("c2", t2), thread("c1", t1)];
    const later = await src.fetchRecent(null);
    expect(later.map((i) => i.externalId).sort()).toEqual(["yt_c2", "yt_c3"]);
  });

  it("keeps the video due when comments were not all handled, and offers the rest next time", async () => {
    const w = oneVideo([thread("c3", NOW - 3 * HOUR), thread("c2", NOW - 4 * HOUR), thread("c1", NOW - 5 * HOUR)]);
    const src = new YouTubeSource("q", "k", w.fn, memoryStore());

    const first = await src.fetchRecent(null);
    // only the oldest was handled (the run hit its item budget)
    await src.acknowledge(first.filter((i) => i.externalId === "yt_c1"));

    vi.setSystemTime(NOW + 60_000); // one minute later: far from due by age, but the backlog makes it due
    const next = await src.fetchRecent(null);
    expect(next.map((i) => i.externalId).sort()).toEqual(["yt_c1", "yt_c2", "yt_c3"]); // c1 is on the marker
    await src.acknowledge(next);

    vi.setSystemTime(NOW + 2 * 60_000);
    expect(await src.fetchRecent(null)).toEqual([]); // nothing left and not due
    expect(w.count("commentThreads")).toBe(2);
  });

  it("records a comments-off read so the video is not retried on every visit", async () => {
    const w = oneVideo([]);
    let commentCalls = 0;
    const off = (async (url: string, init: RequestInit) => {
      if (new URL(url).pathname.endsWith("/commentThreads")) {
        commentCalls++;
        return new Response(JSON.stringify({ error: { errors: [{ reason: "commentsDisabled" }] } }), { status: 403 });
      }
      return w.fn(url, init);
    }) as unknown as typeof fetch;
    const src = new YouTubeSource("q", "k", off, memoryStore());
    expect(await src.fetchRecent(null)).toEqual([]);
    await src.acknowledge([]);
    vi.setSystemTime(NOW + 60_000);
    expect(await src.fetchRecent(null)).toEqual([]);
    expect(commentCalls).toBe(1);
  });
});
