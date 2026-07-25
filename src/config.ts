import "dotenv/config";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env: ${name}`);
  return v;
}

// Parse "label:key,label2:key2" into a Map<key, label>.
function parseKeys(raw: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = pair.indexOf(":");
    if (idx === -1) { m.set(pair, "unlabeled"); continue; }
    const label = pair.slice(0, idx).trim();
    const key = pair.slice(idx + 1).trim();
    if (key) m.set(key, label || "unlabeled");
  }
  return m;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? "",
  keys: parseKeys(req("BRAIN_KEYS", "")),
  backend: (process.env.BRAIN_BACKEND ?? "subscription") as "subscription" | "api",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
  antBin: process.env.ANT_BIN ?? "ant",
  tokenRefreshMin: Number(process.env.TOKEN_REFRESH_MIN ?? 25),
  defaultModel: process.env.DEFAULT_MODEL ?? "claude-opus-4-8",
  anthropicVersion: process.env.ANTHROPIC_VERSION ?? "2023-06-01",
  maxConcurrency: Number(process.env.MAX_CONCURRENCY ?? 3),
  forwardSampling: (process.env.FORWARD_SAMPLING ?? "0") === "1",
};

if (config.keys.size === 0) {
  console.warn("[ceg-brain] WARNING: BRAIN_KEYS is empty — every request will be rejected. Set app keys in .env.");
}
if (config.backend === "api" && !config.anthropicApiKey) {
  console.warn("[ceg-brain] WARNING: backend=api but ANTHROPIC_API_KEY is empty.");
}
