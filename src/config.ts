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
 * YouTube search queries used to find videos whose comments we read.
 * Quota (10,000 units/day free): each query costs 100 (search) + 1 per video per run.
 * The search (100 units) is cached for YOUTUBE_SEARCH_CACHE_HOURS, so most runs only pay the 1-unit comment reads.
 * At the 5-minute cron (288 runs/day): comments 4 queries x 3 videos x 288 = 3,456, plus searches
 * 4 x 100 x (24 / 6) = 1,600, so ~5,000 units/day. If quota is still hit, the source backs off for an hour.
 */
export const YOUTUBE_QUERIES = [
  "dental front desk insurance verification",
  "dental practice management software review",
  "Open Dental tutorial",
  "Dentrix vs Eaglesoft",
];
export const YOUTUBE_VIDEOS_PER_QUERY = 3;
export const YOUTUBE_SEARCH_CACHE_HOURS = 6;
export const YOUTUBE_COMMENTS_PER_VIDEO = 100;

/** Minimum relevance (0-1) for an item to become a lead. */
export const QUALIFY_THRESHOLD = 0.7;

/**
 * Workers Free allows 50 external subrequests (fetch calls) per invocation. One agents run makes:
 * YouTube: queries x (1 search + videos) + Reddit: subreddits x (1 token + 2 listings) + one Claude call per
 * scored item + one per draft. See test/config.test.ts, which keeps the worst case under the limit.
 */
export const WORKER_SUBREQUEST_LIMIT = 50;

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
