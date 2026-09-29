import { verifyAccess } from "../access";
import { editDraft, listDraftsByStatus, transitionDraft, type DraftStatus } from "../db/queries";
import type { Env } from "../env";
import { renderDashboard } from "./html";

type DashboardEnv = Pick<Env, "DB" | "ACCESS_AUD" | "ACCESS_TEAM_DOMAIN"> & { ACCESS_DEV_BYPASS?: string };

const STATUSES: DraftStatus[] = ["pending", "approved", "sent", "rejected"];
const ACTIONS: Record<string, DraftStatus> = { approve: "approved", reject: "rejected", sent: "sent" };

const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  // Not "no-referrer": that makes browsers send "Origin: null" on same-site form POSTs, which the CSRF check rejects.
  // Cross-site navigations still send no referrer. Outbound links also carry rel="noreferrer".
  "referrer-policy": "same-origin",
  "cache-control": "no-store",
};

function isLocalDev(url: URL, env: DashboardEnv): boolean {
  return env.ACCESS_DEV_BYPASS === "1" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/** Approval dashboard. Fails closed without a valid Cloudflare Access identity. */
export async function handleDashboard(
  request: Request,
  env: DashboardEnv,
  now: Date = new Date(),
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const url = new URL(request.url);
  const identity = isLocalDev(url, env)
    ? { email: "local-dev" }
    : await verifyAccess(request, env, now, fetchFn);
  if (!identity) return new Response("Forbidden", { status: 403 });

  if (request.method === "GET" && url.pathname === "/") {
    const raw = url.searchParams.get("status") as DraftStatus | null;
    const status: DraftStatus = raw && STATUSES.includes(raw) ? raw : "pending";
    const drafts = await listDraftsByStatus(env.DB, status);
    return new Response(renderDashboard(drafts, status, identity.email), {
      headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS },
    });
  }

  const m = url.pathname.match(/^\/drafts\/(\d+)\/(approve|reject|sent|edit)$/);
  if (request.method === "POST" && m) {
    // CSRF: browsers always send Origin on cross-site POSTs. Require it to match.
    if (request.headers.get("Origin") !== url.origin) return new Response("Bad origin", { status: 403 });
    const id = Number(m[1]);
    const action = m[2];
    let ok: boolean;
    let back: DraftStatus = "pending";
    if (action === "edit") {
      const body = String((await request.formData()).get("body") ?? "").trim();
      ok = body.length > 0 && body.length <= 5000 && (await editDraft(env.DB, id, body, now));
    } else {
      ok = await transitionDraft(env.DB, id, ACTIONS[action], now);
      if (action === "sent") back = "approved";
    }
    if (!ok) return new Response("Not allowed", { status: 409, headers: SECURITY_HEADERS });
    return new Response(null, { status: 303, headers: { location: `/?status=${back}` } });
  }

  return new Response("Not found", { status: 404 });
}
