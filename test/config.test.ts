import { describe, expect, it } from "vitest";
import {
  MAX_DRAFTS_PER_RUN,
  MAX_ITEMS_PER_RUN,
  MAX_SOURCES_PER_RUN,
  WORKER_SUBREQUEST_LIMIT,
  YOUTUBE_VIDEOS_PER_VISIT,
} from "../src/config";

describe("per-run subrequest budget", () => {
  it("worst case (every visited source on its costliest path) stays under the Workers Free limit", () => {
    const youtubeSource = 2 + 2 + YOUTUBE_VIDEOS_PER_VISIT; // 2 searches + 2 stats calls + comment reads
    const redditSource = 3; // token + posts + comments
    const perSource = Math.max(youtubeSource, redditSource);
    const worstCase = MAX_SOURCES_PER_RUN * perSource + MAX_ITEMS_PER_RUN + MAX_DRAFTS_PER_RUN;
    expect(worstCase).toBeLessThan(WORKER_SUBREQUEST_LIMIT);
  });
});
