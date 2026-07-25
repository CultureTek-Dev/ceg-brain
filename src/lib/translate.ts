import { config } from "../config.js";
import { resolveModel } from "./models.js";

// --- OpenAI request → Anthropic Messages request ------------------------

interface OpenAIMessage { role: string; content: unknown; }
interface OpenAIChatBody {
  model?: string;
  messages: OpenAIMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
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
  if (system.length) out.system = system.join("\n\n");
  if (config.forwardSampling) {
    if (typeof body.temperature === "number") out.temperature = body.temperature;
    if (typeof body.top_p === "number") out.top_p = body.top_p;
  }
  return out;
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
