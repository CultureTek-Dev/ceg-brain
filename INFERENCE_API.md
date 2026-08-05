# CEG Inference API

An **OpenAI-compatible** chat‑completions API. If your language or framework already
has an OpenAI SDK, you can use this service by changing two things: the **base URL** and
the **API key**. Nothing else about your code needs to change.

- **Base URL:** `http://200.141.3.47:8787/v1`
- **Auth:** `Authorization: Bearer <YOUR_API_KEY>` on every request
- **Protocol:** OpenAI Chat Completions (`/v1/chat/completions`), streaming and non‑streaming

> You will be issued an API key (looks like `sk-ceg-…`). Keep it secret — treat it like a
> password. Do not commit it to source control; load it from an environment variable.

---

## Quickstart

### curl

```bash
curl http://200.141.3.47:8787/v1/chat/completions \
  -H "Authorization: Bearer $CEG_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "opus",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Summarize the theory of relativity in one sentence."}
    ]
  }'
```

### Python (official `openai` SDK)

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://200.141.3.47:8787/v1",
    api_key="YOUR_API_KEY",           # or os.environ["CEG_API_KEY"]
)

resp = client.chat.completions.create(
    model="opus",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Extract action items from this note: ..."},
    ],
)
print(resp.choices[0].message.content)
```

### Node / TypeScript (official `openai` SDK)

```ts
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://200.141.3.47:8787/v1",
  apiKey: process.env.CEG_API_KEY,
});

const resp = await client.chat.completions.create({
  model: "opus",
  messages: [{ role: "user", content: "Write a haiku about the sea." }],
});
console.log(resp.choices[0].message.content);
```

### Streaming

Set `stream: true` and consume Server‑Sent Events — identical to the OpenAI streaming API.

```python
stream = client.chat.completions.create(
    model="opus",
    messages=[{"role": "user", "content": "Tell me a short story."}],
    stream=True,
)
for chunk in stream:
    delta = chunk.choices[0].delta.content
    if delta:
        print(delta, end="", flush=True)
```

---

## Models

Pass any of these as `model`. Short aliases and common OpenAI names are accepted and mapped
to a sensible tier, so existing OpenAI code “just works”.

| `model` value | Tier | Use for |
|---|---|---|
| `opus`  / `claude-opus-4-8`   | Most capable | Hard reasoning, long/complex tasks |
| `sonnet` / `claude-sonnet-5`  | Balanced | General‑purpose work |
| `haiku` / `claude-haiku-4-5`  | Fastest / cheapest | High‑volume, simple, latency‑sensitive tasks |

**Accepted aliases** (mapped automatically): `gpt-4o`, `gpt-4`, `gpt-4-turbo` → most capable;
`gpt-4o-mini`, `gpt-3.5-turbo` → fastest. If you omit `model` or send an unknown one, a sensible
default is used.

List models programmatically:

```bash
curl http://200.141.3.47:8787/v1/models -H "Authorization: Bearer $CEG_API_KEY"
```

---

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | Chat completions (streaming + non‑streaming) |
| `GET`  | `/v1/models` | List available models |
| `GET`  | `/health` | Liveness check (no auth) — returns `{"ok": true}` |

All `/v1/*` endpoints require the `Authorization: Bearer` header.

---

## Request & response shape

Requests and responses follow the **OpenAI Chat Completions** schema. A non‑streaming
response looks like:

```json
{
  "id": "chatcmpl-…",
  "object": "chat.completion",
  "created": 1730000000,
  "model": "claude-opus-4-8",
  "choices": [
    { "index": 0,
      "message": { "role": "assistant", "content": "…" },
      "finish_reason": "stop" }
  ],
  "usage": { "prompt_tokens": 42, "completion_tokens": 128, "total_tokens": 170 }
}
```

### Supported parameters

| Field | Notes |
|---|---|
| `model` | See table above. |
| `messages` | Standard `system` / `user` / `assistant` roles. Required. |
| `max_tokens` | Optional. Defaults to `4096` if omitted. |
| `stream` | Optional `true` / `false`. |

### Not supported (plan around these)

- **Text in, text out only.** Image/audio inputs, tool/function calling, JSON‑mode, and
  embeddings are **not** available on this endpoint. Send plain text messages; expect plain
  text back.
- `temperature`, `top_p`, and other sampling knobs are accepted but **may be ignored** —
  don’t depend on them to change behavior.

---

## Errors

Standard HTTP status codes with an OpenAI‑style error body:

```json
{ "error": { "message": "…description…" } }
```

| Status | Meaning | What to do |
|---|---|---|
| `401` | Missing/invalid API key | Check the `Authorization` header. |
| `400` | Malformed request | Ensure `messages` is a non‑empty array. |
| `429` | Rate limited | Back off and retry (respect `Retry-After`). |
| `5xx` | Upstream/temporary error | Retry with exponential backoff. |

---

## Best practices

- **Keep concurrency modest.** This is a shared endpoint; prefer a small number of
  in‑flight requests and queue the rest rather than firing large parallel bursts.
- **Retry on `429`/`5xx`** with exponential backoff; treat `4xx` (except `429`) as terminal.
- **Load the API key from an env var**, never hard‑code it.
- **Set a client timeout** (e.g. 60–120s) for long generations, and use `stream: true` for
  a responsive UX on longer outputs.

---

That’s everything an app needs. Point your OpenAI client at the base URL above, use your
issued key, and call `/v1/chat/completions` as you normally would.
