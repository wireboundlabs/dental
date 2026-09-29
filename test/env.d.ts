import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    ANTHROPIC_API_KEY: string;
    DAILY_BUDGET_USD: string;
    CLAUDE_MODEL: string;
    TEST_MIGRATIONS: D1Migration[];
  }
}
