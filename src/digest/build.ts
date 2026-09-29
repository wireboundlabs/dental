import { getDailyCap } from "../budget";
import {
  countDraftsByStatus,
  countLeadsSince,
  getCapHit,
  listLeadsSince,
  spentOnDay,
  utcDay,
} from "../db/queries";
import type { Env } from "../env";

export interface Digest {
  subject: string;
  text: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const usd = (n: number) => `$${n.toFixed(2)}`;

/** Builds the plain-text daily digest. Makes no Claude calls, so it works even when the cap is hit. */
export async function buildDigest(env: Pick<Env, "DB" | "DAILY_BUDGET_USD">, now: Date = new Date()): Promise<Digest> {
  const cap = getDailyCap(env.DAILY_BUDGET_USD);
  const since = new Date(now.getTime() - DAY_MS).toISOString();
  const yesterday = utcDay(new Date(now.getTime() - DAY_MS));
  const today = utcDay(now);

  const [newLeadCount, leads, pending, approved, ySpend, tSpend, yCap, tCap] = await Promise.all([
    countLeadsSince(env.DB, since),
    listLeadsSince(env.DB, since, 10),
    countDraftsByStatus(env.DB, "pending"),
    countDraftsByStatus(env.DB, "approved"),
    spentOnDay(env.DB, yesterday),
    spentOnDay(env.DB, today),
    getCapHit(env.DB, yesterday),
    getCapHit(env.DB, today),
  ]);

  const lines: string[] = [];
  lines.push(`New leads (last 24h): ${newLeadCount}`);
  for (const l of leads) lines.push(`  - [${l.score.toFixed(2)}] ${l.pain_summary}\n    ${l.url}`);
  if (newLeadCount > leads.length) lines.push(`  ...and ${newLeadCount - leads.length} more`);
  lines.push("");
  lines.push(`Drafts waiting for your review: ${pending}`);
  lines.push(`Approved, not yet marked sent: ${approved}`);
  lines.push("");
  lines.push(`Claude API spend yesterday (${yesterday}): ${usd(ySpend)} of ${usd(cap)} cap`);
  lines.push(`Claude API spend so far today (${today}): ${usd(tSpend)}`);
  for (const [label, hit] of [
    [yesterday, yCap],
    [today, tCap],
  ] as const) {
    if (hit) {
      lines.push(
        `BUDGET CAP HIT on ${label} at ${hit.cap_hit_at} (spent ${usd(hit.spent_usd)}). Agents were stopped for the rest of that UTC day.`,
      );
    }
  }
  lines.push("");
  lines.push("Nothing was sent or posted automatically. Review drafts in the dashboard.");

  const flags = [pending > 0 ? `${pending} drafts` : null, yCap || tCap ? "CAP HIT" : null].filter(Boolean);
  return {
    subject: `Discovery digest: ${newLeadCount} new leads${flags.length ? ` (${flags.join(", ")})` : ""}`,
    text: lines.join("\n"),
  };
}
