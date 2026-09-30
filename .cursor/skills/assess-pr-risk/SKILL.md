---
name: Assess PR Risk
description: Use when assessing PR risk, deciding whether a change can be auto-merged, or labeling a PR with Risk low/medium/high.
---

# Assess PR Risk

Use this skill when:
- Reviewing a PR and determining its risk level
- Deciding whether a PR can be auto-merged
- Labeling a PR with `Risk: low | medium | high`
- A human asks you to merge a PR (you must assess risk first)

## Risk Assessment Process

### 1. Read the Actual Diff

**Do not trust risk claims in the PR description without verification.** Always examine the actual code changes.

```bash
# Get the diff for the PR branch
git diff main...<branch-name>

# Or use gh CLI if you have the PR number
gh pr diff <pr-number>
```

Look for:
- Which files changed
- What behavior is modified
- What new code paths are introduced
- What existing logic is removed or altered

### 2. Classify Using Repo-Specific Criteria

Reference the risk levels defined in `.cursor/rules/risk-and-merge.mdc` and `AGENTS.md`.

**Key risk indicators for this repo:**

#### Low Risk (Auto-Merge Eligible)
- Only docs/comments/README changes
- Only test file changes with no production code changes
- Tiny, obvious bugfixes (e.g., `if (x)` → `if (x != null)`) with limited scope
- Copy/wording tweaks in config that don't affect behavior

#### Medium Risk (Requires Human Review)
- **Source logic:** Changes to `src/sources/reddit.ts`, `src/sources/youtube.ts`, or `src/sources/base.ts`
- **Agent logic:** Changes to `src/agents/listen.ts` or `src/agents/draft.ts`
- **Prompts:** Changes to scoring or draft prompts
- **Scheduler:** Changes to cron routing in `src/scheduler.ts`
- **Dashboard:** User-facing changes in `src/dashboard/*`
- **Digest:** Changes to email content in `src/digest/*`
- **Queries:** Non-cosmetic changes to `src/db/queries.ts`
- **Refactors:** Multi-file refactors even if tests pass
- **Dependencies:** New packages in `package.json`
- **Budget/quota math:** Changes to quota calculations in `src/config.ts`

#### High Risk (Requires Human Review + Extra Scrutiny)
- **CLAUDE.md hard rule violations:**
  - New code paths that could auto-post to Reddit or email prospects
  - Scraping or unofficial API usage
  - Secrets in code, tests, fixtures, or docs
  - Claude API calls outside `src/claude/client.ts`
- **Auth/Access:** Changes to Access JWT verification or `ACCESS_DEV_BYPASS`
- **Schema migrations:** `migrations/*.sql` files that:
  - DROP or ALTER existing columns/tables
  - Remove indexes or foreign keys
  - Could lose data
- **Deploy config:** Changes to `wrangler.jsonc` affecting:
  - `send_email.allowed_destination_addresses`
  - Bindings, routes, or compatibility flags
- **Privacy expansion:** Code that stores more info about people or patients
- **Email expansion:** Code that adds recipients beyond `OWNER_EMAIL`
- **Source API expansion:** Changes that add POST/PUT/DELETE requests (except OAuth token exchange)

**If the PR touches multiple areas with different risk levels, use the highest risk level.**

### 3. Document the Risk in the PR

Update or add a `Risk:` section to the PR body:

```markdown
Risk: low | medium | high

Justification: [1-3 sentence explanation based on the actual diff]
```

Example justifications:
- **Low:** "Only updates README with clearer install instructions. No code changes."
- **Medium:** "Modifies scoring prompt in listen.ts to better identify pain points. Changes agent behavior."
- **High:** "Adds new migration to drop the `drafts.metadata` column. Could lose data if rolled back incorrectly."

Use the `ManagePullRequest` tool to update the PR body if needed:

```typescript
// Example: update PR body with risk assessment
ManagePullRequest({
  action: "update_pr",
  branch_name: "cursor/feature-branch-5bc6",
  body: `${existingBody}\n\nRisk: medium\n\nJustification: Changes agent scoring logic in src/agents/listen.ts.`
})
```

### 4. Make the Merge Decision

**Auto-merge only if ALL of the following are true:**
- Risk is **low**
- CI is green (all checks passed)
- A human explicitly asked you to merge, OR standing low-risk auto-merge policy applies

**Never auto-merge if:**
- Risk is medium or high
- CI is failing
- No explicit merge request was made

**If asked to merge a medium or high risk PR:**
- Refuse the merge
- Explain the risk gate clearly
- Provide the PR link and risk justification

Example refusal:

> This PR is classified as **medium risk** because it modifies agent scoring logic in `src/agents/listen.ts`. Per repo policy in `AGENTS.md` and `.cursor/rules/risk-and-merge.mdc`, medium and high risk PRs require human review and cannot be auto-merged.
>
> PR: [link]
>
> Please review the changes and merge manually if appropriate.

### 5. If Risk is Unclear, Default to Medium

When in doubt, treat the change as **medium risk** (requires human review). It's safer to over-classify than to auto-merge something risky.

## Reference Files

- `AGENTS.md` — Project overview and risk/merge policy
- `.cursor/rules/risk-and-merge.mdc` — Detailed risk criteria (always-apply rule)
- `CLAUDE.md` — Hard product/safety rules (violations are always high risk)

## Common Scenarios

### Scenario: Asked to merge a PR

1. Fetch the PR branch and read the diff
2. Classify the risk using the criteria above
3. Check CI status
4. If low risk + CI green + explicit request: merge
5. If medium/high risk: refuse and explain

### Scenario: Creating a new PR for your changes

1. Review your own diff before opening the PR
2. Classify the risk
3. Include `Risk: [level]` in the PR body with justification
4. If medium or high risk, open as a **draft** PR
5. If low risk, open as a regular PR (draft is fine too)

### Scenario: Reviewing someone else's PR

1. Read the diff (don't trust their risk claim)
2. Reclassify if needed
3. Comment on the PR with your risk assessment
4. If they claimed low but you find medium/high, explain why and ask them to update

## Testing Requirements

For any risk level:
- Ensure `npm test` passes
- Ensure `npm run typecheck` passes
- Read test output to verify no new failures

Even low-risk PRs should have CI green before merging.
