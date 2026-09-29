import { describe, expect, it } from "vitest";
import {
  MAX_DRAFTS_PER_RUN,
  MAX_ITEMS_PER_RUN,
  SUBREDDITS,
  WORKER_SUBREQUEST_LIMIT,
  YOUTUBE_QUERIES,
  YOUTUBE_VIDEOS_PER_QUERY,
} from "../src/config";

describe("per-run subrequest budget", () => {
  it("worst case with every source enabled stays under the Workers Free limit", () => {
    const youtube = YOUTUBE_QUERIES.length * (1 + YOUTUBE_VIDEOS_PER_QUERY);
    const reddit = SUBREDDITS.length * 3; // token + posts + comments
    const worstCase = youtube + reddit + MAX_ITEMS_PER_RUN + MAX_DRAFTS_PER_RUN;
    expect(worstCase).toBeLessThan(WORKER_SUBREQUEST_LIMIT);
  });
});
