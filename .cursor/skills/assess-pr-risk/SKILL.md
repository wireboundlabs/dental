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

#### Medium Risk (Auto-Merge After CI + Post-Merge Review Flag)
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

**If uncertain:** Default to **medium** (mergeable with post-merge flag), NOT high — unless it touches CLAUDE.md hard-rule territory (auth, secrets, auto-posting, budget, destructive migrations), which always stays high.

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

**Standing policy: Agents SHOULD auto-merge low and medium risk PRs once CI is green.** Do not wait for a human "merge it" message.

#### For Low Risk PRs:

- Wait for CI to pass
- Auto-merge immediately
- No special flags or labels needed

#### For Medium Risk PRs:

Before or when merging:

1. **Add the `needs-post-merge-review` label:**
   ```bash
   # Create label if it doesn't exist
   gh api repos/:owner/:repo/labels -f name='needs-post-merge-review' \
     -f color='FFA500' -f description='Merged without pre-merge human review' 2>/dev/null || true
   
   # Add to PR
   gh pr edit <pr-number> --add-label needs-post-merge-review
   ```

2. **Post the comment:**
   ```bash
   gh pr comment <pr-number> --body "Post-merge review: Risk medium — agents merged without pre-merge human review. Please skim when you can."
   ```

3. **Merge** once CI is green and label/comment are in place

The owner will review medium-risk changes at their convenience.

#### For High Risk PRs:

- **NEVER auto-merge**
- Leave open for mandatory human review
- If asked to merge a high-risk PR, refuse and explain

Example refusal for high risk:

> This PR is classified as **high risk** because it modifies budget enforcement logic in `src/budget.ts` (touches CLAUDE.md hard rule). Per repo policy in `AGENTS.md` and `.cursor/rules/risk-and-merge.mdc`, high risk PRs require human review and cannot be auto-merged.
>
> PR: [link]
>
> Please review the changes and merge manually if appropriate.

**Never auto-merge if CI is failing** (applies to all risk levels).

### 5. If Risk is Unclear, Default to Medium

When in doubt, treat the change as **medium risk** (mergeable with post-merge flag), NOT high. It's the right balance — ship it but flag it for review.

**Exception:** If the uncertainty involves CLAUDE.md hard-rule territory (auth, secrets, auto-posting, budget, destructive migrations), escalate to **high** risk.

## Reference Files

- `AGENTS.md` — Project overview and risk/merge policy
- `.cursor/rules/risk-and-merge.mdc` — Detailed risk criteria (always-apply rule)
- `CLAUDE.md` — Hard product/safety rules (violations are always high risk)

## Common Scenarios

### Scenario: Asked to merge a PR

1. Fetch the PR branch and read the diff
2. Classify the risk using the criteria above
3. Check CI status
4. If low risk + CI green: merge immediately
5. If medium risk + CI green: add label + comment, then merge
6. If high risk: refuse and explain (never auto-merge)

### Scenario: Creating a new PR for your changes

1. Review your own diff before opening the PR
2. Classify the risk
3. Include `Risk: [level]` in the PR body with justification
4. If high risk, open as a **draft** PR (mandatory human review)
5. If low or medium risk, open as a regular PR (not draft)
6. Follow the standing auto-merge policy after CI passes

### Scenario: Reviewing someone else's PR

1. Read the diff (don't trust their risk claim)
2. Reclassify if needed
3. Comment on the PR with your risk assessment
4. If they claimed low but you find medium, add label/comment and merge if CI is green
5. If they claimed low but you find high, explain why and do NOT merge

## Testing Requirements

For any risk level:
- Ensure `npm test` passes
- Ensure `npm run typecheck` passes
- Read test output to verify no new failures

Even low-risk PRs should have CI green before merging.
