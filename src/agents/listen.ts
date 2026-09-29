import { BudgetExceededError } from "../budget";
import { EXCERPT_MAX_CHARS, MAX_ITEMS_PER_RUN, MIN_TEXT_LENGTH, QUALIFY_THRESHOLD } from "../config";
import { getCursor, insertItemIfNew, insertLead, itemExists, setCursor } from "../db/queries";
import type { Env } from "../env";
import type { Source } from "../sources/types";
import { qualifies, scoreItem } from "./score";

export interface ListenSummary {
  seen: number;
  scored: number;
  leads: number;
  skippedMalformed: number;
  stoppedByBudget: boolean;
  sourceErrors: number;
}

const REDACTED_EXCERPT = "[excerpt withheld: may contain patient details]";

async function hashAuthor(author: string | null): Promise<string | null> {
  if (!author) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(author));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Pull new items, score them, store leads. Read-only against sources; never contacts anyone. */
export async function runListen(
  env: Pick<Env, "DB" | "ANTHROPIC_API_KEY" | "DAILY_BUDGET_USD" | "CLAUDE_MODEL">,
  sources: Source[],
  now: Date = new Date(),
  fetchFn: typeof fetch = fetch,
  threshold: number = QUALIFY_THRESHOLD,
): Promise<ListenSummary> {
  const summary: ListenSummary = { seen: 0, scored: 0, leads: 0, skippedMalformed: 0, stoppedByBudget: false, sourceErrors: 0 };
  let budgetLeft = MAX_ITEMS_PER_RUN;

  for (const source of sources) {
    if (summary.stoppedByBudget || budgetLeft <= 0) break;
    const cursorRaw = await getCursor(env.DB, source.key);
    const since = cursorRaw === null ? null : Number(cursorRaw);
    let fetched;
    try {
      fetched = await source.fetchRecent(since);
    } catch (err) {
      // One broken source (bad credentials, quota) must not stop the others.
      summary.sourceErrors++;
      console.error(`Source ${source.key} failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const items = fetched.sort((a, b) => a.createdUtc - b.createdUtc);
    let maxCreated = since ?? 0;
    let fullyProcessed = true;

    for (const item of items) {
      summary.seen++;
      if (await itemExists(env.DB, item.source, item.externalId)) {
        maxCreated = Math.max(maxCreated, item.createdUtc);
        continue;
      }
      if (item.text.length < MIN_TEXT_LENGTH) {
        maxCreated = Math.max(maxCreated, item.createdUtc);
        continue;
      }
      if (budgetLeft <= 0) {
        fullyProcessed = false;
        break;
      }

      let score;
      try {
        score = await scoreItem(env, item, now, fetchFn);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          summary.stoppedByBudget = true;
          fullyProcessed = false;
          break;
        }
        throw err;
      }
      budgetLeft--;
      summary.scored++;

      if (!score) {
        summary.skippedMalformed++;
        maxCreated = Math.max(maxCreated, item.createdUtc);
        continue; // not stored: retried on a later run only if the cursor did not pass it
      }

      const excerpt = score.patientInfoPresent ? REDACTED_EXCERPT : item.text.slice(0, EXCERPT_MAX_CHARS);
      const itemId = await insertItemIfNew(
        env.DB,
        {
          source: item.source,
          externalId: item.externalId,
          url: item.url,
          authorHash: await hashAuthor(item.author),
          excerpt,
          createdUtc: item.createdUtc,
        },
        now,
      );
      if (itemId !== null && qualifies(score, threshold)) {
        await insertLead(env.DB, { itemId, score: score.relevance, painSummary: score.painSummary }, now);
        summary.leads++;
      }
      maxCreated = Math.max(maxCreated, item.createdUtc);
    }

    if (fullyProcessed || maxCreated > (since ?? 0)) {
      await setCursor(env.DB, source.key, String(maxCreated));
    }
  }
  return summary;
}
