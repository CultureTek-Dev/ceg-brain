import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { callAnthropic } from "../lib/anthropic.js";
import { toAnthropicBody, toOpenAIResponse, openAIChunk } from "../lib/translate.js";
import { resolveModel } from "../lib/models.js";

export function registerChat(app: FastifyInstance) {
  app.post("/v1/chat/completions", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as any;
    if (!body?.messages || !Array.isArray(body.messages)) {
      return reply.code(400).send({ error: { message: "messages[] is required" } });
    }
    const model = resolveModel(body.model);
    const anthropicBody = toAnthropicBody(body);
    const wantStream = body.stream === true;

    let upstream: Response;
    try {
      upstream = await callAnthropic(anthropicBody, wantStream);
    } catch (e: any) {
      const status = e?.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      req.log.error({ err: e?.message, label: (req as any).appLabel }, "upstream error");
      return reply.code(status).send({ error: { message: e?.message ?? "upstream error" } });
    }

    if (!wantStream) {
      const json = await upstream.json();
      const out = toOpenAIResponse(json, model);
      req.log.info({ label: (req as any).appLabel, model, usage: out.usage }, "completion");
      return reply.send(out);
    }

    // Streaming: translate Anthropic SSE → OpenAI chat.completion.chunk SSE.
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const write = (obj: unknown) => reply.raw.write(`data: ${JSON.stringify(obj)}\n\n`);
    write(openAIChunk(model, { role: "assistant" }));

    try {
      const decoder = new TextDecoder();
      let buf = "";
      // Node's fetch body is an async iterable of Uint8Array.
      for await (const chunk of upstream.body as any) {
        buf += decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = raw.split("\n").find((l) => l.startsWith("data:"));
          if (!line) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let evt: any;
          try { evt = JSON.parse(data); } catch { continue; }
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            write(openAIChunk(model, { content: evt.delta.text }));
          } else if (evt.type === "message_stop") {
            write(openAIChunk(model, {}, "stop"));
          }
        }
      }
    } catch (e: any) {
      req.log.error({ err: e?.message }, "stream error");
    } finally {
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    }
    return reply;
  });
}
