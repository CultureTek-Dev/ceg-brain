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

export function toAnthropicBody(
  body: OpenAIChatBody,
  opts: {
    searchHandledLocally?: boolean;
    searchContext?: string;
    /** CEG knowledge base, injected as a system block on the /v1/ceg route. */
    knowledge?: string;
    /** Mark the knowledge block cacheable — it is identical on every request. */
    cacheKnowledge?: boolean;
  } = {}
) {
  const system: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const m of body.messages ?? []) {
    if (m.role === "system") { system.push(textOf(m.content)); continue; }
    if (m.role === "assistant") { messages.push({ role: "assistant", content: textOf(m.content) }); continue; }
    // user, tool, function, etc. → treat as user input
    messages.push({ role: "user", content: textOf(m.content) });
  }

  // Search results go in as a user turn immediately before the question, so the
  // model treats them as given material rather than as instructions.
  if (opts.searchContext && messages.length) {
    messages.splice(messages.length - 1, 0, {
      role: "user",
      content: opts.searchContext,
    });
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
  //
  // Block order is load-bearing: identity, then CEG knowledge, then the
  // caller's own prompt. cache_control marks a cacheable prefix *through* the
  // block it sits on, so putting it on the knowledge block caches identity plus
  // knowledge together — the two parts that are byte-identical every call.
  const injectCC = config.backend === "subscription" && config.injectClaudeCodeSystem;
  type Block = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };

  if (injectCC || opts.knowledge) {
    const blocks: Block[] = [];
    if (injectCC) blocks.push({ type: "text", text: config.claudeCodeSystem });
    if (opts.knowledge) {
      blocks.push({
        type: "text",
        text: opts.knowledge,
        ...(opts.cacheKnowledge ? { cache_control: { type: "ephemeral" as const } } : {}),
      });
    }
    if (system.length) blocks.push({ type: "text", text: system.join("\n\n") });
    out.system = blocks;
  } else if (system.length) {
    out.system = system.join("\n\n");
  }

  // Web search. Two paths:
  //  - a search provider is configured → results are injected as context by the
  //    caller (see routes/chat.ts); no Anthropic tool is attached.
  //  - otherwise → fall back to Anthropic's server-side tool.
  if (wantsWebSearch(body) && !opts.searchHandledLocally) {
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
 * How the _20260209 web-search tool actually behaves.
 *
 * With dynamic filtering, Anthropic runs the search INSIDE code execution rather
 * than as a plain tool call. So a successful search looks like:
 *   server_tool_use { name: "code_execution", input.code: "... await web_search(...)" }
 *   code_execution_tool_result { content: { stdout: "<titles and urls>" } }
 * There are no web_search_tool_result blocks and no `citations` arrays — the
 * model reads the results out of stdout. Parsers written for the plain
 * web_search tool see nothing and wrongly report "never invoked".
 */
function isSearchCall(b: any): boolean {
  if (b?.type !== "server_tool_use") return false;
  if (b.name === "web_search") return true; // plain (non-filtering) variant
  return b.name === "code_execution" && /web_search\s*\(/.test(JSON.stringify(b.input ?? ""));
}

/**
 * Error codes from the search, if any. A failed search does NOT fail the
 * request — Claude answers without it and apologises in prose — so these codes
 * are the only way to tell "not entitled" from "rate limited".
 */
export function searchErrorsFrom(anthropic: any): string[] {
  const errors: string[] = [];
  for (const block of anthropic?.content ?? []) {
    // Plain variant.
    if (block?.type === "web_search_tool_result") {
      const c = block.content;
      if (c && !Array.isArray(c) && (c.error_code || c.type === "web_search_tool_result_error")) {
        errors.push(String(c.error_code ?? "unknown"));
      }
    }
    // Dynamic-filtering variant: the search runs in code execution.
    if (block?.type === "code_execution_tool_result") {
      const c = block.content;
      if (c?.error_code) errors.push(String(c.error_code));
      else if (typeof c?.return_code === "number" && c.return_code !== 0) {
        errors.push(`exit ${c.return_code}: ${(c.stderr ?? "").slice(0, 200)}`);
      }
    }
  }
  return errors;
}

/** How many searches Claude actually ran. */
export function searchAttempts(anthropic: any): number {
  return (anthropic?.content ?? []).filter(isSearchCall).length;
}

/**
 * Collect unique sources from a response's citations so the answer carries its
 * references even though we only return plain text.
 */
export function sourcesFrom(anthropic: any, limit = 12): string[] {
  const seen = new Map<string, string>();

  for (const block of anthropic?.content ?? []) {
    // Plain variant: proper citation objects on text blocks.
    if (block?.type === "text") {
      for (const c of block.citations ?? []) {
        if (c?.url && !seen.has(c.url)) seen.set(c.url, c.title || c.url);
      }
    }
    // Dynamic-filtering variant: the model prints results to stdout, so the URLs
    // are in the code-execution output rather than in a citations array.
    if (block?.type === "code_execution_tool_result") {
      const stdout: string = block?.content?.stdout ?? "";
      for (const m of stdout.matchAll(/https?:\/\/[^\s)"'`\]]+/g)) {
        const url = m[0].replace(/[.,;:]+$/, "");
        if (!seen.has(url)) seen.set(url, url);
      }
    }
  }

  return [...seen]
    .slice(0, limit)
    .map(([url, title]) => (title === url ? `- ${url}` : `- [${title}](${url})`));
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
