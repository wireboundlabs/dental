export interface SourceItem {
  source: string;
  externalId: string;
  url: string;
  /** Raw author name; hashed before storage. */
  author: string | null;
  text: string;
  createdUtc: number;
  /** Optional grouping (YouTube: the video id) so a source can track progress per group. */
  group?: string;
}

/** Small string store a source can use to remember things between runs (backed by D1 cursors). */
export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  getMany(keys: string[]): Promise<Map<string, string>>;
  set(key: string, value: string): Promise<void>;
}

/** A read-only source of public posts/comments. Implementations must never write anywhere. */
export interface Source {
  /** Stable key, used for cursors. */
  readonly key: string;
  /** Items newer than `sinceUtc` (unix seconds), or the latest window if null. */
  fetchRecent(sinceUtc: number | null): Promise<SourceItem[]>;
  /**
   * Called after a run with the items that were fully handled (stored, skipped or already known), so the source
   * can advance its own progress markers only past work that is actually done. Items not listed are re-offered.
   */
  acknowledge?(processed: SourceItem[]): Promise<void>;
}
