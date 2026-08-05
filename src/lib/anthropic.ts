import { config } from "../config.js";
import { getAuth, refreshAuth, type Auth } from "../auth/token.js";
import { withSlot, sleep } from "./guard.js";
import { capture as captureRateLimit } from "./ratelimit.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function headersFor(auth: Auth): Record<string, string> {
  const base: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": config.anthropicVersion,
  };
  if (auth.type === "api") {
    base["x-api-key"] = auth.key;
  } else {
    // OAuth (subscription) tokens go on Authorization: Bearer + the oauth beta header.
    // NB: x-api-key must be ABSENT here — presenting both confuses the OAuth path.
    base["authorization"] = `Bearer ${auth.token}`;
    base["anthropic-beta"] = config.anthropicBeta;
  }
  return base;
}

/**
 * Non-streaming call that completes server-tool work before returning.
 *
 * A request using a server tool (web search) can come back with
 * stop_reason "pause_turn" when Anthropic's internal loop hits its iteration
 * limit. That is not an error and not the end of the answer — you resume by
 * sending the conversation back with the assistant turn appended. Without this
 * the caller silently receives a half-finished research answer.
 */
export async function callAnthropicJson(body: Record<string, unknown>): Promise<any> {
  let current = body;
  let last: any;

  for (let i = 0; i <= config.webSearch.maxContinuations; i++) {
    const res = await callAnthropic(current, false);
    last = await res.json();
    if (last?.stop_reason !== "pause_turn") return last;

    // Resume: replay the conversation plus the paused assistant turn.
    const messages = [
      ...((current.messages as unknown[]) ?? []),
      { role: "assistant", content: last.content },
    ];
    current = { ...current, messages };
  }
  return last; // still paused after maxContinuations — return what we have
}

/**
 * Call Anthropic /v1/messages. Retries on 429/5xx with backoff, and refreshes
 * the subscription token once on 401. Returns the raw fetch Response so callers
 * can either .json() (non-stream) or pipe .body (stream).
 */
export async function callAnthropic(body: Record<string, unknown>, stream: boolean): Promise<Response> {
  return withSlot(async () => {
    let auth = await getAuth();
    let attempt = 0;
    const maxAttempts = 4;

    while (true) {
      attempt++;
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: headersFor(auth),
        body: JSON.stringify({ ...body, stream }),
      });

      if (res.ok) {
        // Snapshot rate-limit headers (window state) before the body is consumed.
        try { captureRateLimit(res.headers); } catch { /* never break a request */ }
        return res;
      }

      // 401 → token likely expired; refresh once and retry immediately.
      if (res.status === 401 && auth.type === "subscription" && attempt === 1) {
        auth = await refreshAuth();
        continue;
      }
      // 429 / 5xx → backoff and retry.
      if ((res.status === 429 || res.status >= 500) && attempt < maxAttempts) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(1000 * 2 ** attempt, 15000);
        await sleep(delay);
        continue;
      }
      // Give up — surface the upstream error body.
      const errText = await res.text().catch(() => "");
      const err = new Error(`Anthropic ${res.status}: ${errText.slice(0, 500)}`);
      (err as any).status = res.status;
      throw err;
    }
  });
}
