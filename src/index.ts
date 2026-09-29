import { runDraft } from "./agents/draft";
import { runListen } from "./agents/listen";
import { SUBREDDITS } from "./config";
import { handleDashboard } from "./dashboard/routes";
import { sendDigest } from "./digest/send";
import type { Env } from "./env";
import { RedditSource } from "./sources/reddit";
import type { Source } from "./sources/types";

// Must match "triggers.crons" in wrangler.jsonc.
export const CRON_AGENTS = "0 */3 * * *";
export const CRON_DIGEST = "0 13 * * *";

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
    const sources =
      deps.sources ??
      SUBREDDITS.map((s) => new RedditSource(s, env.REDDIT_CLIENT_ID, env.REDDIT_CLIENT_SECRET, fetchFn));
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

export default {
  fetch(request, env) {
    return handleDashboard(request, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runScheduled(event.cron, env).catch((err) => {
        // Log the message only; never log request bodies or secrets.
        console.error(`Scheduled job "${event.cron}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
