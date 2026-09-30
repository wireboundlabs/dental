import {
  MIN_TEXT_LENGTH,
  YOUTUBE_COMMENTS_PER_VIDEO,
  YOUTUBE_EMPTY_VIDEO_MAX_AGE_DAYS,
  YOUTUBE_NEW_POOL_REFRESH_HOURS,
  YOUTUBE_POOL_MAX_PAGES,
  YOUTUBE_POOL_PAGE_INTERVAL_HOURS,
  YOUTUBE_POOL_PAGE_SIZE,
  YOUTUBE_POOL_RESTART_DAYS,
  YOUTUBE_RECHECK_TIERS,
  YOUTUBE_VIDEOS_PER_VISIT,
} from "../config";
import { RateLimitError, backoffFromHeaders } from "../rate-limit";
import type { KeyValueStore, Source, SourceItem } from "./types";

const API = "https://www.googleapis.com/youtube/v3";
const API_TIMEOUT_MS = 15000;

/** 403 reasons that mean "out of quota / too fast" rather than "bad request or bad key". */
const RATE_LIMIT_REASONS = new Set(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "userRateLimitExceeded"]);

/** Rejected calls cost no quota, so retrying hourly is cheap; the daily quota resets at midnight Pacific. */
const QUOTA_BACKOFF_SEC = 3600;

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

class YouTubeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
  ) {
    super(`YouTube API error ${status} (${reason})`);
  }
}

/** A video in a pool. `p` is the upload time (ms) and `cc` the comment count when the pool page was fetched. */
export interface PoolVideo {
  id: string;
  t: string;
  p: number | null;
  cc: number;
}

interface Pool {
  started: number;
  at: number;
  page: number;
  next: string | null;
  videos: PoolVideo[];
}

/** Per-video progress. `last` is the newest comment time (s) fully handled; `more` means some are still waiting. */
export interface VideoState {
  checked: number;
  last: number;
  more: boolean;
}

interface SearchResponse {
  nextPageToken?: string;
  items?: { id?: { videoId?: string }; snippet?: { title?: string; publishedAt?: string } }[];
}

interface VideoStatsResponse {
  items?: { id?: string; statistics?: { commentCount?: string } }[];
}

interface CommentThreadsResponse {
  items?: {
    snippet?: {
      videoId?: string;
      topLevelComment?: {
        id: string;
        snippet?: { authorDisplayName?: string; textDisplay?: string; publishedAt?: string };
      };
    };
  }[];
}

/** How long to wait before re-reading a video, by how old it is. */
export function recheckIntervalMs(publishedMs: number | null, now: number): number {
  const ageDays = publishedMs === null ? 0 : Math.max(0, (now - publishedMs) / DAY_MS);
  const tier = YOUTUBE_RECHECK_TIERS.find((t) => ageDays <= t.maxAgeDays) ?? YOUTUBE_RECHECK_TIERS.at(-1)!;
  return tier.hours * HOUR_MS;
}

/**
 * Which videos to read this visit: ones with unprocessed comments first, then never-read ones (newest upload
 * first), then whichever are most overdue for a re-read. Videos not yet due are left alone.
 */
export function pickDueVideos(
  videos: PoolVideo[],
  states: Map<string, VideoState>,
  now: number,
  limit: number,
): PoolVideo[] {
  const ranked: { v: PoolVideo; rank: number; score: number }[] = [];
  for (const v of videos) {
    const st = states.get(v.id);
    if (st?.more) ranked.push({ v, rank: 0, score: v.p ?? 0 });
    else if (!st) ranked.push({ v, rank: 1, score: v.p ?? 0 });
    else {
      const ratio = (now - st.checked) / recheckIntervalMs(v.p, now);
      if (ratio >= 1) ranked.push({ v, rank: 2, score: ratio });
    }
  }
  ranked.sort((a, b) => a.rank - b.rank || b.score - a.score);
  return ranked.slice(0, limit).map((r) => r.v);
}

function dedupe(videos: PoolVideo[]): PoolVideo[] {
  const seen = new Set<string>();
  return videos.filter((v) => !seen.has(v.id) && !!seen.add(v.id));
}

/**
 * Read-only YouTube source (official Data API v3, GET only).
 * Keeps pools of videos for a search query and reads the newest top-level comments of the ones that are due.
 * The API key is sent in a header, never in the URL, so it cannot leak through logs or errors.
 */
export class YouTubeSource implements Source {
  readonly key: string;
  private readonly fetchFn: typeof fetch;
  /** Videos read by the last fetchRecent, waiting for acknowledge() to record progress. */
  private reads = new Map<string, { prev: VideoState; returned: SourceItem[] }>();

  constructor(
    private readonly query: string,
    private readonly apiKey: string,
    fetchFn: typeof fetch = fetch,
    private readonly cache: KeyValueStore | null = null,
  ) {
    // Call fetch as a plain function: invoking the global as a method of this class throws "Illegal invocation" on Workers.
    this.fetchFn = (input, init) => fetchFn(input, init);
    this.key = `youtube:${query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)}`;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(`${API}/${path}?${new URLSearchParams(params)}`, {
        method: "GET",
        headers: { "x-goog-api-key": this.apiKey },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        let reason = "unknown";
        try {
          const body = (await res.json()) as { error?: { errors?: { reason?: string }[] } };
          reason = body.error?.errors?.[0]?.reason ?? reason;
        } catch {
          // non-JSON error body
        }
        const err = new YouTubeApiError(res.status, reason);
        if (res.status === 429 || (res.status === 403 && RATE_LIMIT_REASONS.has(reason))) {
          throw new RateLimitError(err.message, backoffFromHeaders(res.headers, QUOTA_BACKOFF_SEC));
        }
        throw err;
      }
      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`YouTube API timeout after ${API_TIMEOUT_MS}ms`);
      }
      throw err;
    }
  }

  private async load<T>(key: string): Promise<T | null> {
    if (!this.cache) return null;
    try {
      return JSON.parse((await this.cache.get(key)) ?? "null") as T | null;
    } catch {
      return null; // corrupt entry: treated as missing
    }
  }

  private async save(key: string, value: unknown): Promise<void> {
    if (this.cache) await this.cache.set(key, JSON.stringify(value));
  }

  /**
   * One search page (100 quota units however many results) plus one stats call (1 unit) for its videos.
   * Videos whose comments are off, or that have no comments and are old, are dropped.
   */
  private async fetchPage(
    order: "relevance" | "date",
    pageToken: string | null,
    now: number,
  ): Promise<{ videos: PoolVideo[]; next: string | null }> {
    const params: Record<string, string> = {
      part: "snippet",
      type: "video",
      q: this.query,
      order,
      maxResults: String(YOUTUBE_POOL_PAGE_SIZE),
      relevanceLanguage: "en",
    };
    if (pageToken) params.pageToken = pageToken;
    const search = await this.get<SearchResponse>("search", params);
    const found = (search.items ?? []).flatMap((i) => {
      if (!i.id?.videoId) return [];
      const p = i.snippet?.publishedAt ? Date.parse(i.snippet.publishedAt) : NaN;
      return [{ id: i.id.videoId, t: i.snippet?.title ?? "", p: Number.isNaN(p) ? null : p }];
    });
    const next = search.nextPageToken ?? null;
    if (found.length === 0) return { videos: [], next };

    const stats = await this.get<VideoStatsResponse>("videos", {
      part: "statistics",
      id: found.map((v) => v.id).join(","),
    });
    const counts = new Map<string, number>();
    for (const it of stats.items ?? []) {
      const n = it.statistics?.commentCount === undefined ? NaN : Number(it.statistics.commentCount);
      if (it.id && !Number.isNaN(n)) counts.set(it.id, n);
    }
    const videos = found.flatMap((v) => {
      const cc = counts.get(v.id);
      if (cc === undefined) return []; // comments off, private or gone
      const ageDays = v.p === null ? 0 : (now - v.p) / DAY_MS;
      if (cc === 0 && ageDays > YOUTUBE_EMPTY_VIDEO_MAX_AGE_DAYS) return [];
      return [{ ...v, cc }];
    });
    return { videos, next };
  }

  /** Refreshes the pools when due (at most two searches) and returns every candidate video. */
  private async candidateVideos(now: number): Promise<PoolVideo[]> {
    const bestKey = `yt-pool:${this.key}`;
    const newKey = `yt-new:${this.key}`;
    let best = await this.load<Pool>(bestKey);
    let fresh = await this.load<Pool>(newKey);

    if (!best || now - best.started > YOUTUBE_POOL_RESTART_DAYS * DAY_MS) {
      const page = await this.fetchPage("relevance", null, now);
      best = { started: now, at: now, page: 1, next: page.next, videos: page.videos };
      await this.save(bestKey, best);
    } else if (best.next && best.page < YOUTUBE_POOL_MAX_PAGES && now - best.at > YOUTUBE_POOL_PAGE_INTERVAL_HOURS * HOUR_MS) {
      const page = await this.fetchPage("relevance", best.next, now);
      best = { ...best, at: now, page: best.page + 1, next: page.next, videos: dedupe([...best.videos, ...page.videos]) };
      await this.save(bestKey, best);
    }

    if (!fresh || now - fresh.at > YOUTUBE_NEW_POOL_REFRESH_HOURS * HOUR_MS) {
      const page = await this.fetchPage("date", null, now);
      fresh = { started: now, at: now, page: 1, next: null, videos: page.videos };
      await this.save(newKey, fresh);
    }
    return dedupe([...fresh.videos, ...best.videos]);
  }

  private async loadStates(videos: PoolVideo[]): Promise<Map<string, VideoState>> {
    const states = new Map<string, VideoState>();
    if (!this.cache) return states;
    const raw = await this.cache.getMany(videos.map((v) => `yt-video:${v.id}`));
    for (const v of videos) {
      const text = raw.get(`yt-video:${v.id}`);
      if (!text) continue;
      try {
        const st = JSON.parse(text) as VideoState;
        if (typeof st.checked === "number" && typeof st.last === "number") states.set(v.id, { ...st, more: !!st.more });
      } catch {
        // corrupt entry: the video is simply read again
      }
    }
    return states;
  }

  /** Comments newer than each video's own marker. The run-wide cursor is ignored: it would hide new videos' older comments. */
  async fetchRecent(_sinceUtc: number | null): Promise<SourceItem[]> {
    const now = Date.now();
    const videos = await this.candidateVideos(now);
    const states = await this.loadStates(videos);
    const due = pickDueVideos(videos, states, now, YOUTUBE_VIDEOS_PER_VISIT);

    this.reads.clear();
    const items: SourceItem[] = [];
    for (const video of due) {
      const prev = states.get(video.id) ?? { checked: 0, last: 0, more: false };
      let threads: CommentThreadsResponse;
      try {
        threads = await this.get<CommentThreadsResponse>("commentThreads", {
          part: "snippet",
          videoId: video.id,
          order: "time",
          maxResults: String(YOUTUBE_COMMENTS_PER_VIDEO),
          textFormat: "plainText",
        });
      } catch (err) {
        // Comments off, or a video since deleted, is normal; anything else (bad key) is not.
        if (err instanceof YouTubeApiError && (err.reason === "commentsDisabled" || err.status === 404)) {
          this.reads.set(video.id, { prev, returned: [] });
          continue;
        }
        throw err;
      }
      const returned: SourceItem[] = [];
      for (const t of threads.items ?? []) {
        const c = t.snippet?.topLevelComment;
        const body = c?.snippet?.textDisplay?.trim();
        const published = c?.snippet?.publishedAt ? Date.parse(c.snippet.publishedAt) : NaN;
        if (!c || !body || Number.isNaN(published) || body.length < MIN_TEXT_LENGTH) continue;
        const createdUtc = Math.floor(published / 1000);
        if (createdUtc < prev.last) continue; // strictly older than what is already handled
        returned.push({
          source: this.key,
          externalId: `yt_${c.id}`,
          url: `https://www.youtube.com/watch?v=${video.id}&lc=${c.id}`,
          author: c.snippet?.authorDisplayName ?? null,
          text: `[Comment on video: ${video.t}]\n${body}`,
          createdUtc,
          group: video.id,
        });
      }
      this.reads.set(video.id, { prev, returned });
      items.push(...returned);
    }
    return items;
  }

  /** Records progress only past comments that were actually handled; anything left over keeps the video "due". */
  async acknowledge(processed: SourceItem[]): Promise<void> {
    const done = new Set(processed.map((i) => i.externalId));
    const now = Date.now();
    for (const [id, { prev, returned }] of this.reads) {
      const handled = returned.filter((i) => done.has(i.externalId));
      const state: VideoState = {
        checked: now,
        last: Math.max(prev.last, ...handled.map((i) => i.createdUtc)),
        more: handled.length < returned.length,
      };
      await this.save(`yt-video:${id}`, state);
    }
    this.reads.clear();
  }
}
