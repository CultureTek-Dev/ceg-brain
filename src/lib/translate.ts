import { config } from "../config.js";
import { resolveModel, impliesWebSearch } from "./models.js";

/** Should this request run with the web-search server tool? */
export function wantsWebSearch(body: { model?: string; web_search?: boolean }): boolean {
  return body.web_search === true || impliesWebSearch(body.model);
}

// --- OpenAI request → Anthropic Messages request ------------------------

interface OpenAIMessage { role: string; content: unknown; }
interface OpenAIChatBody {
  model?: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  /** Non-standard: let Claude search the web and answer with citations. */
  web_search?: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === "string" ? p : p?.type === "text" ? p.text : ""))
      .join("");
  }
  return "";
}

export function toAnthropicBody(body: OpenAIChatBody) {
  const system: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const m of body.messages ?? []) {
    if (m.role === "system") { system.push(textOf(m.content)); continue; }
    if (m.role === "assistant") { messages.push({ role: "assistant", content: textOf(m.content) }); continue; }
    // user, tool, function, etc. → treat as user input
    messages.push({ role: "user", content: textOf(m.content) });
  }

  const out: Record<string, unknown> = {
    model: resolveModel(body.model),
    max_tokens: body.max_tokens ?? 4096,
    messages,
  };

  // System prompt. On the subscription (OAuth) backend the token is only honoured
  // when the request presents as Claude Code: the FIRST system block must be the
  // Claude Code identity string. We use the array form so the caller's own system
  // prompt is preserved as a second block right after it.
  const injectCC = config.backend === "subscription" && config.injectClaudeCodeSystem;
  if (injectCC) {
    const blocks: Array<{ type: "text"; text: string }> = [
      { type: "text", text: config.claudeCodeSystem },
    ];
    if (system.length) blocks.push({ type: "text", text: system.join("\n\n") });
    out.system = blocks;
  } else if (system.length) {
    out.system = system.join("\n\n");
  }

  // Web search runs server-side on Anthropic's infrastructure: Claude issues the
  // queries and answers with citations, so the caller still just reads text.
  if (wantsWebSearch(body)) {
    out.tools = [
      {
        type: config.webSearch.toolType,
        name: "web_search",
        max_uses: config.webSearch.maxUses,
      },
    ];
  }

  if (config.forwardSampling) {
    if (typeof body.temperature === "number") out.temperature = body.temperature;
    if (typeof body.top_p === "number") out.top_p = body.top_p;
  }
  return out;
}

/**
 * Error codes reported by the web_search server tool, if any.
 *
 * A failed search does NOT fail the request: Claude just answers without it and
 * says so in prose, which looks like "search silently did nothing". Surfacing
 * the codes is the only way to tell "not entitled" from "rate limited".
 */
export function searchErrorsFrom(anthropic: any): string[] {
  const errors: string[] = [];
  for (const block of anthropic?.content ?? []) {
    if (block?.type !== "web_search_tool_result") continue;
    const c = block.content;
    // Success is a LIST of results; an error is a single object.
    if (c && !Array.isArray(c) && (c.error_code || c.type === "web_search_tool_result_error")) {
      errors.push(String(c.error_code ?? "unknown"));
    }
  }
  return errors;
}

/** Did Claude actually attempt any searches? */
export function searchAttempts(anthropic: any): number {
  return (anthropic?.content ?? []).filter(
    (b: any) => b?.type === "server_tool_use" && b?.name === "web_search"
  ).length;
}

/**
 * Collect unique sources from a response's citations so the answer carries its
 * references even though we only return plain text.
 */
export function sourcesFrom(anthropic: any): string[] {
  const seen = new Map<string, string>();
  for (const block of anthropic?.content ?? []) {
    if (block?.type !== "text") continue;
    for (const c of block.citations ?? []) {
      const url = c?.url;
      if (url && !seen.has(url)) seen.set(url, c.title || url);
    }
  }
  return [...seen].map(([url, title]) => `- [${title}](${url})`);
}

// --- Anthropic non-stream response → OpenAI chat.completion -------------

export function toOpenAIResponse(anthropic: any, model: string) {
  const text = (anthropic.content ?? [])
    .filter((b: any) => b.type === "text")
    .map((b: any) => b.text)
    .join("");
  const finish = anthropic.stop_reason === "max_tokens" ? "length" : "stop";
  return {
    id: `chatcmpl-${anthropic.id ?? Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: "assistant", content: text }, finish_reason: finish },
    ],
    usage: {
      prompt_tokens: anthropic.usage?.input_tokens ?? 0,
      completion_tokens: anthropic.usage?.output_tokens ?? 0,
      total_tokens: (anthropic.usage?.input_tokens ?? 0) + (anthropic.usage?.output_tokens ?? 0),
    },
  };
}

// --- Anthropic SSE event → OpenAI chat.completion.chunk ----------------

export function openAIChunk(model: string, delta: Record<string, unknown>, finish: string | null = null) {
  return {
    id: `chatcmpl-stream-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}
