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
 * YouTube search queries used to find videos whose comments we read. Each query runs two searches:
 * by relevance (stable, cached long) and by date (surfaces new videos, cached short).
 * Quota (10,000 units/day free): a search costs 100, a comment read 1. At the 5-minute cron (288 runs/day)
 * with MAX_SOURCES_PER_RUN sources per run and 9 queries:
 *   relevance searches 9 x 100 x (24 / 24h) = 900
 *   date searches      9 x 100 x (24 / 6h)  = 3,600
 *   comment reads      288 runs x 2 sources x (3 + 2 videos) = 2,880
 * so ~7,400 units/day. Slowing the cron cuts the comment reads; if quota is still hit, the source backs off for an hour.
 */
export const YOUTUBE_QUERIES = [
  "dental front desk insurance verification",
  "dental practice management software review",
  "Open Dental tutorial",
  "Dentrix vs Eaglesoft",
  "dental office phones front desk overwhelmed",
  "dental scheduling no-shows cancellations",
  "dental receptionist day in the life",
  "dental practice owner staffing problems",
  "dental insurance claims billing headaches",
];
/** Videos taken from the relevance-ordered search, and how long that search is cached. */
export const YOUTUBE_VIDEOS_PER_QUERY = 3;
export const YOUTUBE_SEARCH_CACHE_HOURS = 24;
/** Videos taken from the date-ordered search (newest uploads), and how long that search is cached. */
export const YOUTUBE_NEW_VIDEOS_PER_QUERY = 2;
export const YOUTUBE_NEW_SEARCH_CACHE_HOURS = 6;
export const YOUTUBE_COMMENTS_PER_VIDEO = 100;

/** Minimum relevance (0-1) for an item to become a lead. */
export const QUALIFY_THRESHOLD = 0.7;

/**
 * Workers Free allows 50 external subrequests (fetch calls) per invocation. One agents run makes, per source,
 * at most 2 searches + (relevance + new) comment reads for YouTube or 3 calls for Reddit, plus one Claude call
 * per scored item and one per draft. See test/config.test.ts, which keeps the worst case under the limit.
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
