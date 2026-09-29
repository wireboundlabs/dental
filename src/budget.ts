import { recordCapHit, spentOnDay, utcDay } from "./db/queries";

export class BudgetExceededError extends Error {
  constructor(
    public readonly spentUsd: number,
    public readonly capUsd: number,
  ) {
    super(`Daily Claude budget reached: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)}`);
    this.name = "BudgetExceededError";
  }
}

/** Parses DAILY_BUDGET_USD. A missing or invalid value throws, so the guard fails closed. */
export function getDailyCap(raw: string | undefined): number {
  const cap = Number(raw);
  if (raw === undefined || raw.trim() === "" || !Number.isFinite(cap) || cap <= 0) {
    throw new Error(`Invalid DAILY_BUDGET_USD: ${JSON.stringify(raw)}`);
  }
  return cap;
}

/**
 * Throws BudgetExceededError if today's spend has reached the cap, or if the
 * worst-case cost of the next call would push it over. Records the first cap hit of the day.
 */
export async function assertWithinBudget(
  db: D1Database,
  capUsd: number,
  worstCaseNextCostUsd: number,
  now: Date,
): Promise<void> {
  const day = utcDay(now);
  const spent = await spentOnDay(db, day);
  if (spent >= capUsd || spent + worstCaseNextCostUsd > capUsd) {
    await recordCapHit(db, day, spent, now);
    throw new BudgetExceededError(spent, capUsd);
  }
}
