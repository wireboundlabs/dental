import { BROAD_SUBREDDIT_KEYWORDS } from "../config";
import { RateLimitError, backoffFromHeaders } from "../rate-limit";
import type { Source, SourceItem } from "./types";

const USER_AGENT = "cloudflare-worker:customer-discovery:v0.1 (read-only research)";
const API_TIMEOUT_MS = 15000;

interface RedditListing {
  data: {
    children: {
      kind: string;
      data: {
        id: string;
        name: string;
        author?: string;
        title?: string;
        selftext?: string;
        body?: string;
        permalink: string;
        created_utc: number;
      };
    }[];
  };
}

/**
 * Read-only Reddit source using the official API (app-only OAuth).
 * The only non-GET request is the OAuth token exchange; it sends credentials, never content.
 */
export class RedditSource implements Source {
  readonly key: string;
  private token: string | null = null;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly subreddit: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    fetchFn: typeof fetch = fetch,
  ) {
    // Call fetch as a plain function: invoking the global as a method of this class throws "Illegal invocation" on Workers.
    this.fetchFn = (input, init) => fetchFn(input, init);
    this.key = `reddit:${subreddit}`;
  }

  private async getToken(): Promise<string> {
    if (this.token) return this.token;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await this.fetchFn("https://www.reddit.com/api/v1/access_token", {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": USER_AGENT,
        },
        body: "grant_type=client_credentials",
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (res.status === 429) {
        throw new RateLimitError("Reddit token error 429", backoffFromHeaders(res.headers, 300));
      }
      if (!res.ok) throw new Error(`Reddit token error ${res.status}`);
      const json = (await res.json()) as { access_token?: string };
      if (!json.access_token) throw new Error("Reddit token response missing access_token");
      this.token = json.access_token;
      return this.token;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Reddit API timeout after ${API_TIMEOUT_MS}ms`);
      }
      throw err;
    }
  }

  private async get(path: string): Promise<RedditListing> {
    const token = await this.getToken();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
    try {
      const res = await this.fetchFn(`https://oauth.reddit.com${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      // Reddit allows ~100 requests/min per client; we use a handful per run, but honor a 429 if it comes.
      if (res.status === 429) {
        throw new RateLimitError(`Reddit API error 429 for ${path}`, backoffFromHeaders(res.headers, 300));
      }
      if (!res.ok) throw new Error(`Reddit API error ${res.status} for ${path}`);
      return (await res.json()) as RedditListing;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Reddit API timeout after ${API_TIMEOUT_MS}ms`);
      }
      throw err;
    }
  }

  async fetchRecent(sinceUtc: number | null): Promise<SourceItem[]> {
    await this.getToken(); // once, before the parallel fetches
    const [posts, comments] = await Promise.all([
      this.get(`/r/${this.subreddit}/new?limit=50&raw_json=1`),
      this.get(`/r/${this.subreddit}/comments?limit=50&raw_json=1`),
    ]);
    const keywords = BROAD_SUBREDDIT_KEYWORDS[this.subreddit];
    const items: SourceItem[] = [];
    for (const child of [...posts.data.children, ...comments.data.children]) {
      const d = child.data;
      const body = (d.selftext ?? d.body ?? "").trim();
      if (body === "[removed]" || body === "[deleted]") continue;
      const text = [d.title, body].filter(Boolean).join("\n\n").trim();
      if (!text) continue;
      if (sinceUtc !== null && d.created_utc <= sinceUtc) continue;
      if (keywords && !keywords.some((k) => text.toLowerCase().includes(k))) continue;
      items.push({
        source: this.key,
        externalId: d.name,
        url: `https://www.reddit.com${d.permalink}`,
        author: d.author ?? null,
        text,
        createdUtc: Math.floor(d.created_utc),
      });
    }
    return items;
  }
}
