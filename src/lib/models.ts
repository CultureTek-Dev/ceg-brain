import { config } from "../config.js";

/**
 * Map an incoming model name to a Claude model id.
 * - Anything starting with "claude" passes through unchanged.
 * - A few OpenAI-ish aliases map to sensible Claude tiers so apps written for
 *   the OpenAI SDK "just work" without knowing Claude ids.
 * - Everything else falls back to DEFAULT_MODEL.
 */
const ALIASES: Record<string, string> = {
  "gpt-4o": "claude-opus-4-8",
  "gpt-4o-mini": "claude-haiku-4-5",
  "gpt-4": "claude-opus-4-8",
  "gpt-4-turbo": "claude-opus-4-8",
  "gpt-3.5-turbo": "claude-haiku-4-5",
  "opus": "claude-opus-4-8",
  "sonnet": "claude-sonnet-5",
  "haiku": "claude-haiku-4-5",
  // Sugar: "research" = the most capable model with web search switched on.
  "research": "claude-opus-4-8",
};

/** Model names that imply web search without the caller passing the flag. */
const SEARCH_MODELS = new Set(["research"]);

export function impliesWebSearch(requested?: string): boolean {
  return !!requested && SEARCH_MODELS.has(requested.toLowerCase());
}

export function resolveModel(requested?: string): string {
  if (!requested) return config.defaultModel;
  if (requested.startsWith("claude")) return requested;
  return ALIASES[requested] ?? config.defaultModel;
}

// For GET /v1/models (some OpenAI SDKs probe this).
export const LISTED_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-haiku-4-5",
];
