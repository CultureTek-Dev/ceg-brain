import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { callAnthropicJson, callAnthropic } from "../lib/anthropic.js";
import { toAnthropicBody, toOpenAIResponse, openAIChunk } from "../lib/translate.js";
import { resolveModel } from "../lib/models.js";
import { config } from "../config.js";
import * as knowledge from "../lib/knowledge.js";

/**
 * POST /v1/ceg/chat/completions — inference that already knows CEG.
 *
 * Deliberately a separate route rather than a flag on the main one. The
 * knowledge base is a few thousand tokens on every request, and a caller that
 * only wants a model call shouldn't pay for the company's org chart because
 * someone forgot to unset a flag. Choosing the endpoint IS the opt-in.
 *
 * Identical OpenAI shape otherwise, so an app switches by changing baseURL.
 */
export function registerCeg(app: FastifyInstance) {
  app.get("/v1/ceg/knowledge", async () => ({
    loaded: knowledge.loaded(),
    ...knowledge.info(),
    cached: config.knowledge.cache,
  }));

  // Re-read from disk after the files are updated on the VPS, without a restart.
  app.post("/v1/ceg/knowledge/reload", async (req) => {
    const before = knowledge.info().bytes;
    const k = knowledge.load();
    req.log.info({ before, after: k.bytes, files: k.files }, "knowledge reloaded");
    return { reloaded: true, files: k.files, bytes: k.bytes, loadedAt: k.loadedAt };
  });

  app.post("/v1/ceg/chat/completions", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as any;
    if (!body?.messages || !Array.isArray(body.messages)) {
      return reply.code(400).send({ error: { message: "messages[] is required" } });
    }

    // Answering "as CEG" without the knowledge would silently degrade to a
    // generic model with a confident tone — the exact failure this endpoint
    // exists to prevent. Refuse instead.
    if (!knowledge.loaded()) {
      return reply.code(503).send({
        error: {
          message:
            "CEG knowledge base is not loaded. Set CEG_KNOWLEDGE_DIR to a directory of .md files and restart, or POST /v1/ceg/knowledge/reload.",
        },
      });
    }

    const model = resolveModel(body.model);
    const wantStream = body.stream === true;
    const anthropicBody = toAnthropicBody(body, {
      knowledge: knowledge.systemBlock(),
      cacheKnowledge: config.knowledge.cache,
    });

    if (!wantStream) {
      try {
        const json = await callAnthropicJson(anthropicBody);
        const out = toOpenAIResponse(json, model);
        req.log.info(
          {
            label: (req as any).appLabel,
            model,
            knowledgeBytes: knowledge.info().bytes,
            // Cache hits are the whole point of the ephemeral block; log them so
            // it's visible whether caching is actually working.
            cacheRead: json.usage?.cache_read_input_tokens ?? 0,
            cacheWrite: json.usage?.cache_creation_input_tokens ?? 0,
            usage: out.usage,
          },
          "ceg completion"
        );
        return reply.send(out);
      } catch (e: any) {
        const status = e?.status && e.status >= 400 && e.status < 600 ? e.status : 502;
        req.log.error({ err: e?.message, label: (req as any).appLabel }, "ceg upstream error");
        return reply.code(status).send({ error: { message: e?.message ?? "upstream error" } });
      }
    }

    let upstream: Response;
    try {
      upstream = await callAnthropic(anthropicBody, true);
    } catch (e: any) {
      const status = e?.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      return reply.code(status).send({ error: { message: e?.message ?? "upstream error" } });
    }

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
      req.log.error({ err: e?.message }, "ceg stream error");
    } finally {
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    }
    return reply;
  });
}
