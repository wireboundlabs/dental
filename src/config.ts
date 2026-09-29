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

/** Minimum relevance (0-1) for an item to become a lead. */
export const QUALIFY_THRESHOLD = 0.7;

/** Max items scored per cron run, to bound spend. */
export const MAX_ITEMS_PER_RUN = 60;

/** Max leads drafted per cron run. */
export const MAX_DRAFTS_PER_RUN = 10;

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
