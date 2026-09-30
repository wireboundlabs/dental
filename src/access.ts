import type { Env } from "./env";

const ACCESS_CERT_TIMEOUT_MS = 5000;

// Defense in depth: Cloudflare Access sits in front of the Worker, and the Worker
// independently verifies the Access JWT. Anything that fails verification is denied.

interface Jwk extends JsonWebKey {
  kid?: string;
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeJson<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as T;
}

export interface AccessIdentity {
  email: string;
}

type AccessEnv = Pick<Env, "ACCESS_AUD" | "ACCESS_TEAM_DOMAIN">;

/**
 * Verifies the Cf-Access-Jwt-Assertion header. Returns the identity, or null if anything is wrong
 * (missing config, bad signature, wrong audience/issuer, expired).
 */
export async function verifyAccess(
  request: Request,
  env: AccessEnv,
  now: Date = new Date(),
  fetchFn: typeof fetch = fetch,
): Promise<AccessIdentity | null> {
  if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = decodeJson<{ alg?: string; kid?: string }>(parts[0]);
    const claims = decodeJson<{ aud?: string[] | string; iss?: string; exp?: number; email?: string }>(parts[1]);
    if (header.alg !== "RS256" || !header.kid) return null;

    const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
    if (claims.iss !== issuer) return null;
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now.getTime()) return null;
    if (!claims.email) return null;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), ACCESS_CERT_TIMEOUT_MS);
    try {
      const certsRes = await fetchFn(`${issuer}/cdn-cgi/access/certs`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (!certsRes.ok) return null;
      const { keys } = (await certsRes.json()) as { keys: Jwk[] };
      const jwk = keys.find((k) => k.kid === header.kid);
      if (!jwk) return null;

      const key = await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      const ok = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        b64urlToBytes(parts[2]),
        new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
      );
      return ok ? { email: claims.email } : null;
    } catch (err) {
      clearTimeout(timeoutId);
      return null;
    }
  } catch {
    return null;
  }
}
