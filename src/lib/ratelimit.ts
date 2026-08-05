// Captures whatever rate-limit signal Anthropic returns on a response. We do NOT
// assume exact header names — the subscription (OAuth) plane and the API plane
// expose different `anthropic-ratelimit-*` sets — so we grab them all, then make a
// best effort to derive a single "% of the current window consumed" number.

export interface RateLimitSnapshot {
  at: number;                       // epoch ms when captured
  raw: Record<string, string>;      // every anthropic-ratelimit-* header (+ retry-after)
  usedPct: number | null;           // 0..100, derived; null if not derivable
  limit: number | null;             // the limit the % is computed against
  remaining: number | null;
  resetAt: number | null;           // epoch ms, if a *reset header was present
}

let latest: RateLimitSnapshot | null = null;

/** Pull the useful headers out of a fetch Response and remember the newest. */
export function capture(headers: Headers): RateLimitSnapshot {
  const raw: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k.startsWith("anthropic-ratelimit") || k === "retry-after") raw[k] = value;
  });

  const snap: RateLimitSnapshot = {
    at: Date.now(),
    raw,
    usedPct: null,
    limit: null,
    remaining: null,
    resetAt: null,
  };

  // Find a limit/remaining pair to compute usage from. Prefer a "unified" bucket
  // (what the subscription plane tends to expose), then tokens, then requests.
  const num = (v: string | undefined) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const pairFor = (needle: string): { limit: number | null; remaining: number | null } => {
    let limit: number | null = null;
    let remaining: number | null = null;
    for (const [k, v] of Object.entries(raw)) {
      if (!k.includes(needle)) continue;
      if (k.endsWith("-limit")) limit = num(v);
      else if (k.endsWith("-remaining")) remaining = num(v);
    }
    return { limit, remaining };
  };

  for (const needle of ["unified", "tokens", "requests"]) {
    const { limit, remaining } = pairFor(needle);
    if (limit != null && limit > 0 && remaining != null) {
      snap.limit = limit;
      snap.remaining = remaining;
      snap.usedPct = Math.max(0, Math.min(100, ((limit - remaining) / limit) * 100));
      break;
    }
  }

  // Some plans expose a status/utilization percentage directly.
  if (snap.usedPct == null) {
    for (const [k, v] of Object.entries(raw)) {
      if (k.includes("status") || k.includes("utilization") || k.includes("percent")) {
        const n = num(v);
        if (n != null) { snap.usedPct = Math.max(0, Math.min(100, n)); break; }
      }
    }
  }

  // A reset hint: either an epoch/seconds value or an ISO timestamp.
  for (const [k, v] of Object.entries(raw)) {
    if (!k.endsWith("-reset") && k !== "retry-after") continue;
    const asNum = Number(v);
    if (Number.isFinite(asNum)) {
      // Heuristic: small number ⇒ seconds-from-now; large ⇒ epoch seconds.
      snap.resetAt = asNum < 10_000_000 ? Date.now() + asNum * 1000 : asNum * 1000;
    } else {
      const t = Date.parse(v);
      if (Number.isFinite(t)) snap.resetAt = t;
    }
    if (k.endsWith("-reset")) break; // prefer an explicit reset header over retry-after
  }

  latest = snap;
  return snap;
}

/** The most recent snapshot seen across all upstream calls (window state is global). */
export function getLatest(): RateLimitSnapshot | null {
  return latest;
}
