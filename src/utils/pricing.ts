/**
 * Claude API prices in USD, from https://platform.claude.com/docs/en/about-claude/pricing
 * (checked 2026-10-05). Standard global pricing: no batch, fast mode or data residency.
 */
export interface ModelPrice {
  input: number; // per million tokens
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

// Longest prefix first, so "claude-opus-5-5" wins over "claude-opus-5"
const PRICES: [prefix: string, price: ModelPrice][] = [
  ["claude-opus-5-5", { input: 4, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2, output: 20 }],
  ["claude-opus-5", { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 }],
  [
    "claude-opus-4-8",
    { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  ],
  [
    "claude-opus-4-7",
    { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  ],
  [
    "claude-opus-4-6",
    { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  ],
  [
    "claude-opus-4-5",
    { input: 5, cacheWrite5m: 6.25, cacheWrite1h: 10, cacheRead: 0.5, output: 25 },
  ],
  [
    "claude-fable-5-1",
    { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25, output: 50 },
  ],
  ["claude-fable-5", { input: 10, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 1, output: 50 }],
  [
    "claude-sonnet-5-5",
    { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 },
  ],
  ["claude-sonnet-5", { input: 2, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2, output: 10 }],
  [
    "claude-sonnet-4-6",
    { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  ],
  [
    "claude-sonnet-4-5",
    { input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  ],
  [
    "claude-haiku-4-5",
    { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 },
  ],
];

export const WEB_SEARCH_PRICE_USD = 0.01; // $10 per 1,000 searches

export function priceFor(model: string): ModelPrice | undefined {
  return PRICES.find(([prefix]) => model.startsWith(prefix))?.[1];
}

export interface BillableUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  webSearches: number;
}

/** Cost in USD, or undefined when the model has no known price. */
export function costUsd(model: string, u: BillableUsage): number | undefined {
  const p = priceFor(model);
  if (!p) return undefined;
  const tokens =
    u.inputTokens * p.input +
    u.cacheWrite5mTokens * p.cacheWrite5m +
    u.cacheWrite1hTokens * p.cacheWrite1h +
    u.cacheReadTokens * p.cacheRead +
    u.outputTokens * p.output;
  return tokens / 1_000_000 + u.webSearches * WEB_SEARCH_PRICE_USD;
}
