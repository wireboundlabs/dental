/** Cloudflare Email Service binding (send_email). */
export interface EmailSender {
  send(message: { to: string; from: string; subject: string; text: string }): Promise<unknown>;
}

export interface Env {
  EMAIL: EmailSender;
  DB: D1Database;
  // Non-secret vars (wrangler.jsonc)
  DAILY_BUDGET_USD: string;
  CLAUDE_MODEL: string;
  DIGEST_FROM: string;
  // Secrets (wrangler secret put)
  ANTHROPIC_API_KEY: string;
  // Each source is enabled only if its credentials are set.
  REDDIT_CLIENT_ID?: string;
  REDDIT_CLIENT_SECRET?: string;
  YOUTUBE_API_KEY?: string;
  ACCESS_AUD: string;
  ACCESS_TEAM_DOMAIN: string;
  OWNER_EMAIL: string;
  /** Local dev only: skip Access when set to "1" and host is localhost. Never set in production. */
  ACCESS_DEV_BYPASS?: string;
}
