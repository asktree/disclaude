/**
 * Feature gates keyed on the Claude model ID.
 *
 * CLAUDE_MODEL can be overridden per deployment, so the request has to adapt to
 * whatever model is actually configured rather than assuming the default.
 */

// Models that accept `thinking: { type: "adaptive" }` and `output_config.effort`.
// Older models (Sonnet 4.5, Haiku 4.5, Sonnet 4, Opus 4.1, ...) reject both with a 400.
const ADAPTIVE_THINKING_PREFIXES = [
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
];

// Models whose safety classifiers can decline a request, where server-side
// refusal fallbacks are worth opting into.
const REFUSAL_FALLBACK_PREFIXES = ["claude-fable-5", "claude-mythos-5", "claude-opus-5"];

function matchesAny(model: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => model.startsWith(prefix));
}

export function supportsAdaptiveThinking(model: string): boolean {
  return matchesAny(model, ADAPTIVE_THINKING_PREFIXES);
}

export function supportsRefusalFallbacks(model: string): boolean {
  return matchesAny(model, REFUSAL_FALLBACK_PREFIXES);
}
