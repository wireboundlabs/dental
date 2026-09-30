import type { KeyValueStore } from "../src/sources/types";

/** In-memory KeyValueStore for source tests (production uses the D1 cursors table). */
export function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    getMany: async (ks) => new Map(ks.flatMap((k) => (data.has(k) ? [[k, data.get(k)!] as [string, string]] : []))),
    set: async (k, v) => void data.set(k, v),
  };
}
