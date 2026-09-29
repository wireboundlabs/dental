import type { Env } from "../env";
import { buildDigest } from "./build";

/**
 * Sends the daily digest. This is the ONLY outbound email in the system, and the ONLY recipient is
 * OWNER_EMAIL. (wrangler.jsonc also restricts the binding with allowed_destination_addresses.)
 */
export async function sendDigest(
  env: Pick<Env, "DB" | "DAILY_BUDGET_USD" | "EMAIL" | "OWNER_EMAIL" | "DIGEST_FROM">,
  now: Date = new Date(),
): Promise<void> {
  if (!env.OWNER_EMAIL || !env.DIGEST_FROM) throw new Error("OWNER_EMAIL and DIGEST_FROM must be configured");
  const { subject, text } = await buildDigest(env, now);
  await env.EMAIL.send({ to: env.OWNER_EMAIL, from: env.DIGEST_FROM, subject, text });
}
