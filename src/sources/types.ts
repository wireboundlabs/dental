export interface SourceItem {
  source: string;
  externalId: string;
  url: string;
  /** Raw author name; hashed before storage. */
  author: string | null;
  text: string;
  createdUtc: number;
}

/** A read-only source of public posts/comments. Implementations must never write anywhere. */
export interface Source {
  /** Stable key, used for cursors. */
  readonly key: string;
  /** Items newer than `sinceUtc` (unix seconds), or the latest window if null. */
  fetchRecent(sinceUtc: number | null): Promise<SourceItem[]>;
}
