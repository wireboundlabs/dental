---
name: Legacy Reaper
description: Step-by-step guidance for removing superseded code when implementing features. Use when adding replacements or refactoring existing functionality.
---

# Legacy Reaper Skill

Use this skill when:
- Implementing a new feature that replaces existing functionality
- Refactoring code paths, queries, prompts, or APIs
- Adding new dependencies that supersede old ones
- Migrating configuration, schemas, or data structures
- You notice dual-paths, deprecated code, or "TODO remove" comments

## Step-by-Step Process

### Step 1: Before You Start — Check for Existing LEGACY_REAPER Markers

**Always begin** by searching for LEGACY_REAPER markers in your work area:

```bash
# Find all markers in the repo
rg "LEGACY_REAPER" --type ts --type sql --type md

# Check specific files you're about to modify
rg "LEGACY_REAPER" src/agents/ src/sources/
```

**For each marker you find:**
1. Read the removal condition (format: `LEGACY_REAPER: <why> | remove when <condition>`)
2. Check if the condition is met (e.g., "remove when FEATURE_X is default" → check if FEATURE_X is now default)
3. If the condition is met: **remove the code and the marker** as part of your current PR
4. If the condition is not met: leave it alone (don't re-mark or duplicate)

**Example:**
```typescript
// Found in src/scheduler.ts:
// LEGACY_REAPER: Fallback to Reddit-only | remove when YOUTUBE_ENABLED default is true

// You're now making YOUTUBE_ENABLED true by default
// → Remove this fallback code as part of your PR
```

### Step 2: Implement Your Feature

Write your new code as usual. Focus on correctness and tests first.

### Step 3: Identify What Your Change Supersedes

Ask yourself:
- **Functions:** Does this replace an old function or method?
- **Paths:** Does this make an if/else branch or switch case unreachable?
- **Config:** Does this replace an environment variable, constant, or feature flag?
- **Prompts/Queries:** Does this replace a Claude prompt or D1 query?
- **Dependencies:** Does this replace a package in `package.json`?
- **Tests:** Are there tests that only verify the old code path?
- **Documentation:** Are there comments, TODOs, or README sections about the old way?

### Step 4: Decide — Remove Now or Defer?

#### Remove Now (Preferred)

**Remove immediately if:**
- The old code is demonstrably unused after your change
- Tests pass without it
- No gradual rollout or backward compatibility is needed
- `npx fallow dead-code` confirms it's dead

**How to remove:**
1. Delete the old function/path/config/test
2. Remove associated imports, constants, and comments
3. Search for references to ensure nothing breaks:
   ```bash
   rg "oldFunctionName" --type ts
   ```
4. Run tests and typecheck:
   ```bash
   npm test && npm run typecheck
   ```

#### Defer (Mark with LEGACY_REAPER)

**Defer removal if:**
- Gradual rollout is needed (feature flag not yet default)
- Backward compatibility required during migration
- Uncertain if code is truly unused (needs production verification)
- Dependency is shared with other systems not yet updated

**How to defer:**
1. Add a LEGACY_REAPER comment **near the code**:
   ```typescript
   // LEGACY_REAPER: <why it exists> | remove when <condition>
   ```
2. Be specific about the removal condition (avoid vague conditions like "later" or "eventually")
3. List it in the PR body under "Legacy reaper → Deferred"

**Never leave silent dual-paths** — if you keep both old and new, mark the old one with LEGACY_REAPER.

### Step 5: Search for Related Legacy Artifacts

Even if the main code is gone, there may be remnants:

```bash
# Search for the old function/constant name
rg "oldFunctionName" --type ts

# Search for old config keys
rg "OLD_CONFIG_KEY" --glob "*.ts" --glob "*.json" --glob "*.md"

# Search for TODO/FIXME about the old code
rg "TODO.*oldFeature|FIXME.*oldFeature" -i

# Search for "old", "legacy", "deprecated" in related files
rg "old|legacy|deprecated" -i src/agents/
```

**Remove:**
- Unused imports
- Dead constants
- Obsolete config knobs
- Tests that can't be adapted
- Comments referencing the old way

### Step 6: Run Fallow to Find Dead Code

```bash
# Check for dead exports and unused dependencies
npx fallow dead-code

# Preview automatic cleanup (review before applying)
npx fallow fix --dry-run
```

If Fallow finds dead code in your change's blast radius, remove it. Ignore unrelated dead code outside your change.

### Step 7: Verify Tests and Typecheck

```bash
npm test
npm run typecheck
```

If tests fail:
- Did you remove a function still in use? Search for references and update callers.
- Did you remove a test that should have been updated instead? Restore and adapt it.
- Did you violate a **CLAUDE.md hard rule**? (e.g., created an auto-posting path, exposed secrets)

### Step 8: Document in the PR Body

Add a `## Legacy reaper` section to your PR body:

```markdown
## Legacy reaper

Removed:
- Deleted `oldScoringFunction()` from `src/agents/listen.ts` (replaced by new prompt)
- Removed unused import `fetchOldAPI` from `src/sources/reddit.ts`
- Dropped `OLD_REDDIT_ENDPOINT` constant (no longer referenced)
- Updated test file `tests/agents/listen.test.ts` to use new prompt

Deferred (marked with LEGACY_REAPER):
- Kept dual-path in `src/sources/youtube.ts:45` | remove when YOUTUBE_ENABLED default is true
```

If nothing was removed or deferred:

```markdown
## Legacy reaper

None found (new feature, no prior implementation)
```

### Step 9: Final Check

Before opening the PR:
1. ✅ Tests pass (`npm test`)
2. ✅ Typecheck passes (`npm run typecheck`)
3. ✅ Fallow shows no new dead code (`npx fallow dead-code`)
4. ✅ PR body includes `## Legacy reaper` section
5. ✅ All LEGACY_REAPER markers have clear removal conditions
6. ✅ No silent dual-paths or unmarked deprecated code

## Common Scenarios

### Scenario 1: Replacing a Claude Prompt

**Change:** New scoring prompt in `src/agents/listen.ts`.

**Reap:**
1. Check for old prompt constants or templates
2. Search for comments about "old prompt" or "TODO: improve prompt"
3. Update or remove tests mocking the old prompt structure
4. Search for references to the old prompt name

**Example removal:**
```typescript
// Before:
const OLD_SCORING_PROMPT = "You are a scorer...";

// After: deleted, replaced by new prompt
```

### Scenario 2: Adding a New Source

**Change:** New YouTube source in `src/sources/youtube.ts`.

**Reap:**
1. Search for "TODO: add YouTube" comments
2. Remove placeholder config like `YOUTUBE_ENABLED = false` if now always-on
3. If replacing a prototype/stub, delete the old file

**Example deferred removal:**
```typescript
// LEGACY_REAPER: Keep Reddit-only mode during YouTube beta | remove when YOUTUBE_ENABLED default is true
const sources = YOUTUBE_ENABLED 
  ? [reddit, youtube] 
  : [reddit];
```

### Scenario 3: Refactoring a D1 Query

**Change:** New efficient query in `src/db/queries.ts`.

**Reap:**
1. Delete the old query function
2. Search for call sites: `rg "oldQueryFunction" --type ts`
3. Update call sites to use the new query
4. Remove or update tests for the old query

**Example removal:**
```typescript
// Removed old function:
// export async function getOldDrafts() { ... }

// Updated all call sites to use:
export async function getDraftsByStatus() { ... }
```

### Scenario 4: Schema Migration with Backward Compat

**Change:** Adding `new_author_hash` column, keeping `author_name` temporarily.

**Reap (mark in migration):**
```sql
-- LEGACY_REAPER: Old author_name column | drop after backfill verified (migration 0005, est. 1 week)
ALTER TABLE items ADD COLUMN new_author_hash TEXT;
```

**PR body:**
```markdown
## Legacy reaper

Removed:
- None (additive migration)

Deferred (marked with LEGACY_REAPER):
- `author_name` column in `migrations/0004_add_hash.sql:5` | drop in migration 0005 after backfill
```

### Scenario 5: Uncertain if Code is Unused

**Change:** Refactored helper function, old one might be unused.

**Reap (mark instead of deleting):**
```typescript
// LEGACY_REAPER: Possibly unused after refactor | remove if no references in production logs (check after 1 week)
function maybeUnusedHelper() {
  // old implementation
}
```

**PR body:**
```markdown
## Legacy reaper

Removed:
- Refactored main helper function

Deferred (marked with LEGACY_REAPER):
- `maybeUnusedHelper()` in `src/utils/helpers.ts:123` | verify unused in prod logs before removing
```

## Anti-Patterns (Don't Do This)

❌ **Silent dual-paths:**
```typescript
// BAD: No marker, future agents won't know this is temporary
if (NEW_FEATURE_ENABLED) {
  return newImplementation();
} else {
  return oldImplementation();
}
```

✅ **Marked dual-path:**
```typescript
// GOOD: Clearly marked for removal
// LEGACY_REAPER: Old implementation for gradual rollout | remove when NEW_FEATURE_ENABLED is default
if (NEW_FEATURE_ENABLED) {
  return newImplementation();
} else {
  return oldImplementation();
}
```

❌ **Vague removal condition:**
```typescript
// BAD: Unclear when to remove
// LEGACY_REAPER: Remove later when we're ready
```

✅ **Specific removal condition:**
```typescript
// GOOD: Clear, measurable condition
// LEGACY_REAPER: Remove when YOUTUBE_ENABLED default is true (see src/config.ts)
```

❌ **Leaving dead code without marking:**
```typescript
// BAD: Looks abandoned, no context
function unusedFunction() {
  // probably not needed anymore?
}
```

✅ **Either remove it or mark it:**
```typescript
// OPTION 1: Remove immediately if certain it's unused

// OPTION 2: Mark if uncertain
// LEGACY_REAPER: Possibly unused after refactor | verify and remove if no prod usage (check logs after 1 week)
function possiblyUnusedFunction() { ... }
```

## Reference Files

- `.cursor/rules/legacy-reaper.mdc` — Full rule with examples
- `AGENTS.md` — Project conventions including legacy reaper policy
- `CLAUDE.md` — Hard product rules (don't violate while cleaning)

## Quick Reference: LEGACY_REAPER Format

```typescript
// LEGACY_REAPER: <why it exists> | remove when <specific condition>
```

**Good examples:**
- `// LEGACY_REAPER: Backward compat during migration | drop after users table backfill (est. 1 week)`
- `// LEGACY_REAPER: Feature flag fallback | remove when FEATURE_X is default (see config.ts)`
- `// LEGACY_REAPER: Uncertain if used | verify in prod logs and remove if no references (check after 1 week)`
- `-- LEGACY_REAPER: Old index kept for read perf | drop after query optimization lands (PR #123)`

**Bad examples:**
- `// TODO: remove later` (vague, no searchable marker)
- `// LEGACY_REAPER: Old code` (missing removal condition)
- `// Remove eventually` (not using LEGACY_REAPER marker)
