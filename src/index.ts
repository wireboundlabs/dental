import { handleDashboard } from "./dashboard/routes";
import type { Env } from "./env";
import { runScheduled } from "./scheduler";

// Only the default export lives here: workerd treats every named export of the entry module as an entrypoint.
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
