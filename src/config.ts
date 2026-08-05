import "dotenv/config";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env: ${name}`);
  return v;
}

// Parse "label:key,label2:key2" into a Map<key, label>.
function parseKeys(raw: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = pair.indexOf(":");
    if (idx === -1) { m.set(pair, "unlabeled"); continue; }
    const label = pair.slice(0, idx).trim();
    const key = pair.slice(idx + 1).trim();
    if (key) m.set(key, label || "unlabeled");
  }
  return m;
}

// Claude Code's identity. The subscription OAuth token (`claude setup-token`) is
// only honoured on /v1/messages when the request presents as Claude Code — the
// FIRST system block must be exactly this string, or Anthropic rejects the token.
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  keys: parseKeys(req("BRAIN_KEYS", "")),
  backend: (process.env.BRAIN_BACKEND ?? "subscription") as "subscription" | "api",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  // The `claude setup-token` value (sk-ant-oat01-…). Long-lived subscription
  // OAuth bearer; used directly, no CLI/refresh needed.
  oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
  // Legacy fallback: source the token from the `ant` CLI OAuth profile instead.
  antBin: process.env.ANT_BIN ?? "ant",
  tokenRefreshMin: Number(process.env.TOKEN_REFRESH_MIN ?? 25),
  defaultModel: process.env.DEFAULT_MODEL ?? "claude-opus-4-8",
  anthropicVersion: process.env.ANTHROPIC_VERSION ?? "2023-06-01",
  // anthropic-beta header sent with the OAuth (subscription) token. Comma-separated.
  anthropicBeta: process.env.ANTHROPIC_BETA ?? "oauth-2025-04-20",
  // Prepend the Claude Code identity system block on the subscription backend.
  // On by default — turning it off will get the OAuth token rejected. Escape hatch only.
  injectClaudeCodeSystem: (process.env.INJECT_CLAUDE_CODE_SYSTEM ?? "1") === "1",
  claudeCodeSystem: CLAUDE_CODE_SYSTEM,
  maxConcurrency: Number(process.env.MAX_CONCURRENCY ?? 3),
  forwardSampling: (process.env.FORWARD_SAMPLING ?? "0") === "1",

  // --- Web search (server-side tool, runs on Anthropic's side) -------------
  // Enabled per-request with  "web_search": true  in the body, or by asking for
  // the "research" model. Claude runs the searches itself and answers with
  // citations; callers still just read choices[0].message.content.
  webSearch: {
    // _20260209 is the dynamic-filtering variant (Opus 4.6+, Sonnet 4.6+).
    toolType: process.env.WEB_SEARCH_TOOL_TYPE ?? "web_search_20260209",
    // Bounds cost/latency: how many searches Claude may run per request.
    maxUses: Number(process.env.WEB_SEARCH_MAX_USES ?? 8),
    // A server-tool turn can stop with stop_reason "pause_turn"; we resume it
    // this many times before returning whatever we have.
    maxContinuations: Number(process.env.WEB_SEARCH_MAX_CONTINUATIONS ?? 4),
    // Append a "Sources" list built from the response's citations.
    appendSources: (process.env.WEB_SEARCH_APPEND_SOURCES ?? "1") === "1",
  },
};

if (config.keys.size === 0) {
  console.warn("[ceg-brain] WARNING: BRAIN_KEYS is empty — every request will be rejected. Set app keys in .env.");
}
if (config.backend === "api" && !config.anthropicApiKey) {
  console.warn("[ceg-brain] WARNING: backend=api but ANTHROPIC_API_KEY is empty.");
}
if (config.backend === "subscription" && !config.oauthToken) {
  console.warn("[ceg-brain] WARNING: backend=subscription but CLAUDE_CODE_OAUTH_TOKEN is empty — will fall back to the `ant` CLI. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN for the subscription path.");
}
if (config.backend === "subscription" && config.anthropicApiKey) {
  console.warn("[ceg-brain] WARNING: both CLAUDE_CODE_OAUTH_TOKEN (subscription) and ANTHROPIC_API_KEY are set. The OAuth token is used; unset ANTHROPIC_API_KEY to avoid ambiguity.");
}
