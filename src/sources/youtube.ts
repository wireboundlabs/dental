import { MIN_TEXT_LENGTH, YOUTUBE_COMMENTS_PER_VIDEO, YOUTUBE_VIDEOS_PER_QUERY } from "../config";
import type { Source, SourceItem } from "./types";

const API = "https://www.googleapis.com/youtube/v3";

class YouTubeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly reason: string,
  ) {
    super(`YouTube API error ${status} (${reason})`);
  }
}

interface SearchResponse {
  items?: { id?: { videoId?: string }; snippet?: { title?: string } }[];
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

/**
 * Read-only YouTube source (official Data API v3, GET only).
 * Finds videos matching a search query, then reads their most recent top-level comments.
 * The API key is sent in a header, never in the URL, so it cannot leak through logs or errors.
 */
export class YouTubeSource implements Source {
  readonly key: string;

  constructor(
    private readonly query: string,
    private readonly apiKey: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.key = `youtube:${query
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)}`;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const res = await this.fetchFn(`${API}/${path}?${new URLSearchParams(params)}`, {
      method: "GET",
      headers: { "x-goog-api-key": this.apiKey },
    });
    if (!res.ok) {
      let reason = "unknown";
      try {
        const body = (await res.json()) as { error?: { errors?: { reason?: string }[] } };
        reason = body.error?.errors?.[0]?.reason ?? reason;
      } catch {
        // non-JSON error body
      }
      throw new YouTubeApiError(res.status, reason);
    }
    return (await res.json()) as T;
  }

  async fetchRecent(sinceUtc: number | null): Promise<SourceItem[]> {
    const search = await this.get<SearchResponse>("search", {
      part: "snippet",
      type: "video",
      q: this.query,
      maxResults: String(YOUTUBE_VIDEOS_PER_QUERY),
      relevanceLanguage: "en",
    });
    const videos = (search.items ?? []).flatMap((i) =>
      i.id?.videoId ? [{ id: i.id.videoId, title: i.snippet?.title ?? "" }] : [],
    );

    const items: SourceItem[] = [];
    for (const video of videos) {
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
        // Comments turned off on a video is normal; anything else (quota, bad key) is not.
        if (err instanceof YouTubeApiError && err.reason === "commentsDisabled") continue;
        throw err;
      }
      for (const t of threads.items ?? []) {
        const c = t.snippet?.topLevelComment;
        const body = c?.snippet?.textDisplay?.trim();
        const published = c?.snippet?.publishedAt ? Date.parse(c.snippet.publishedAt) : NaN;
        if (!c || !body || Number.isNaN(published) || body.length < MIN_TEXT_LENGTH) continue;
        const createdUtc = Math.floor(published / 1000);
        if (sinceUtc !== null && createdUtc <= sinceUtc) continue;
        items.push({
          source: this.key,
          externalId: `yt_${c.id}`,
          url: `https://www.youtube.com/watch?v=${video.id}&lc=${c.id}`,
          author: c.snippet?.authorDisplayName ?? null,
          text: `[Comment on video: ${video.title}]\n${body}`,
          createdUtc,
        });
      }
    }
    return items;
  }
}
