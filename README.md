# ceg-brain

One Claude "brain" for many apps. `ceg-brain` is an **OpenAI-compatible gateway**
that authenticates to Claude with your **Claude subscription** (via the `ant`
OAuth profile on the box) — or an Anthropic **API key** as a fallback — and exposes
a standard `/v1/chat/completions` endpoint. Your apps talk to it with any OpenAI SDK
by pointing `baseURL` at the brain and using one of its app keys.

```
apps (OpenAI SDK) ──►  ceg-brain  ──►  Claude (subscription OAuth, or API key)
     baseURL + key        │
                    per-app keys · cost logs · concurrency guard · token refresh
```

> ⚠️ **Honest note.** Powering multiple apps from a single Claude *subscription* is
> outside the subscription's intended personal/interactive use and can be
> rate-limited or restricted. `ceg-brain` is built to survive that: flip
> `BRAIN_BACKEND=api` in `.env` and every app keeps working unchanged. Verify the
> subscription actually serves inference before relying on it (see **Auth spike**).

## Install (one line on the VPS)

```bash
curl -fsSL https://raw.githubusercontent.com/CultureTek-Dev/ceg-brain/main/install.sh | bash
```

The installer sets up Node, `ant`, and pm2; clones the repo to `~/ceg-brain`;
generates `.env` with app keys; and (for the subscription backend) tells you to run
the **one manual step**:

```bash
ant auth login --no-browser    # open the URL, approve, paste the code back
```

Re-run the installer and it builds + starts the brain under pm2.

## Expose a public base URL

The brain listens on `PORT` (default `8787`) with **no TLS** — terminate TLS at your
reverse proxy and forward to it:

- **Coolify / Traefik / Caddy:** add a route for e.g. `brain.ceg.ag` → `127.0.0.1:8787`.
- The public base URL your apps use is then `https://brain.ceg.ag/v1`.

Because every `/v1` request requires a valid app key, the endpoint is safe to expose —
but keep the keys secret and consider an IP allowlist for defence in depth.

## Use it from your apps (OpenAI SDK)

```ts
import OpenAI from "openai";
const client = new OpenAI({
  baseURL: "https://brain.ceg.ag/v1",
  apiKey: process.env.BRAIN_KEY,        // one of the keys from BRAIN_KEYS
});

const res = await client.chat.completions.create({
  model: "claude-opus-4-8",             // or "opus" / "haiku" / even "gpt-4o" (aliased)
  messages: [{ role: "user", content: "Extract tasks from this transcript…" }],
});
```

Python, Go, curl — anything that speaks the OpenAI API works. Streaming (`stream: true`)
is supported via SSE.

## Deploy your apps (pm2 or Coolify — either)

Your 4 apps are independent; each just needs `BRAIN_BASE_URL` + its app key. Deploy them
however you like — `pm2 start` for workers (the Slack bot), Coolify for the web apps.
They never hold Anthropic credentials — only a `ceg-brain` app key.

### Running the brain itself on Coolify

Use the included `Dockerfile`. For the **subscription** backend, mount the `ant` OAuth
profile (`~/.config/anthropic`) as a **persistent volume** into the container so the token
survives redeploys — do the `ant auth login` once on the host into that dir. For the
**api** backend, no volume is needed; just set `ANTHROPIC_API_KEY`.

## Configuration (`.env`)

| Var | Meaning |
|-----|---------|
| `BRAIN_KEYS` | `label:key` pairs — the keys your apps use; label drives cost logs |
| `BRAIN_BACKEND` | `subscription` (via `ant`) or `api` (via `ANTHROPIC_API_KEY`) |
| `ANTHROPIC_API_KEY` | only for the `api` backend |
| `MAX_CONCURRENCY` | simultaneous upstream calls — protects one subscription from bursts |
| `DEFAULT_MODEL` | model when a caller doesn't specify (or uses an alias) |
| `TOKEN_REFRESH_MIN` | how often to refresh the subscription token |
| `FORWARD_SAMPLING` | forward `temperature`/`top_p`? Off — newer Claude models reject them |

## Auth spike — do this first

Before wiring apps, confirm the subscription path actually works and is *the subscription*
(not silent API billing):

```bash
ant auth login --no-browser
ant auth print-credentials --access-token          # prints a bearer token
# fire one call through the brain and confirm it answers:
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer <an app key>" -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-8","messages":[{"role":"user","content":"say hi"}]}'
```

If that returns a completion **and** your Claude subscription usage moves (not API credits),
you're good. If it bills the API, set `BRAIN_BACKEND=api` — you gain nothing from the
subscription path and lose the risk.

## Endpoints

- `POST /v1/chat/completions` — OpenAI chat completions (stream + non-stream)
- `GET  /v1/models` — lists the Claude models
- `GET  /health` — liveness (no auth)
