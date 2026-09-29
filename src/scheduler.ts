import { runDraft } from "./agents/draft";
import { runListen } from "./agents/listen";
import { SUBREDDITS, YOUTUBE_QUERIES } from "./config";
import { sendDigest } from "./digest/send";
import type { Env } from "./env";
import { RedditSource } from "./sources/reddit";
import type { Source } from "./sources/types";
import { YouTubeSource } from "./sources/youtube";

// Must match "triggers.crons" in wrangler.jsonc.
export const CRON_AGENTS = "0 */3 * * *";
export const CRON_DIGEST = "0 13 * * *";

/** A source is enabled only when its credentials are configured. */
export function buildSources(env: Env, fetchFn: typeof fetch = fetch): Source[] {
  const sources: Source[] = [];
  if (env.REDDIT_CLIENT_ID && env.REDDIT_CLIENT_SECRET) {
    for (const s of SUBREDDITS) {
      sources.push(new RedditSource(s, env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, fetchFn));
    }
  }
  if (env.YOUTUBE_API_KEY) {
    for (const q of YOUTUBE_QUERIES) sources.push(new YouTubeSource(q, env.YOUTUBE_API_KEY, fetchFn));
  }
  return sources;
}

export interface SchedulerDeps {
  sources?: Source[];
  fetchFn?: typeof fetch;
  now?: Date;
}

/** Runs the job for one cron expression. Nothing here sends or posts to anyone but the owner's digest. */
export async function runScheduled(cron: string, env: Env, deps: SchedulerDeps = {}): Promise<void> {
  const now = deps.now ?? new Date();
  const fetchFn = deps.fetchFn ?? fetch;

  if (cron === CRON_AGENTS) {
    const sources = deps.sources ?? buildSources(env, fetchFn);
    if (sources.length === 0) console.warn("No sources configured: set REDDIT_* and/or YOUTUBE_API_KEY");
    const listen = await runListen(env, sources, now, fetchFn);
    const draft = await runDraft(env, now, fetchFn);
    console.log(JSON.stringify({ job: "agents", listen, draft }));
  } else if (cron === CRON_DIGEST) {
    await sendDigest(env, now);
    console.log(JSON.stringify({ job: "digest", ok: true }));
  } else {
    console.warn(`Unknown cron "${cron}"`);
  }
}
