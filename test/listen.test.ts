import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runListen } from "../src/agents/listen";
import { getCursor, recordApiCall } from "../src/db/queries";
import { RedditSource } from "../src/sources/reddit";
import type { Source, SourceItem } from "../src/sources/types";

const db = env.DB;
const now = new Date("2026-09-29T12:00:00Z");
const cenv = { ...env, DAILY_BUDGET_USD: "3", CLAUDE_MODEL: "claude-haiku-4-5" };

const mk = (id: string, createdUtc: number, text = "Our front desk spends all day on insurance calls and scheduling. It's overwhelming and consuming all our time."): SourceItem => ({
  source: "test:src",
  externalId: id,
  url: `https://example.com/${id}`,
  author: "dr_smith",
  text,
  createdUtc,
});

const fakeSource = (items: SourceItem[]): Source & { since: (number | null)[] } => {
  const since: (number | null)[] = [];
  return {
    key: "test:src",
    since,
    async fetchRecent(s) {
      since.push(s);
      return items.filter((i) => s === null || i.createdUtc > s);
    },
  };
};

/** Claude stub: replies by item id embedded in the prompt. */
function claudeStub(replyFor: (prompt: string) => string) {
  let calls = 0;
  const fn = (async (_u: unknown, init: RequestInit) => {
    calls++;
    const body = JSON.parse(init.body as string);
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: replyFor(body.messages[0].content) }],
        usage: { input_tokens: 400, output_tokens: 50 },
      }),
    );
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls };
}

const high = '{"relevance":0.9,"pain_summary":"phones and insurance","patient_info_present":false}';
const low = '{"relevance":0.1,"pain_summary":"unrelated","patient_info_present":false}';

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM drafts"),
    db.prepare("DELETE FROM leads"),
    db.prepare("DELETE FROM items"),
    db.prepare("DELETE FROM api_calls"),
    db.prepare("DELETE FROM budget_events"),
    db.prepare("DELETE FROM cursors"),
  ]);
});

describe("runListen", () => {
  it("stores qualified leads, keeps unqualified items for dedupe, advances the cursor", async () => {
    const stub = claudeStub((p) => (p.includes("KEEP") ? high : low));
    const src = fakeSource([
      mk("a", 100, "KEEP: front desk drowning in insurance calls, hours every day taking up all our time"),
      mk("b", 200, "I have a general question about dental school interviews and applications. Anyone have experience?"),
    ]);
    const out = await runListen(cenv, [src], now, stub.fn);
    expect(out).toMatchObject({ seen: 2, scored: 2, leads: 1, filteredOut: 0, stoppedByBudget: false });
    const leads = await db.prepare("SELECT pain_summary FROM leads").all();
    expect(leads.results).toHaveLength(1);
    const items = await db.prepare("SELECT COUNT(*) AS n FROM items").first<{ n: number }>();
    expect(items?.n).toBe(2);
    expect(await getCursor(db, "test:src")).toBe("200");
  });

  it("does not rescore items it has already seen", async () => {
    const stub = claudeStub(() => high);
    const src = fakeSource([mk("a", 100)]);
    await runListen(cenv, [src], now, stub.fn);
    await db.prepare("DELETE FROM cursors").run(); // force re-fetch of the same item
    await runListen(cenv, [src], now, stub.fn);
    expect(stub.calls()).toBe(1);
  });

  it("skips very short items without spending", async () => {
    const stub = claudeStub(() => high);
    await runListen(cenv, [fakeSource([mk("s", 100, "too short")])], now, stub.fn);
    expect(stub.calls()).toBe(0);
  });

  it("does not store malformed-output items, and counts them", async () => {
    const stub = claudeStub(() => "not json");
    const out = await runListen(cenv, [fakeSource([mk("m", 100)])], now, stub.fn);
    expect(out.skippedMalformed).toBe(1);
    expect(out.leads).toBe(0);
  });

  it("advances the cursor even when no items qualify", async () => {
    const stub = claudeStub(() => low);
    const src = fakeSource([mk("a", 100)]);
    await runListen(cenv, [src], now, stub.fn);
    expect(await getCursor(db, "test:src")).toBe("100");
  });

  it("does not store items when the model says patient info is present", async () => {
    const stub = claudeStub(() => '{"relevance":0.9,"pain_summary":"calls","patient_info_present":true}');
    await runListen(cenv, [fakeSource([mk("a", 100)])], now, stub.fn);
    const items = await db.prepare("SELECT excerpt, pain_summary, author_name FROM items").first();
    expect(items?.excerpt).toBe("[excerpt withheld: may contain patient details]");
    expect(items?.pain_summary).toBeNull();
    expect(items?.author_name).toBeNull();
  });

  it("keeps the author name only for leads", async () => {
    const stub = claudeStub((p) => (p.includes("QUALIFIED") ? high : low));
    const lead = mk("lead", 100, "QUALIFIED: Our front desk is drowning in insurance verification calls every day.");
    const nonLead = mk("other", 200, "I had a general thought about dental hygiene practices and protocols that I wanted to share with the community.");
    await runListen(cenv, [fakeSource([lead, nonLead])], now, stub.fn, 0.5);
    const items = await db.prepare("SELECT external_id, author_name FROM items ORDER BY created_utc").all();
    expect(items.results[0].author_name).toBe("dr_smith");
    expect(items.results[1].author_name).toBeNull();
  });

  it("stops at MAX_ITEMS_PER_RUN and leaves the cursor before the unprocessed ones", async () => {
    const stub = claudeStub(() => high);
    await runListen(cenv, [fakeSource([mk("a", 100), mk("b", 200), mk("c", 300)])], now, stub.fn, 0.7, 1, 2);
    expect(stub.calls()).toBe(2);
    expect(await getCursor(db, "test:src")).toBe("200");
  });

  it("round-robin: visits MAX_SOURCES_PER_RUN sources and continues from where it stopped", async () => {
    const stub = claudeStub(() => high);
    const sources = [
      { key: "a", async fetchRecent() { return [{ ...mk("a1", 100), source: "a" }]; } },
      { key: "b", async fetchRecent() { return [{ ...mk("b1", 100), source: "b" }]; } },
      { key: "c", async fetchRecent() { return [{ ...mk("c1", 100), source: "c" }]; } },
    ];
    await runListen(cenv, sources, now, stub.fn, 0.7, 2);
    expect(stub.calls()).toBe(2);
    const items = await db.prepare("SELECT source FROM items ORDER BY source").all();
    expect(items.results.map((r) => r.source)).toEqual(["a", "b"]);
    expect(await getCursor(db, "rr:listen")).toBe("2");
    await runListen(cenv, sources, now, stub.fn, 0.7, 2);
    expect(stub.calls()).toBe(3);
    const itemsAfter = await db.prepare("SELECT source FROM items ORDER BY source").all();
    expect(itemsAfter.results.map((r) => r.source)).toEqual(["a", "b", "c"]);
  });

  it("source selection and isolation > runListen > a failing source does not stop the others", async () => {
    const stub = claudeStub(() => high);
    const sources = [
      { key: "ok", async fetchRecent() { return [mk("ok", 100)]; } },
      { key: "broken", async fetchRecent(): Promise<SourceItem[]> { throw new Error("boom"); } },
    ];
    const out = await runListen(cenv, sources, now, stub.fn);
    expect(out.sourceErrors).toBe(1);
    expect(out.leads).toBe(1);
  });

  it("round-robin: wraps around correctly", async () => {
    const sources = [
      { key: "a", async fetchRecent() { return [] as SourceItem[]; } },
      { key: "b", async fetchRecent() { return [] as SourceItem[]; } },
    ];
    await db.prepare("INSERT INTO cursors (source_key, last_seen) VALUES (?, ?)").bind("rr:listen", "1").run();
    const noCall = (async () => { throw new Error("not called"); }) as unknown as typeof fetch;
    await runListen(cenv, sources, now, noCall, 0.7, 1);
    expect(await getCursor(db, "rr:listen")).toBe("0");
  });

  it("scoring threshold can be raised", async () => {
    const stub = claudeStub(() => '{"relevance":0.75,"pain_summary":"mid","patient_info_present":false}');
    const out1 = await runListen(cenv, [fakeSource([mk("a", 100)])], now, stub.fn, 0.7);
    expect(out1.leads).toBe(1);
    await db.prepare("DELETE FROM leads").run();
    await db.prepare("DELETE FROM items").run();
    await db.prepare("DELETE FROM cursors").run();
    const out2 = await runListen(cenv, [fakeSource([mk("a", 100)])], now, stub.fn, 0.8);
    expect(out2.leads).toBe(0);
  });

  it("filters out gratitude comments without spending on Claude", async () => {
    const stub = claudeStub(() => high);
    const out = await runListen(cenv, [fakeSource([mk("thanks", 100, "Thanks for the great tutorial! This was very helpful and I learned a lot from watching this.")])], now, stub.fn);
    expect(out.filteredOut).toBe(1);
    expect(stub.calls()).toBe(0);
  });

  it("filters out basic how-to questions without pain signals", async () => {
    const stub = claudeStub(() => high);
    const out = await runListen(cenv, [fakeSource([mk("q", 100, "How do I export a report from Open Dental? Can someone explain the steps? I'm new to this software.")])], now, stub.fn);
    expect(out.filteredOut).toBe(1);
    expect(stub.calls()).toBe(0);
  });

  it("does not filter questions that include pain/frustration signals", async () => {
    const stub = claudeStub(() => high);
    const out = await runListen(cenv, [fakeSource([mk("pain", 100, "How do I export a report? We're so overwhelmed trying to figure this out and it's very frustrating for our team.")])], now, stub.fn);
    expect(out.filteredOut).toBe(0);
    expect(stub.calls()).toBe(1);
  });
});

describe("Reddit source integration", () => {
  const mockFetch = (posts: unknown, comments: unknown): typeof fetch => {
    const token = JSON.stringify({ access_token: "test-token" });
    const fn = (async (url: RequestInfo | URL) => {
      if (url.toString().includes("/api/v1/access_token")) return new Response(token);
      if (url.toString().includes("/new")) return new Response(JSON.stringify(posts));
      return new Response(JSON.stringify(comments));
    }) as unknown as typeof fetch;
    return fn;
  };

  it("fetches posts and comments from Reddit", async () => {
    const stub = claudeStub(() => high);
    const fake = mockFetch(
      { data: { children: [{ data: { id: "p1", name: "t3_p1", author: "someone", title: "Help", selftext: "Our front desk is drowning in insurance verification calls every single day.", permalink: "/p1", created_utc: 100 } }] } },
      { data: { children: [{ data: { id: "c1", name: "t1_c1", author: "other", body: "Same here, the phone never stops ringing. It's exhausting dealing with this every day.", permalink: "/c1", created_utc: 200 } }] } },
    );
    const source = new RedditSource("dentistry", "id", "secret", fake);
    const out = await runListen(cenv, [source], now, stub.fn);
    expect(out.seen).toBe(2);
    expect(out.scored).toBe(2);
  });

  it("skips removed and deleted items", async () => {
    const stub = claudeStub(() => high);
    const fake = mockFetch(
      { data: { children: [{ data: { id: "gone", name: "t3_gone", selftext: "[removed]", permalink: "/gone", created_utc: 100 } }] } },
      { data: { children: [] } },
    );
    const source = new RedditSource("dentistry", "id", "secret", fake);
    const out = await runListen(cenv, [source], now, stub.fn);
    expect(out.seen).toBe(0);
  });
});
