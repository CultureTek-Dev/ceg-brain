import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import * as metrics from "../lib/metrics.js";

/**
 * Usage dashboard. Two surfaces:
 *   GET /dashboard      — the HTML page (a shell; carries no data on its own)
 *   GET /admin/stats    — the data API, guarded by DASHBOARD_TOKEN
 * Neither lives under /v1, so the app-key hook does not touch them; the data API
 * enforces its own admin-token check.
 */
export function registerDashboard(app: FastifyInstance) {
  app.get("/admin/stats", async (req: FastifyRequest, reply: FastifyReply) => {
    if (!config.metrics.enabled) {
      return reply.code(503).send({ error: { message: "metrics disabled (METRICS_ENABLED=0)" } });
    }
    if (!config.metrics.dashboardToken) {
      return reply.code(503).send({ error: { message: "dashboard disabled: set DASHBOARD_TOKEN" } });
    }
    const hdr = (req.headers["authorization"] as string) ?? "";
    const bearer = hdr.startsWith("Bearer ") ? hdr.slice(7).trim() : "";
    const q = req.query as any;
    const token = bearer || (typeof q?.token === "string" ? q.token : "");
    if (token !== config.metrics.dashboardToken) {
      return reply.code(401).send({ error: { message: "unauthorized" } });
    }
    const range = typeof q?.range === "string" ? q.range : "24h";
    return metrics.stats(range);
  });

  app.get("/dashboard", async (_req, reply) => {
    reply.type("text/html").send(DASHBOARD_HTML);
  });
}

// Self-contained page: inline CSS + vanilla JS, no external requests. The admin
// token is entered once and kept in localStorage; every data call sends it as a
// Bearer header. Client JS uses string concatenation (no template literals) so it
// can live safely inside this server-side template literal.
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>ceg-brain · usage</title>
<style>
  :root {
    --bg:#0b0c0e; --panel:#15171b; --panel2:#1c1f24; --text:#e7e9ee; --muted:#9aa1ad;
    --line:#2a2e35; --accent:#6ea8fe; --good:#57d38c; --warn:#f2c14e; --bad:#f2766e;
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f6f7f9; --panel:#fff; --panel2:#f0f2f5; --text:#1b1e24; --muted:#5c6470;
            --line:#e2e5ea; --accent:#2f6fed; --good:#1a9c5b; --warn:#b5860b; --bad:#d1443b; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  header { display:flex; align-items:center; gap:12px; flex-wrap:wrap;
    padding:16px 20px; border-bottom:1px solid var(--line); position:sticky; top:0; background:var(--bg); z-index:5; }
  h1 { font-size:16px; margin:0; font-weight:650; letter-spacing:.2px; }
  h1 span { color:var(--muted); font-weight:400; }
  .grow { flex:1; }
  select, button, input {
    background:var(--panel2); color:var(--text); border:1px solid var(--line);
    border-radius:8px; padding:7px 11px; font-size:13px; }
  button { cursor:pointer; }
  button:hover { border-color:var(--accent); }
  main { padding:20px; max-width:1200px; margin:0 auto; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:14px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; }
  .card .label { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.6px; }
  .card .value { font-size:26px; font-weight:650; margin-top:6px; }
  .card .sub { color:var(--muted); font-size:12px; margin-top:2px; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:16px; margin-top:18px; }
  section h2 { font-size:13px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); margin:0 0 12px; }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--muted); font-weight:600; }
  td.num, th.num { text-align:right; font-variant-numeric:tabular-nums; }
  .bar { height:8px; border-radius:5px; background:var(--panel2); overflow:hidden; }
  .bar > i { display:block; height:100%; background:var(--accent); }
  .pill { padding:2px 8px; border-radius:20px; font-size:12px; }
  .ok { color:var(--good); } .err { color:var(--bad); }
  .scroll { overflow-x:auto; }
  .gate { max-width:420px; margin:80px auto; text-align:center; }
  .gate input { width:100%; margin:12px 0; }
  .muted { color:var(--muted); }
  .flex { display:flex; align-items:center; gap:10px; }
  svg { display:block; width:100%; height:180px; }
  .chartbar { fill:var(--accent); opacity:.85; }
  .chartbar:hover { opacity:1; }
  #err { color:var(--bad); font-size:13px; }
</style>
</head>
<body>
<header>
  <h1>ceg-brain <span>· usage</span></h1>
  <div class="grow"></div>
  <select id="range">
    <option value="1h">Last hour</option>
    <option value="24h" selected>Last 24h</option>
    <option value="7d">Last 7 days</option>
    <option value="30d">Last 30 days</option>
    <option value="all">All time</option>
  </select>
  <button id="refresh">Refresh</button>
  <button id="logout" title="Forget token">Sign out</button>
</header>
<main id="app"></main>

<script>
(function () {
  var KEY = "ceg_dash_token";
  var app = document.getElementById("app");
  var errEl = null;

  function token() { return localStorage.getItem(KEY) || ""; }
  function fmt(n) { return (n == null ? "0" : Number(n).toLocaleString()); }
  function pct(n) { return (n == null ? "—" : (Math.round(n * 10) / 10) + "%"); }
  function when(ts) { try { return new Date(ts).toLocaleString(); } catch (e) { return "" + ts; } }

  function gate(msg) {
    app.innerHTML =
      '<div class="gate">' +
        '<h2 class="muted">Enter admin token</h2>' +
        '<input id="tok" type="password" placeholder="DASHBOARD_TOKEN" autofocus />' +
        '<button id="save">Open dashboard</button>' +
        (msg ? '<p id="err">' + msg + '</p>' : '') +
      '</div>';
    document.getElementById("save").onclick = function () {
      var v = document.getElementById("tok").value.trim();
      if (v) { localStorage.setItem(KEY, v); load(); }
    };
    document.getElementById("tok").addEventListener("keydown", function (e) {
      if (e.key === "Enter") document.getElementById("save").click();
    });
  }

  function chart(series) {
    if (!series.length) return '<p class="muted">No data in this range.</p>';
    var max = 1; for (var i = 0; i < series.length; i++) max = Math.max(max, series[i].totalTokens);
    var n = series.length, W = 1000, H = 160, gap = 2;
    var bw = Math.max(1, (W - gap * (n - 1)) / n);
    var bars = "";
    for (var j = 0; j < n; j++) {
      var h = Math.round((series[j].totalTokens / max) * (H - 20));
      var x = Math.round(j * (bw + gap));
      var y = H - h;
      var title = when(series[j].bucket) + " — " + fmt(series[j].totalTokens) + " tokens, " + fmt(series[j].queries) + " queries";
      bars += '<rect class="chartbar" x="' + x + '" y="' + y + '" width="' + Math.round(bw) + '" height="' + h + '" rx="2"><title>' + title + '</title></rect>';
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' + bars + '</svg>' +
      '<div class="flex muted" style="justify-content:space-between;font-size:12px;margin-top:6px">' +
        '<span>' + when(series[0].bucket) + '</span><span>peak ' + fmt(max) + ' tok/bucket</span><span>' + when(series[n - 1].bucket) + '</span></div>';
  }

  function rows(arr, keyName) {
    if (!arr.length) return '<tr><td colspan="3" class="muted">None</td></tr>';
    var total = 0; for (var i = 0; i < arr.length; i++) total += arr[i].totalTokens;
    total = total || 1;
    var out = "";
    for (var k = 0; k < arr.length; k++) {
      var r = arr[k];
      var share = Math.round((r.totalTokens / total) * 100);
      out += '<tr><td>' + (r[keyName] || "unknown") + '</td>' +
        '<td class="num">' + fmt(r.queries) + '</td>' +
        '<td class="num">' + fmt(r.totalTokens) + '</td>' +
        '<td style="width:120px"><div class="bar"><i style="width:' + share + '%"></i></div></td></tr>';
    }
    return out;
  }

  function recent(list, budget) {
    if (!list.length) return '<tr><td colspan="9" class="muted">No requests yet.</td></tr>';
    var out = "";
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      var st = r.status >= 400
        ? '<span class="pill err">' + r.status + (r.error ? '' : '') + '</span>'
        : '<span class="pill ok">' + r.status + '</span>';
      var tags = (r.stream ? 'stream ' : '') + (r.searching ? 'search' : '');
      out += '<tr>' +
        '<td>' + when(r.ts) + '</td>' +
        '<td>' + (r.appLabel || 'unknown') + '</td>' +
        '<td>' + (r.model || '') + (tags ? ' <span class="muted">' + tags.trim() + '</span>' : '') + '</td>' +
        '<td class="num">' + fmt(r.inputTokens) + '</td>' +
        '<td class="num">' + fmt(r.outputTokens) + '</td>' +
        '<td class="num">' + fmt(r.totalTokens) + '</td>' +
        '<td class="num">' + (r.queryBudgetPct == null ? '—' : pct(r.queryBudgetPct)) + '</td>' +
        '<td class="num">' + pct(r.windowUsedPct) + '</td>' +
        '<td class="num">' + fmt(r.latencyMs) + 'ms ' + st + '</td>' +
      '</tr>';
    }
    return out;
  }

  function render(d) {
    var w = d.window || {};
    var windowVal = w.usedPct != null ? pct(w.usedPct)
                   : (w.budgetUsedPct != null ? pct(w.budgetUsedPct) : "—");
    var windowSub = w.usedPct != null ? "subscription window"
                   : (w.budget > 0 ? fmt(w.tokensInWindow) + " / " + fmt(w.budget) + " tok (est.)" : "no rate-limit data");
    var resetSub = w.resetAt ? "resets " + when(w.resetAt) : "";

    var html =
      '<div class="cards">' +
        card("Queries", fmt(d.summary.queries), d.range) +
        card("Total tokens", fmt(d.summary.totalTokens), fmt(d.summary.inputTokens) + " in · " + fmt(d.summary.outputTokens) + " out") +
        card("Avg latency", fmt(d.summary.avgLatencyMs) + " ms", d.summary.errors + " error(s)") +
        card("Window used", windowVal, windowSub + (resetSub ? " · " + resetSub : "")) +
      '</div>' +
      '<section><h2>Tokens over time</h2>' + chart(d.series) + '</section>' +
      '<div class="cards" style="grid-template-columns:1fr 1fr">' +
        '<section><h2>By app key</h2><div class="scroll"><table>' +
          '<tr><th>App</th><th class="num">Queries</th><th class="num">Tokens</th><th>Share</th></tr>' +
          rows(d.byApp, "appLabel") + '</table></div></section>' +
        '<section><h2>By model</h2><div class="scroll"><table>' +
          '<tr><th>Model</th><th class="num">Queries</th><th class="num">Tokens</th><th>Share</th></tr>' +
          rows(d.byModel, "model") + '</table></div></section>' +
      '</div>' +
      '<section><h2>Recent queries</h2><div class="scroll"><table>' +
        '<tr><th>Time</th><th>App</th><th>Model</th><th class="num">In</th><th class="num">Out</th>' +
        '<th class="num">Total</th><th class="num">% budget</th><th class="num">Window</th><th class="num">Latency</th></tr>' +
        recent(d.recent, w.budget) + '</table></div></section>';
    app.innerHTML = html;
  }

  function card(label, value, sub) {
    return '<div class="card"><div class="label">' + label + '</div>' +
      '<div class="value">' + value + '</div><div class="sub">' + (sub || "") + '</div></div>';
  }

  function load() {
    if (!token()) return gate("");
    var range = document.getElementById("range").value;
    fetch("/admin/stats?range=" + encodeURIComponent(range), {
      headers: { authorization: "Bearer " + token() }
    }).then(function (r) {
      if (r.status === 401) { localStorage.removeItem(KEY); gate("Wrong token."); throw new Error("401"); }
      if (r.status === 503) { return r.json().then(function (j) { throw new Error(j.error && j.error.message || "disabled"); }); }
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    }).then(render).catch(function (e) {
      if (e.message !== "401") {
        app.innerHTML = '<p id="err">Could not load stats: ' + e.message + '</p>';
      }
    });
  }

  document.getElementById("refresh").onclick = load;
  document.getElementById("range").onchange = load;
  document.getElementById("logout").onclick = function () { localStorage.removeItem(KEY); gate(""); };
  load();
  setInterval(function () { if (token()) load(); }, 15000);
})();
</script>
</body>
</html>`;
