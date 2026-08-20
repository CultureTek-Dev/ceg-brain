# ceg-brain

One Claude "brain" for many apps. `ceg-brain` is an **OpenAI-compatible gateway**
that authenticates to Claude with your **Claude Pro/Max subscription** (via the Claude
Code OAuth token, `claude setup-token`) — or an Anthropic **API key** as a fallback —
and exposes a standard `/v1/chat/completions` endpoint. Your apps talk to it with any
OpenAI SDK by pointing `baseURL` at the brain and using one of its app keys.

```
apps (OpenAI SDK) ──►  ceg-brain  ──►  Claude (subscription OAuth, or API key)
     baseURL + key        │
              per-app keys · cost logs · concurrency guard · Claude Code identity
```

**How the subscription path works.** `claude setup-token` mints a long-lived (~1yr)
OAuth token (`sk-ant-oat01-…`) tied to your subscription — the same credential Claude
Code uses headless. `ceg-brain` sends it as `Authorization: Bearer` with the
`oauth-2025-04-20` beta header, and prepends the **Claude Code identity system block**
(`You are Claude Code, Anthropic's official CLI for Claude.`) so the token is honoured.
Requests then draw on your subscription's Claude Code rate limits, **not** pay-as-you-go
API credits.

> ⚠️ **Know the trade-offs before you rely on this.**
> - **Usage policy.** Anthropic's terms don't sanction pointing product/app traffic at a
>   personal subscription. This is fine for your *own* internal tools on your *own* box; it
>   is not a way to resell inference. The token can be **rate-limited or revoked** — build a
>   re-auth path, don't assume it's forever.
> - **Rate limits are human-shaped** (5-hour Claude Code windows), so a busy backend
>   exhausts them fast. `MAX_CONCURRENCY` serialises calls to protect one subscription.
> - **Want predictable, sanctioned billing instead?** Set `BRAIN_BACKEND=api` with an
>   `ANTHROPIC_API_KEY` — same gateway, pay-as-you-go API plane, no identity injection.

## Install (one line on the VPS)

```bash
curl -fsSL https://raw.githubusercontent.com/CultureTek-Dev/ceg-brain/main/install.sh | bash
```

The installer sets up Node and pm2; clones the repo to `~/ceg-brain`; generates
`.env` with app keys; and (for the subscription backend) tells you to do the **one
manual step** — mint the token on a machine that has a browser, then drop it into
`.env` on the VPS:

```bash
# on your laptop (needs a browser for the OAuth callback):
claude setup-token            # → prints sk-ant-oat01-…
```

```bash
# on the VPS, put it in ~/ceg-brain/.env:
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-…
```

Re-run the installer and it builds + starts the brain under pm2.

> Headless boxes never ran Claude Code's first-run wizard. If you ever invoke the
> `claude` CLI on the VPS (e.g. the `ant`/CLI fallback), pre-seed
> `~/.claude.json` with `{"hasCompletedOnboarding": true, "hasTrustDialogAccepted": true}`
> for the service user so it doesn't block on the prompt. The default token path
> above reads the env var directly and needs none of this.

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

Use the included `Dockerfile`. For the **subscription** backend, just set
`CLAUDE_CODE_OAUTH_TOKEN` as a container secret/env — it's a self-contained bearer, so
no volume is needed and it survives redeploys. (Only the legacy `ant`-CLI fallback needs
its OAuth profile mounted as a persistent volume.) For the **api** backend, set
`ANTHROPIC_API_KEY`.

## Configuration (`.env`)

| Var | Meaning |
|-----|---------|
| `BRAIN_KEYS` | `label:key` pairs — the keys your apps use; label drives cost logs |
| `BRAIN_BACKEND` | `subscription` (Claude Code OAuth token) or `api` (`ANTHROPIC_API_KEY`) |
| `CLAUDE_CODE_OAUTH_TOKEN` | the `claude setup-token` value — powers the `subscription` backend |
| `ANTHROPIC_BETA` | beta header sent with the OAuth token (default `oauth-2025-04-20`) |
| `INJECT_CLAUDE_CODE_SYSTEM` | prepend the Claude Code identity block (default `1`; leave on) |
| `ANTHROPIC_API_KEY` | only for the `api` backend |
| `MAX_CONCURRENCY` | simultaneous upstream calls — protects one subscription from bursts |
| `DEFAULT_MODEL` | model when a caller doesn't specify (or uses an alias) |
| `ANT_BIN` / `TOKEN_REFRESH_MIN` | legacy `ant`-CLI fallback: CLI path + token refresh cadence |
| `FORWARD_SAMPLING` | forward `temperature`/`top_p`? Off — newer Claude models reject them |

## Auth spike — do this first

Before wiring apps, confirm the subscription token is accepted and that usage lands on
*the subscription* (not API credits):

```bash
# with CLAUDE_CODE_OAUTH_TOKEN set in .env and the brain running, fire one call:
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H "authorization: Bearer <an app key>" -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-8","messages":[{"role":"user","content":"say hi"}]}'
```

- **A completion comes back** → the OAuth token + Claude Code identity injection is working.
- **`401` / "OAuth authentication is not supported" / an identity error** → the token was
  rejected. Check `CLAUDE_CODE_OAUTH_TOKEN` is a fresh `sk-ant-oat01-…`, that
  `INJECT_CLAUDE_CODE_SYSTEM=1`, and that `ANTHROPIC_API_KEY` is **unset** on this backend.
- Confirm your Claude **subscription** usage moves (not API credits). If you'd rather bill
  the API plane, set `BRAIN_BACKEND=api` with an `ANTHROPIC_API_KEY`.


## CEG-aware inference — `/v1/ceg/chat/completions`

Same OpenAI shape as `/v1/chat/completions`, but the model already knows CEG: its people
and aliases, the four business units and their owners, the operating protocols, the routing
map, the platform architecture. An app switches by changing `baseURL` — nothing else.

```bash
curl -s $BASE/v1/ceg/chat/completions -H "Authorization: Bearer $KEY" \
  -H 'content-type: application/json' \
  -d '{"model":"sonnet","messages":[{"role":"user","content":"Who approves an invoice, and where do money questions go?"}]}'
```

**A separate route, not a flag.** The knowledge base is ~5,000 tokens on every request.
A caller that only wants a model call shouldn't pay for the company's org chart because
someone forgot to unset a flag — choosing the endpoint *is* the opt-in.

### The knowledge lives outside this repo

`CEG_KNOWLEDGE_DIR` points at a directory of `.md` files on the host. They are **not** in
this repository and must never be: they contain staff emails, personal addresses and who may
approve money, and **this repo is public**. `knowledge/` is gitignored as a backstop.

```bash
mkdir -p ~/ceg-brain/knowledge
scp org/ceg/*.md  vps:~/ceg-brain/knowledge/     # from the private repo
echo 'CEG_KNOWLEDGE_DIR=/root/ceg-brain/knowledge' >> ~/ceg-brain/.env
```

| Endpoint | Does |
|---|---|
| `GET /v1/ceg/knowledge` | What's loaded — files, bytes, when |
| `POST /v1/ceg/knowledge/reload` | Re-read from disk after editing, no restart |

### Notes

- **It refuses rather than degrades.** With no knowledge loaded the route returns **503**.
  Answering "as CEG" from a generic model in a confident tone is the exact failure this
  endpoint exists to prevent.
- **The block is prompt-cached.** It is byte-identical on every call, so `cache_control`
  turns ~5k tokens of re-sent context into a cache read. `cacheRead` / `cacheWrite` are
  logged per request so you can see whether it's working.
- **Company knowledge, not this week's news.** It knows how CEG works, not what happened on
  Tuesday. The prompt says so, and tells the model to decline rather than guess. Live
  activity still comes from the Notion context bank via the Slack bot.
- Plain `/v1/chat/completions` is untouched — same tokens, same behaviour.

## Web search

Claude can search the web server-side and answer with citations — the caller still
just reads `choices[0].message.content`, so any OpenAI SDK works unchanged.

```bash
# either: ask for the "research" model …
-d '{"model":"research","messages":[{"role":"user","content":"Compare UAE vs Portugal for incorporation"}]}'

# … or set the flag on any model
-d '{"model":"opus","web_search":true,"messages":[…]}'
```

Sources found during the search are appended to the answer as a **Sources** list.

Notes:
- Only on the **non-streaming** path. A search turn can pause mid-run
  (`stop_reason: "pause_turn"`); the brain resumes it automatically, which the
  streaming path can't do — a streamed search would truncate silently.
- `WEB_SEARCH_MAX_USES` (default 8) bounds searches per request.
- Searching costs more and takes longer than a plain completion; don't turn it on
  by default.

## Usage dashboard

The brain records **one row per request** — timestamp, app key, model, input/output
tokens, latency, status, and a snapshot of the upstream rate-limit headers — into a
local **SQLite** file (`./data/metrics.db`, gitignored). A built-in dashboard surfaces it:

```
https://brain.ceg.ag/dashboard
```

Set a `DASHBOARD_TOKEN` in `.env` first (`openssl rand -hex 24`) — the page prompts for
it once and keeps it in your browser. It shows: total queries/tokens, tokens over time,
per-app-key and per-model breakdowns, and a **recent-queries** table with per-query token
counts and **% of the subscription window consumed**.

- **"Window used"** comes from Anthropic's `anthropic-ratelimit-*` headers when present
  (the real 5-hour subscription window). If the plane returns no usable limit headers, set
  `WINDOW_TOKEN_BUDGET` to an assumed per-window token budget and the dashboard computes a
  **"% of budget"** figure instead.
- The dashboard data API (`GET /admin/stats`) is guarded by `DASHBOARD_TOKEN`, separate
  from your app keys. Streamed and non-streamed requests are both tracked.
- SQLite handles this write volume trivially and needs no external DB. Back up
  `data/metrics.db` if you want history to survive a box rebuild. Disable everything with
  `METRICS_ENABLED=0`.

## Endpoints

- `POST /v1/chat/completions` — OpenAI chat completions (stream + non-stream)
- `GET  /v1/models` — lists the Claude models
- `GET  /health` — liveness (no auth)
- `GET  /dashboard` — usage dashboard (HTML; data API gated by `DASHBOARD_TOKEN`)
- `GET  /admin/stats` — dashboard JSON (`?range=1h|24h|7d|30d|all`, `Authorization: Bearer <DASHBOARD_TOKEN>`)
