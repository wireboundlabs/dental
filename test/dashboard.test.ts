import { env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyAccess } from "../src/access";
import { handleDashboard } from "../src/dashboard/routes";
import { getDraft, insertDraft, insertItemIfNew, insertLead } from "../src/db/queries";

const db = env.DB;
const now = new Date("2026-09-29T12:00:00Z");
const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-123";

const b64url = (data: ArrayBuffer | string) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  bytes.forEach((b) => (s += String.fromCharCode(b)));
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

let keyPair: CryptoKeyPair;
let otherKeyPair: CryptoKeyPair;
let jwks: { keys: object[] };

async function makeKeys() {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
}

async function sign(claims: object, pair = keyPair, kid = "k1") {
  const h = b64url(JSON.stringify({ alg: "RS256", kid }));
  const p = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

const goodClaims = () => ({
  aud: [AUD],
  iss: `https://${TEAM}`,
  exp: Math.floor(now.getTime() / 1000) + 600,
  email: "me@example.com",
});

const certsFetch = (() => async () => new Response(JSON.stringify(jwks))) as () => typeof fetch;
const denv = { ...env, ACCESS_AUD: AUD, ACCESS_TEAM_DOMAIN: TEAM };

const req = (path: string, token: string | null, init: RequestInit = {}) =>
  new Request(`https://app.example.com${path}`, {
    ...init,
    headers: { ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}), ...(init.headers ?? {}) },
  });

beforeAll(async () => {
  keyPair = await makeKeys();
  otherKeyPair = await makeKeys();
  const pub = (await crypto.subtle.exportKey("jwk", keyPair.publicKey)) as JsonWebKey;
  jwks = { keys: [{ ...pub, kid: "k1" }] };
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM drafts"),
    db.prepare("DELETE FROM leads"),
    db.prepare("DELETE FROM items"),
  ]);
});

describe("verifyAccess", () => {
  it("accepts a valid token", async () => {
    const id = await verifyAccess(req("/", await sign(goodClaims())), denv, now, certsFetch());
    expect(id).toEqual({ email: "me@example.com" });
  });

  it("rejects: no header", async () => {
    expect(await verifyAccess(req("/", null), denv, now, certsFetch())).toBeNull();
  });

  it("rejects: signed by a different key", async () => {
    const t = await sign(goodClaims(), otherKeyPair);
    expect(await verifyAccess(req("/", t), denv, now, certsFetch())).toBeNull();
  });

  it("rejects: tampered payload", async () => {
    const [h, , s] = (await sign(goodClaims())).split(".");
    const forged = b64url(JSON.stringify({ ...goodClaims(), email: "evil@example.com" }));
    expect(await verifyAccess(req("/", `${h}.${forged}.${s}`), denv, now, certsFetch())).toBeNull();
  });

  it("rejects: wrong audience, wrong issuer, expired", async () => {
    for (const bad of [
      { ...goodClaims(), aud: ["other"] },
      { ...goodClaims(), iss: "https://evil.cloudflareaccess.com" },
      { ...goodClaims(), exp: Math.floor(now.getTime() / 1000) - 1 },
    ]) {
      expect(await verifyAccess(req("/", await sign(bad)), denv, now, certsFetch())).toBeNull();
    }
  });

  it("rejects: unknown kid, alg none, missing config", async () => {
    expect(await verifyAccess(req("/", await sign(goodClaims(), keyPair, "zzz")), denv, now, certsFetch())).toBeNull();
    const none = `${b64url(JSON.stringify({ alg: "none", kid: "k1" }))}.${b64url(JSON.stringify(goodClaims()))}.`;
    expect(await verifyAccess(req("/", none), denv, now, certsFetch())).toBeNull();
    expect(
      await verifyAccess(req("/", await sign(goodClaims())), { ACCESS_AUD: "", ACCESS_TEAM_DOMAIN: "" }, now, certsFetch()),
    ).toBeNull();
  });

  it("rejects when the certs endpoint fails", async () => {
    const failing = (async () => new Response("x", { status: 500 })) as unknown as typeof fetch;
    expect(await verifyAccess(req("/", await sign(goodClaims())), denv, now, failing)).toBeNull();
  });
});

describe("dashboard", () => {
  async function seedDraft(body = "How do you handle this today?") {
    const itemId = await insertItemIfNew(
      db,
      { source: "reddit:dentistry", externalId: crypto.randomUUID(), url: "https://reddit.com/r/x/1", authorHash: null, excerpt: "e", createdUtc: 1 },
      now,
    );
    const leadId = await insertLead(db, { itemId: itemId!, score: 0.9, painSummary: "<script>alert(1)</script> pain" }, now);
    return insertDraft(db, { leadId, kind: "reply", body }, now);
  }

  const post = async (path: string, form: Record<string, string> = {}, origin = "https://app.example.com") =>
    handleDashboard(
      req(path, await sign(goodClaims()), {
        method: "POST",
        body: new URLSearchParams(form),
        headers: { Origin: origin },
      }),
      denv,
      now,
      certsFetch(),
    );

  it("returns 403 without a valid Access token", async () => {
    expect((await handleDashboard(req("/", null), denv, now, certsFetch())).status).toBe(403);
    const forged = await sign(goodClaims(), otherKeyPair);
    expect((await handleDashboard(req("/", forged), denv, now, certsFetch())).status).toBe(403);
  });

  it("does not allow the dev bypass off localhost", async () => {
    const res = await handleDashboard(req("/", null), { ...denv, ACCESS_DEV_BYPASS: "1" }, now, certsFetch());
    expect(res.status).toBe(403);
  });

  it("lists pending drafts, escaping content, with a copy button", async () => {
    await seedDraft();
    const res = await handleDashboard(req("/", await sign(goodClaims())), denv, now, certsFetch());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain("How do you handle this today?");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain('class="copy"');
    expect(html).toContain("Approve");
  });

  it("flags risky drafts in the UI", async () => {
    await seedDraft("Check out https://example.com!");
    const html = await (await handleDashboard(req("/", await sign(goodClaims())), denv, now, certsFetch())).text();
    expect(html).toContain("contains a link");
  });

  it("approve -> mark as sent flow", async () => {
    const id = await seedDraft();
    expect((await post(`/drafts/${id}/sent`)).status).toBe(409); // not approved yet
    expect((await post(`/drafts/${id}/approve`)).status).toBe(303);
    expect((await getDraft(db, id))?.status).toBe("approved");
    expect((await post(`/drafts/${id}/sent`)).status).toBe(303);
    const d = await getDraft(db, id);
    expect(d?.status).toBe("sent");
    expect(d?.sent_at).toBe(now.toISOString());
  });

  it("reject blocks further actions", async () => {
    const id = await seedDraft();
    expect((await post(`/drafts/${id}/reject`)).status).toBe(303);
    expect((await post(`/drafts/${id}/approve`)).status).toBe(409);
  });

  it("edit stores edited_body and rejects empty edits", async () => {
    const id = await seedDraft("orig");
    expect((await post(`/drafts/${id}/edit`, { body: "better wording" })).status).toBe(303);
    expect((await getDraft(db, id))?.edited_body).toBe("better wording");
    expect((await post(`/drafts/${id}/edit`, { body: "   " })).status).toBe(409);
  });

  it("blocks cross-origin and origin-less POSTs (CSRF)", async () => {
    const id = await seedDraft();
    expect((await post(`/drafts/${id}/approve`, {}, "https://evil.example")).status).toBe(403);
    const noOrigin = await handleDashboard(
      req(`/drafts/${id}/approve`, await sign(goodClaims()), { method: "POST" }),
      denv,
      now,
      certsFetch(),
    );
    expect(noOrigin.status).toBe(403);
    expect((await getDraft(db, id))?.status).toBe("pending");
  });

  it("returns 404 for unknown routes", async () => {
    const res = await handleDashboard(req("/nope", await sign(goodClaims())), denv, now, certsFetch());
    expect(res.status).toBe(404);
  });
});
