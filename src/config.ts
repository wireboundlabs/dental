// Niche configuration. Change these to retarget the whole system.

export const NICHE = "independent dental offices";

/** The problem we think they have. Drives scoring. */
export const PROBLEM_STATEMENT =
  "Front-desk staff at independent dental offices spend hours a day on phone calls, insurance verification and scheduling gaps instead of caring for patients.";

/** Subreddits to listen to (verify these exist before relying on them). */
export const SUBREDDITS = ["dentistry", "DentalHygiene", "dentalassistants", "smallbusiness"];

/** Extra filter for broad subreddits: only consider items mentioning one of these words. */
export const BROAD_SUBREDDIT_KEYWORDS: Record<string, string[]> = {
  smallbusiness: ["dental", "dentist", "dds"],
};

/**
 * YouTube search queries. Each query keeps two pools of videos whose comments we read:
 *  - "best": relevance-ordered results, 50 per page. One more page is added per day up to a maximum, and the
 *    whole pool restarts every couple of weeks so ranking changes are picked up.
 *  - "new": the 50 most recent uploads, refreshed every few hours.
 * A search costs 100 quota units however many results it returns, so we take a full page of 50 and work through
 * it, not just the top few. Stats for a page cost 1 more unit (videos.list) and let us drop videos with no
 * comments. Each video then has its own progress marker, and is re-read on a schedule that depends on its age.
 *
 * Quota (10,000 units/day free) at the 15-minute cron (96 runs/day), 9 queries, 2 sources per run:
 *   best pool: 9 queries x 3 pages x 101 = ~2,700 in the first 3 days, then ~200/day for restarts
 *   new pool:  9 queries x 2 refreshes/day x 101 = ~1,800/day
 *   comment reads: at most 96 runs x 2 sources x YOUTUBE_VIDEOS_PER_VISIT = ~1,500/day, usually far less
 * so ~3,500/day at worst, a bit more in the first three days. Each source is visited about every hour
 * (9 sources, 2 per run); if you slow the cron further, raise MAX_SOURCES_PER_RUN or freshness suffers. If quota is hit, the source backs off for an hour.
 */
export const YOUTUBE_QUERIES = [
  "dental front desk insurance verification",
  "dental practice management software review",
  "Open Dental tutorial",
  "Dentrix vs Eaglesoft",
  "dental office phones front desk overwhelmed",
  "dental scheduling no-shows cancellations",
  "dental office manager insurance follow up",
  "dental practice owner staffing problems",
  "dental insurance claims billing headaches",
];
/** Results per search page (the API maximum; the cost is the same as asking for 3). */
export const YOUTUBE_POOL_PAGE_SIZE = 50;
/** The best pool grows by one page per interval up to this many pages, then holds. */
export const YOUTUBE_POOL_MAX_PAGES = 3;
export const YOUTUBE_POOL_PAGE_INTERVAL_HOURS = 24;
/** The best pool is rebuilt from page 1 this often. */
export const YOUTUBE_POOL_RESTART_DAYS = 14;
/** The newest-uploads pool is refreshed this often. */
export const YOUTUBE_NEW_POOL_REFRESH_HOURS = 12;
/** Videos whose comments are read per source visit. */
export const YOUTUBE_VIDEOS_PER_VISIT = 8;
/** A video with no comments and older than this is dropped from the pool. */
export const YOUTUBE_EMPTY_VIDEO_MAX_AGE_DAYS = 30;
/** How often a video is re-read, by age: young videos get new comments; old ones rarely do. */
export const YOUTUBE_RECHECK_TIERS: { maxAgeDays: number; hours: number }[] = [
  { maxAgeDays: 7, hours: 3 },
  { maxAgeDays: 30, hours: 12 },
  { maxAgeDays: 180, hours: 48 },
  { maxAgeDays: Infinity, hours: 168 },
];
export const YOUTUBE_COMMENTS_PER_VIDEO = 100;

/** Minimum relevance (0-1) for an item to become a lead. */
export const QUALIFY_THRESHOLD = 0.7;

/**
 * Workers Free allows 50 external subrequests (fetch calls) per invocation. One agents run makes, per source,
 * at most 2 searches + 2 stats calls + YOUTUBE_VIDEOS_PER_VISIT comment reads for YouTube or 3 calls for Reddit,
 * plus one Claude call per scored item and one per draft. See test/config.test.ts, which keeps the worst case under the limit.
 */
export const WORKER_SUBREQUEST_LIMIT = 50;

/**
 * Sources visited per run, round-robin (position kept in D1), so adding queries does not add subrequests
 * per run. Each source is visited every ceil(sources / this) runs. Raise it if you slow the cron.
 */
export const MAX_SOURCES_PER_RUN = 2;

/** Max items scored per cron run, to bound spend and subrequests. */
export const MAX_ITEMS_PER_RUN = 15;

/** Max leads drafted per cron run. */
export const MAX_DRAFTS_PER_RUN = 5;

/** Items shorter than this are not worth a scoring call. */
export const MIN_TEXT_LENGTH = 40;

export const EXCERPT_MAX_CHARS = 500;

/** Voice guide injected into the drafting prompt. Edit to match how you write. */
export const VOICE_GUIDE = `Write like a curious fellow builder, not a salesperson.
- Short, plain, warm. First person. No jargon, no emojis, no exclamation marks.
- Ask one genuine question about their situation and how they handle it today.
- Acknowledge the specific thing they said.
- Never pitch, never mention a product or company, never include links.
- Never mention or ask about individual patients.
- Replies: 2-4 sentences. Emails: 4-6 sentences, with a short subject line on the first line as "Subject: ...".`;
