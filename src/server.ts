import Fastify from "fastify";
import { config } from "./config.js";
import { registerChat } from "./routes/chat.js";
import { registerDashboard } from "./routes/dashboard.js";
import { LISTED_MODELS } from "./lib/models.js";
import { getAuth } from "./auth/token.js";
import * as metrics from "./lib/metrics.js";

const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024 });

// --- Auth: every /v1 route requires a valid app key (Bearer) ------------
app.addHook("onRequest", async (req, reply) => {
  if (req.url === "/health" || req.method === "OPTIONS") return;
  if (!req.url.startsWith("/v1")) return;
  const header = req.headers["authorization"] ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const label = config.keys.get(token);
  if (!label) {
    reply.code(401).send({ error: { message: "Invalid or missing API key" } });
    return reply;
  }
  (req as any).appLabel = label; // for per-app cost attribution in logs
});

app.get("/health", async () => ({ ok: true, backend: config.backend }));

app.get("/v1/models", async () => ({
  object: "list",
  data: LISTED_MODELS.map((id) => ({ id, object: "model", owned_by: "ceg-brain" })),
}));

registerChat(app);
registerDashboard(app);

async function main() {
  // Open the metrics DB (no-op if METRICS_ENABLED=0).
  metrics.init();

  // Fail fast if the subscription backend can't produce a token.
  try {
    const auth = await getAuth();
    app.log.info(`[ceg-brain] backend=${config.backend} auth=${auth.type} ready`);
  } catch (e: any) {
    app.log.error(`[ceg-brain] AUTH NOT READY: ${e?.message}`);
    app.log.error("[ceg-brain] For subscription backend, run `ant auth login` on this box first.");
  }
  await app.listen({ port: config.port, host: config.host });
  app.log.info(`[ceg-brain] listening on ${config.host}:${config.port}  (${config.keys.size} app key(s))`);
  if (config.metrics.enabled && config.metrics.dashboardToken) {
    app.log.info(`[ceg-brain] dashboard at /dashboard (token-gated)`);
  } else if (config.metrics.enabled) {
    app.log.warn(`[ceg-brain] metrics on, but DASHBOARD_TOKEN unset — /dashboard data API is disabled`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
