import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { callAnthropic, callAnthropicJson } from "../lib/anthropic.js";
import {
  toAnthropicBody,
  toOpenAIResponse,
  openAIChunk,
  wantsWebSearch,
  sourcesFrom,
  searchErrorsFrom,
  searchAttempts,
} from "../lib/translate.js";
import { resolveModel } from "../lib/models.js";
import { config } from "../config.js";
import * as search from "../lib/search.js";

export function registerChat(app: FastifyInstance) {
  app.post("/v1/chat/completions", async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as any;
    if (!body?.messages || !Array.isArray(body.messages)) {
      return reply.code(400).send({ error: { message: "messages[] is required" } });
    }
    const model = resolveModel(body.model);
    const wantStream = body.stream === true;
    const searching = wantsWebSearch(body);

    // Prefer brain-side search when a provider is configured: Anthropic's
    // server-side tool is entitled on the subscription token but rate-limited
    // to the point of being unusable.
    let localResults: search.SearchResult[] = [];
    let searchContext: string | undefined;
    const useLocalSearch = searching && search.enabled();

    if (useLocalSearch) {
      const query = [...(body.messages ?? [])]
        .reverse()
        .find((m: any) => m.role === "user");
      const q =
        typeof query?.content === "string"
          ? query.content
          : JSON.stringify(query?.content ?? "");
      try {
        localResults = await search.search(q);
        if (localResults.length) searchContext = search.asContext(localResults, q);
        req.log.info(
          { label: (req as any).appLabel, provider: config.search.provider, results: localResults.length },
          "search"
        );
      } catch (e: any) {
        req.log.error({ err: e?.message, provider: config.search.provider }, "search failed");
      }
    }

    const anthropicBody = toAnthropicBody(body, {
      searchHandledLocally: useLocalSearch,
      searchContext,
    });

    // Non-streaming: resolve any paused server-tool turns before replying.
    if (!wantStream) {
      try {
        const json = await callAnthropicJson(anthropicBody);
        const out = toOpenAIResponse(json, model);

        // Web search answers are only useful with their references attached.
        if (searching && config.webSearch.appendSources) {
          const sources = useLocalSearch
            ? localResults.map((r) => `- [${r.title}](${r.url})`)
            : sourcesFrom(json);
          if (sources.length && out.choices[0]?.message) {
            out.choices[0].message.content += `\n\n**Sources**\n${sources.join("\n")}`;
          }
        }

        // A failed search still returns HTTP 200 with a confident-sounding answer
        // built from training data. For a research request that is worse than an
        // error — the caller can't tell a sourced answer from a remembered one —
        // so say it in the response, not just the logs.
        if (searching) {
          const errors = useLocalSearch ? [] : searchErrorsFrom(json);
          const attempts = useLocalSearch ? localResults.length : searchAttempts(json);

          if (errors.length) {
            req.log.error({ label: (req as any).appLabel, attempts, errors }, "web_search failed");
          } else if (attempts === 0) {
            req.log.warn({ label: (req as any).appLabel }, "web_search never invoked");
          }

          const searched = useLocalSearch
            ? localResults.length > 0
            : attempts > 0 && errors.length < attempts;
          if (!searched && out.choices[0]?.message) {
            const why = errors.includes("too_many_requests")
              ? "the web-search quota is currently exhausted"
              : errors.length
                ? `web search failed (${[...new Set(errors)].join(", ")})`
                : "no web search was performed";
            out.choices[0].message.content =
              `> ⚠️ **Unverified — ${why}.** The answer below comes from the model's training data and may be out of date. Check it before relying on it.\n\n` +
              out.choices[0].message.content;
          }
        }

        req.log.info(
          { label: (req as any).appLabel, model, searching, usage: out.usage },
          "completion"
        );
        return reply.send(out);
      } catch (e: any) {
        const status = e?.status && e.status >= 400 && e.status < 600 ? e.status : 502;
        req.log.error({ err: e?.message, label: (req as any).appLabel }, "upstream error");
        return reply.code(status).send({ error: { message: e?.message ?? "upstream error" } });
      }
    }

    let upstream: Response;
    try {
      upstream = await callAnthropic(anthropicBody, wantStream);
    } catch (e: any) {
      const status = e?.status && e.status >= 400 && e.status < 600 ? e.status : 502;
      req.log.error({ err: e?.message, label: (req as any).appLabel }, "upstream error");
      return reply.code(status).send({ error: { message: e?.message ?? "upstream error" } });
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
