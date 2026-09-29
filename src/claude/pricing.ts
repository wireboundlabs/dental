// USD per million tokens. Update here if Anthropic pricing changes.
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

/** Cost of one call. Unknown models throw, so the budget guard fails closed. */
export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICES[model];
  if (!p) throw new Error(`No price configured for model "${model}"`);
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}
