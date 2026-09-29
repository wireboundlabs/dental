/** An upstream API told us to slow down. Callers back off instead of retrying immediately. */
export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSec: number,
  ) {
    super(message);
    this.name = "RateLimitError";
  }
}

/** Never back off for less than this, even if the server suggests sooner. */
export const MIN_BACKOFF_SEC = 60;

/** Upper bound so a bad header cannot silence a source for days. */
export const MAX_BACKOFF_SEC = 6 * 3600;

/** Parses a Retry-After header (seconds form) into a clamped backoff. */
export function backoffFromHeaders(headers: Headers, fallbackSec: number): number {
  const parsed = Number(headers.get("retry-after"));
  const sec = Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackSec;
  return Math.min(Math.max(sec, MIN_BACKOFF_SEC), MAX_BACKOFF_SEC);
}
