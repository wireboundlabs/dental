# Agent Guide: Customer Discovery System

Cloudflare Workers TypeScript project for finding and engaging dental prospects. Read `CLAUDE.md` first — it contains **hard product and safety rules** that must never be violated (no auto-posting/emailing, secrets handling, Claude budget, Access JWT, privacy, read-only sources, etc.).

## Quick Start

```bash
npm install --legacy-peer-deps
npm test
npm run typecheck
```

## Risk Classification & Merge Policy

Every PR **must** include an explicit risk assessment in the PR body:

```
Risk: low | medium | high

Justification: [1-3 sentence explanation based on the actual diff, not author claims]
```

### Risk Levels

- **Low** — Docs/comments/typos only; test-only changes with no production behavior change; tiny isolated bugfix with low blast radius; config copy tweaks that do not change auth, secrets, outbound messaging, budget, or source APIs.
  
- **Medium** — Behavioral changes in `src/sources/*`, `src/agents/*`, scoring/draft prompts, scheduler/cron routing, dashboard UX, digest content/format; cross-file refactors; non-trivial quota/budget math changes; new dependencies.

- **High** — Anything that could violate CLAUDE.md hard rules (outbound post/email paths, scraping, secret handling); auth/Access JWT/`ACCESS_DEV_BYPASS`; D1 schema migrations that alter/drop data or non-additive indexes/relations; `wrangler.jsonc` deploy/security surface; changes that expand who can receive email or what gets stored about people/patients.

### Standing Merge Policy

**Agents SHOULD auto-merge low and medium risk PRs once CI is green.** Do not wait for a human "merge it" message.

**High risk PRs must NEVER be auto-merged** — leave them open for mandatory human review.

If risk is unclear, treat as **medium** (mergeable with post-merge flag), NOT high — unless it touches CLAUDE.md hard-rule territory (auth, secrets, auto-posting, budget, destructive migrations), which always stays high.

#### Low Risk: Auto-Merge After CI

- Auto-merge immediately once CI passes
- No special flags or labels needed

#### Medium Risk: Auto-Merge After CI + Post-Merge Review Flag

Before or when merging a medium-risk PR:

1. Add the GitHub label `needs-post-merge-review` (create if missing: `gh api repos/:owner/:repo/labels -f name='needs-post-merge-review' -f color='FFA500' -f description='Merged without pre-merge human review'`)
2. Post a PR comment: `Post-merge review: Risk medium — agents merged without pre-merge human review. Please skim when you can.`
3. Then merge once CI is green

The owner will review medium-risk changes at their convenience.

#### High Risk: NEVER Auto-Merge

- Create the PR as a **draft**
- Leave open for mandatory human review
- Human must explicitly approve and merge

## Risk Assessment Process

When reviewing or merging a PR:

1. **Read the actual diff** — do not trust risk claims in the PR description without verification.
2. **Classify using the repo-specific criteria above** (reference `.cursor/rules/risk-and-merge.mdc` and `.cursor/skills/assess-pr-risk/`).
3. **Comment or update the PR body** with `Risk: [level]` + brief justification.
4. **Merge decision:**
   - **Low risk:** Auto-merge once CI is green (standing policy).
   - **Medium risk:** Add `needs-post-merge-review` label + comment, then auto-merge once CI is green (standing policy).
   - **High risk:** NEVER auto-merge. Leave open for mandatory human review.
5. **If asked to merge a high-risk PR:** refuse the merge and explain the risk gate.

## Code Quality & Conventions

### Legacy Reaper Policy

**When adding replacements, remove the old code in the same PR** (when safe). If cleanup must be deferred (gradual rollout, backward compat, uncertain if used), mark it explicitly with a `LEGACY_REAPER` comment:

```typescript
// LEGACY_REAPER: <why it exists> | remove when <specific condition>
```

Every PR must include a `## Legacy reaper` section documenting what was removed and what was deferred (with markers). Never leave silent dual-paths or unmarked deprecated code.

Before implementing a feature, **search for existing `LEGACY_REAPER` markers** in your work area and clear any whose removal conditions are met.

See `.cursor/rules/legacy-reaper.mdc` for full rules and `.cursor/skills/legacy-reaper/` for step-by-step guidance.

## Architecture Overview

See `CLAUDE.md` for full architecture. Key modules:

- **Entry point:** `src/index.ts` (default export); `src/scheduler.ts` (cron routing)
- **Sources:** `src/sources/*` — read-only Reddit and YouTube API clients
- **Agents:** `src/agents/listen.ts` (scoring), `src/agents/draft.ts` (reply drafts)
- **Claude API:** `src/claude/client.ts` (budget-guarded, cost-tracking wrapper)
- **Database:** `src/db/queries.ts` (all D1 queries), `migrations/` (schema)
- **Dashboard:** `src/dashboard/*` (server-rendered approval UI)
- **Digest:** `src/digest/*` (daily email to owner)

## Commands

- `npm test` — Vitest with Workers pool, in-memory D1
- `npm run typecheck` — TypeScript validation
- `npm run dev` — Local dev server with scheduled testing
- `npm run db:migrate:local` / `db:migrate:remote` — Run D1 migrations

**Install note:** Always use `npm install --legacy-peer-deps` (npm's resolver crashes on the peer set otherwise).

## Testing Conventions

- Add tests for scoring, budget guard, and D1 queries whenever they change.
- Run tests after each change.
- Mock `fetch` for Reddit and Anthropic in tests. Tests never hit the network.
- Keep niche, problem statement, subreddits, thresholds, and voice guide in `src/config.ts`.

## Deploy

See `CLAUDE.md` for the full manual deploy runbook (D1 setup, secrets, Cloudflare Access, email configuration).
