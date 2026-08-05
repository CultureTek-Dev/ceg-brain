import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import { config } from "../config.js";
import { getLatest } from "./ratelimit.js";

// One row per request. Writes are fire-and-forget and never throw into the hot
// path — a metrics failure must never break inference.

export interface RequestRow {
  ts: number;              // epoch ms (request start)
  appLabel: string;
  requestedModel: string;
  resolvedModel: string;
  stream: boolean;
  searching: boolean;
  status: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  error?: string | null;
}

let db: Database.Database | null = null;
let insertStmt: Database.Statement | null = null;

export function init(): void {
  if (!config.metrics.enabled) return;
  try {
    const path = resolve(config.metrics.dbPath);
    mkdirSync(dirname(path), { recursive: true });
    db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        ts              INTEGER NOT NULL,
        app_label       TEXT,
        requested_model TEXT,
        resolved_model  TEXT,
        stream          INTEGER,
        searching       INTEGER,
        status          INTEGER,
        input_tokens    INTEGER,
        output_tokens   INTEGER,
        total_tokens    INTEGER,
        latency_ms      INTEGER,
        error           TEXT,
        window_used_pct REAL,
        window_reset_at INTEGER,
        ratelimit_json  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
      CREATE INDEX IF NOT EXISTS idx_requests_app ON requests(app_label);
    `);
    insertStmt = db.prepare(`
      INSERT INTO requests (
        ts, app_label, requested_model, resolved_model, stream, searching,
        status, input_tokens, output_tokens, total_tokens, latency_ms, error,
        window_used_pct, window_reset_at, ratelimit_json
      ) VALUES (
        @ts, @app_label, @requested_model, @resolved_model, @stream, @searching,
        @status, @input_tokens, @output_tokens, @total_tokens, @latency_ms, @error,
        @window_used_pct, @window_reset_at, @ratelimit_json
      )
    `);
    console.log(`[ceg-brain] metrics: SQLite at ${path}`);
  } catch (e: any) {
    console.error(`[ceg-brain] metrics disabled — could not open DB: ${e?.message}`);
    db = null;
  }
}

export function record(row: RequestRow): void {
  if (!db || !insertStmt) return;
  try {
    const rl = getLatest();
    insertStmt.run({
      ts: row.ts,
      app_label: row.appLabel ?? "unknown",
      requested_model: row.requestedModel ?? "",
      resolved_model: row.resolvedModel ?? "",
      stream: row.stream ? 1 : 0,
      searching: row.searching ? 1 : 0,
      status: row.status,
      input_tokens: row.inputTokens ?? 0,
      output_tokens: row.outputTokens ?? 0,
      total_tokens: (row.inputTokens ?? 0) + (row.outputTokens ?? 0),
      latency_ms: row.latencyMs ?? 0,
      error: row.error ?? null,
      window_used_pct: rl?.usedPct ?? null,
      window_reset_at: rl?.resetAt ?? null,
      ratelimit_json: rl ? JSON.stringify(rl.raw) : null,
    });
  } catch (e: any) {
    console.error(`[ceg-brain] metrics write failed: ${e?.message}`);
  }
}

// ── Aggregation for the dashboard ─────────────────────────────────────────

export interface StatsResult {
  range: string;
  since: number;
  summary: {
    queries: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    avgLatencyMs: number;
    errors: number;
  };
  series: Array<{ bucket: number; queries: number; totalTokens: number }>;
  byApp: Array<{ appLabel: string; queries: number; totalTokens: number }>;
  byModel: Array<{ model: string; queries: number; totalTokens: number }>;
  window: {
    usedPct: number | null;
    resetAt: number | null;
    raw: Record<string, string> | null;
    budget: number;             // WINDOW_TOKEN_BUDGET (0 = not set)
    tokensInWindow: number;     // total tokens since the last reset (or range)
    budgetUsedPct: number | null;
  };
  recent: Array<{
    id: number; ts: number; appLabel: string; model: string;
    stream: boolean; searching: boolean; status: number;
    inputTokens: number; outputTokens: number; totalTokens: number;
    latencyMs: number; error: string | null;
    windowUsedPct: number | null; queryBudgetPct: number | null;
  }>;
}

const RANGES: Record<string, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
  all: Number.MAX_SAFE_INTEGER,
};

export function stats(range = "24h", recentLimit = 100): StatsResult {
  const span = RANGES[range] ?? RANGES["24h"];
  const now = Date.now();
  const since = span === Number.MAX_SAFE_INTEGER ? 0 : now - span;

  const empty: StatsResult = {
    range, since,
    summary: { queries: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, avgLatencyMs: 0, errors: 0 },
    series: [], byApp: [], byModel: [],
    window: { usedPct: getLatest()?.usedPct ?? null, resetAt: getLatest()?.resetAt ?? null, raw: getLatest()?.raw ?? null, budget: config.metrics.windowTokenBudget, tokensInWindow: 0, budgetUsedPct: null },
    recent: [],
  };
  if (!db) return empty;

  try {
    const s = db.prepare(`
      SELECT COUNT(*) queries,
             COALESCE(SUM(input_tokens),0)  inTok,
             COALESCE(SUM(output_tokens),0) outTok,
             COALESCE(SUM(total_tokens),0)  totTok,
             COALESCE(AVG(latency_ms),0)    avgLat,
             COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) errors
      FROM requests WHERE ts >= ?
    `).get(since) as any;

    // Bucket size: hourly for <= 2 days, else daily.
    const bucketMs = span <= 2 * 86_400_000 ? 3_600_000 : 86_400_000;
    const series = db.prepare(`
      SELECT (ts / ?) * ? AS bucket,
             COUNT(*) queries,
             COALESCE(SUM(total_tokens),0) totalTokens
      FROM requests WHERE ts >= ?
      GROUP BY bucket ORDER BY bucket
    `).all(bucketMs, bucketMs, since) as any[];

    const byApp = db.prepare(`
      SELECT app_label appLabel, COUNT(*) queries, COALESCE(SUM(total_tokens),0) totalTokens
      FROM requests WHERE ts >= ? GROUP BY app_label ORDER BY totalTokens DESC
    `).all(since) as any[];

    const byModel = db.prepare(`
      SELECT resolved_model model, COUNT(*) queries, COALESCE(SUM(total_tokens),0) totalTokens
      FROM requests WHERE ts >= ? GROUP BY resolved_model ORDER BY totalTokens DESC
    `).all(since) as any[];

    const rl = getLatest();
    const budget = config.metrics.windowTokenBudget;
    // Tokens consumed since the window's reset (best effort), else within range.
    const windowSince = rl?.resetAt ? Math.max(since, rl.resetAt - 5 * 3_600_000) : now - 5 * 3_600_000;
    const inWin = db.prepare(`SELECT COALESCE(SUM(total_tokens),0) t FROM requests WHERE ts >= ?`).get(windowSince) as any;
    const tokensInWindow = inWin?.t ?? 0;

    const recent = (db.prepare(`
      SELECT id, ts, app_label, resolved_model, stream, searching, status,
             input_tokens, output_tokens, total_tokens, latency_ms, error, window_used_pct
      FROM requests ORDER BY ts DESC LIMIT ?
    `).all(recentLimit) as any[]).map((r) => ({
      id: r.id, ts: r.ts, appLabel: r.app_label, model: r.resolved_model,
      stream: !!r.stream, searching: !!r.searching, status: r.status,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, totalTokens: r.total_tokens,
      latencyMs: r.latency_ms, error: r.error,
      windowUsedPct: r.window_used_pct,
      queryBudgetPct: budget > 0 ? (r.total_tokens / budget) * 100 : null,
    }));

    return {
      range, since,
      summary: {
        queries: s.queries, inputTokens: s.inTok, outputTokens: s.outTok,
        totalTokens: s.totTok, avgLatencyMs: Math.round(s.avgLat), errors: s.errors,
      },
      series: series.map((b) => ({ bucket: b.bucket, queries: b.queries, totalTokens: b.totalTokens })),
      byApp: byApp.map((a) => ({ appLabel: a.appLabel, queries: a.queries, totalTokens: a.totalTokens })),
      byModel: byModel.map((m) => ({ model: m.model, queries: m.queries, totalTokens: m.totalTokens })),
      window: {
        usedPct: rl?.usedPct ?? null,
        resetAt: rl?.resetAt ?? null,
        raw: rl?.raw ?? null,
        budget,
        tokensInWindow,
        budgetUsedPct: budget > 0 ? Math.min(100, (tokensInWindow / budget) * 100) : null,
      },
      recent,
    };
  } catch (e: any) {
    console.error(`[ceg-brain] metrics query failed: ${e?.message}`);
    return empty;
  }
}
