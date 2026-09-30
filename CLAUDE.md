# Customer Discovery System

Cloudflare Workers project (TypeScript, Wrangler, D1, Cron Triggers). Finds independent dental offices discussing a problem we may help with, scores them with Claude Haiku 4.5, drafts human-review replies, and emails the owner a daily digest.

## Hard rules (do not violate, do not "improve" away)
1. **Nothing is ever sent or posted automatically.** No posting or commenting to Reddit or any other site, and no emails to prospects. There must be no code path that does so. A human reviews drafts in the dashboard and sends them manually. "Approved" and "sent" are status flags only.
2. **Read-only source access, official APIs only.** Source clients (`src/sources/*`) use GET requests only, with one exception: the OAuth token exchange (`POST /api/v1/access_token`), which sends credentials and never content (a test enforces this). No scraping, no unofficial endpoints, no logged-in browsing.
3. **Only outbound email is the daily digest to `OWNER_EMAIL`.** Never add another recipient.
4. **Secrets only via `wrangler secret put`** (local: `.dev.vars`, which is gitignored). Never put secrets in code, `wrangler.jsonc`, tests, fixtures, docs, or commits. `wrangler.jsonc` `vars` are for non-secret config only.
5. **Every Claude API call goes through `src/claude/client.ts`**, which checks the budget before the call and records cost in D1 after it. Never call the Anthropic API directly elsewhere. Daily spend hard-stops at `DAILY_BUDGET_USD` (default $3, UTC day). The digest reports when the cap was hit.
6. **Dashboard is protected by Cloudflare Access**, and the Worker also verifies the Access JWT and fails closed.
7. **Privacy:** dental posts may mention patients. Never store or draft using patient details; store only a short excerpt and the pain summary. The commenter's public display name is stored in plain text only for items that become leads (so the owner can find the comment to reply); every other item keeps just an author hash.
8. Drafts are curious and non-pitching, written in the owner's voice (see `src/config.ts`). No links, no product mentions.

## Architecture
- `src/index.ts`: entry point (default export only); `src/scheduler.ts` holds the cron routing. `fetch` handler (dashboard) and `scheduled` handler that routes by cron expression: every 15 minutes runs listen then draft (see the quota math in `src/config.ts` before changing it); daily 13:00 UTC runs the digest.
- `src/sources/`: read-only sources behind the `Source` interface: Reddit (needs Reddit approval) and YouTube Data API comments. A source is enabled only if its secrets are set (`buildSources` in `src/scheduler.ts`). A failing source is logged and skipped; it never stops the others. YouTube quota is 10,000 units/day free; see the math in `src/config.ts`. YouTube keeps per-query video pools (best + newest) and a per-video progress marker in the `cursors` table; sources are visited round-robin (`MAX_SOURCES_PER_RUN`) and may implement `acknowledge()` so progress only advances past handled items.
- `src/agents/listen.ts`: pull items from sources, dedupe, score with Haiku, store qualified leads.
- `src/agents/draft.ts`: draft replies/emails for new leads, stored as `pending`.
- `src/claude/`: Messages API wrapper plus pricing. `src/budget.ts`: spend guard.
- `src/db/queries.ts`: all D1 access, parameterized. No SQL elsewhere.
- `src/dashboard/`: server-rendered approval UI. `src/digest/`: daily email.
- Schema lives in `migrations/`. Tables: items, leads, drafts, api_calls, budget_events, cursors.

## Commands
- `npm test` (Vitest with the Workers pool, in-memory D1), `npm run typecheck`
- `npm run dev` (wrangler dev with scheduled testing)
- `npm run db:migrate:local` / `db:migrate:remote`

## Conventions
- Add tests for scoring, budget guard, and D1 queries whenever they change. Run tests after each change.
- Mock `fetch` for Reddit and Anthropic in tests. Tests never hit the network.
- Keep niche, problem statement, subreddits, thresholds, and voice guide in `src/config.ts`.

## Deploy runbook (manual, done by the owner)
1. `npx wrangler d1 create customer-discovery`, then paste the `database_id` into `wrangler.jsonc`.
2. Edit `wrangler.jsonc`: set `send_email[0].allowed_destination_addresses` to the owner's verified address, and `DIGEST_FROM` to a sender on a domain verified in Cloudflare Email Service.
3. `npm run db:migrate:remote`
4. Secrets, one at a time (prompted, never on the command line or in files): `npx wrangler secret put ANTHROPIC_API_KEY`, `OWNER_EMAIL`, and whichever sources you use: `YOUTUBE_API_KEY` and/or `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET`, `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` (like `yourteam.cloudflareaccess.com`).
5. `npm run deploy`, then in Zero Trust create a self-hosted Access application for the Worker's hostname with a policy allowing only the owner's email. Copy its AUD tag into the `ACCESS_AUD` secret.
6. Do not set `ACCESS_DEV_BYPASS` in production. For local dev, copy `.dev.vars.example` to `.dev.vars` (gitignored).

## Testing notes
- Vitest 3 + `@cloudflare/vitest-pool-workers` 0.10.x. Do not upgrade to vitest 4 / pool 0.22 without checking: on this Windows setup it failed to run tests at all.
- Install with `npm install --legacy-peer-deps` (npm's resolver crashes on the peer set otherwise).
- "EBUSY ... Unable to remove temporary directory" lines after test runs are harmless Windows cleanup noise.
