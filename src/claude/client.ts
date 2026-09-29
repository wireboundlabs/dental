import { assertWithinBudget, getDailyCap } from "../budget";
import { recordApiCall, recordCapHit, spentOnDay, utcDay } from "../db/queries";
import type { Env } from "../env";
import { RateLimitError, backoffFromHeaders } from "../rate-limit";
import { costUsd } from "./pricing";

export interface ClaudeRequest {
  agent: string;
  system: string;
  user: string;
  maxTokens: number;
  leadId?: number;
}

export interface ClaudeResult {
  text: string;
  costUsd: number;
}

type ClaudeEnv = Pick<Env, "DB" | "ANTHROPIC_API_KEY" | "DAILY_BUDGET_USD" | "CLAUDE_MODEL">;

/**
 * The ONLY way the app calls the Anthropic API.
 * Checks the daily budget first, then records the actual cost in D1.
 */
export async function callClaude(
  env: ClaudeEnv,
  req: ClaudeRequest,
  now: Date = new Date(),
  fetchFn: typeof fetch = fetch,
): Promise<ClaudeResult> {
  const cap = getDailyCap(env.DAILY_BUDGET_USD);
  // Generous upper bound: ~3 chars per token for input, full max_tokens for output.
  const estInput = Math.ceil((req.system.length + req.user.length) / 3) + 50;
  const worstCase = costUsd(env.CLAUDE_MODEL, estInput, req.maxTokens);
  await assertWithinBudget(env.DB, cap, worstCase, now);

  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    }),
  });
  if (res.status === 429 || res.status === 529) {
    throw new RateLimitError(`Anthropic API error ${res.status}`, backoffFromHeaders(res.headers, 60));
  }
  if (!res.ok) {
    throw new Error(`Anthropic API error ${res.status}`);
  }
  const data = (await res.json()) as {
    content: { type: string; text?: string }[];
    usage: { input_tokens: number; output_tokens: number };
  };

  const cost = costUsd(env.CLAUDE_MODEL, data.usage.input_tokens, data.usage.output_tokens);
  await recordApiCall(
    env.DB,
    {
      agent: req.agent,
      model: env.CLAUDE_MODEL,
      inputTokens: data.usage.input_tokens,
      outputTokens: data.usage.output_tokens,
      costUsd: cost,
      leadId: req.leadId,
    },
    now,
  );
  const day = utcDay(now);
  const spent = await spentOnDay(env.DB, day);
  if (spent >= cap) await recordCapHit(env.DB, day, spent, now);

  const text = data.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");
  return { text, costUsd: cost };
}
