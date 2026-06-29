import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Dev-mode trace viewer: a dependency-free SPA served at `/ui`. It is a pure
 * read layer over the existing run/span/tool-call/SSE routes. The shell loads
 * without auth; data fetches carry the API key the user enters (stored in
 * memory). Testable tree/format logic lives in `../ui/trace.js`.
 */
export function uiRoutes() {
  const app = new Hono();

  // The compiled pure helpers module (built from src/ui/trace.ts → dist/ui/trace.js).
  app.get("/ui/trace.js", async (c) => {
    const candidates = [
      join(HERE, "..", "ui", "trace.js"),            // dist/routes → dist/ui (built)
      join(HERE, "..", "..", "dist", "ui", "trace.js"), // src/routes → dist/ui (tests via tsx/vitest)
      join(HERE, "ui", "trace.js"),
    ];
    for (const path of candidates) {
      try {
        const js = await readFile(path, "utf8");
        return c.body(js, 200, { "Content-Type": "application/javascript; charset=utf-8" });
      } catch {
        // try next
      }
    }
    return c.text("// trace.js not built", 404, { "Content-Type": "application/javascript" });
  });

  // Shell + SPA fallback for any /ui or /ui/* path.
  app.get("/ui", (c) => c.html(INDEX_HTML));
  app.get("/ui/*", (c) => c.html(INDEX_HTML));

  return app;
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>render-agents — trace viewer</title>
<style>
  :root { color-scheme: light dark; --b: #8884; --fg: #e6e6e6; --bg: #14161a; --mut:#9aa4b2; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg); color: var(--fg); }
  header { display:flex; gap:.75rem; align-items:center; padding:.6rem 1rem; border-bottom:1px solid var(--b); position:sticky; top:0; background:var(--bg); }
  header b { font-size: 14px; }
  input, select, button { font: inherit; background:#0000; color:inherit; border:1px solid var(--b); border-radius:6px; padding:.3rem .5rem; }
  button { cursor:pointer; } button:hover { border-color:#888a; }
  main { display:grid; grid-template-columns: 360px 1fr; height: calc(100vh - 49px); }
  #list { overflow:auto; border-right:1px solid var(--b); }
  #detail { overflow:auto; padding: .5rem 1rem; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:.35rem .5rem; border-bottom:1px solid var(--b); white-space:nowrap; }
  tr.run { cursor:pointer; } tr.run:hover td { background:#ffffff10; }
  .pill { padding:0 .4rem; border-radius:10px; border:1px solid var(--b); font-size:11px; }
  .s-completed{color:#4ade80} .s-failed{color:#f87171} .s-running{color:#60a5fa} .s-paused{color:#fbbf24} .s-cancelled{color:#9aa4b2}
  .muted{color:var(--mut)}
  .node { padding:.15rem 0; border-bottom:1px dashed #8882; white-space:pre; }
  .kind { display:inline-block; min-width:52px; }
  .err { color:#f87171; }
  #cost div { display:inline-block; margin-right:1rem; }
</style>
</head>
<body>
<header>
  <b>render-agents</b><span class="muted">trace viewer</span>
  <input id="key" type="password" placeholder="API key (Bearer)" size="22" />
  <select id="status"><option value="">all</option><option>running</option><option>paused</option><option>completed</option><option>failed</option><option>cancelled</option></select>
  <input id="workflow" placeholder="workflow filter" size="14" />
  <button id="refresh">Refresh</button>
  <span id="msg" class="muted"></span>
</header>
<main>
  <div id="list"><table><thead><tr><th>workflow</th><th>status</th><th>cost</th><th>trigger</th></tr></thead><tbody id="runs"></tbody></table></div>
  <div id="detail"><p class="muted">Select a run to view its span tree.</p></div>
</main>
<script type="module">
import { buildSpanTree, flattenTree, perAgentCost, formatCost, formatDuration } from "/ui/trace.js";

const $ = (id) => document.getElementById(id);
const KEY_STORAGE = "render-agents-ui-key";
$("key").value = new URLSearchParams(location.search).get("key") || sessionStorage.getItem(KEY_STORAGE) || "";

function headers() {
  const k = $("key").value.trim();
  sessionStorage.setItem(KEY_STORAGE, k);
  return k ? { Authorization: "Bearer " + k } : {};
}
async function api(path) {
  const res = await fetch(path, { headers: headers() });
  if (res.status === 401) { $("msg").textContent = "auth error — check API key"; throw new Error("401"); }
  if (!res.ok) throw new Error(path + " → " + res.status);
  return res.json();
}

async function loadRuns() {
  $("msg").textContent = "";
  const q = new URLSearchParams();
  if ($("status").value) q.set("status", $("status").value);
  if ($("workflow").value) q.set("workflow", $("workflow").value);
  q.set("limit", "50");
  try {
    const { runs } = await api("/runs?" + q.toString());
    const tb = $("runs"); tb.innerHTML = "";
    for (const r of runs) {
      const tr = document.createElement("tr"); tr.className = "run";
      tr.innerHTML = \`<td>\${esc(r.workflow)}</td><td class="s-\${r.status}">\${r.status}</td><td>\${formatCost(r.totalCostUsd)}</td><td class="muted">\${esc(r.trigger||"")}</td>\`;
      tr.onclick = () => openRun(r.id);
      tb.appendChild(tr);
    }
    if (!runs.length) tb.innerHTML = '<tr><td colspan="4" class="muted">no runs</td></tr>';
  } catch (e) { $("msg").textContent = String(e.message || e); }
}

let es, refreshTimer;
async function openRun(id) {
  if (es) { es.close(); es = undefined; }
  await refreshDetail(id);
}
// Re-fetch + re-render the span tree from the authoritative projections. Called
// once on open and (debounced) on every live event, so the view updates
// incrementally as the run progresses.
async function refreshDetail(id) {
  const detail = $("detail");
  try {
    const [{ spans }, run] = await Promise.all([api("/runs/" + id + "/spans"), api("/runs/" + id)]);
    render(detail, run, spans);
    const terminal = ["completed", "failed", "cancelled"].includes(run.status);
    if (!es && !terminal) live(id);
    if (es && terminal) { es.close(); es = undefined; }
  } catch (e) { detail.innerHTML = '<p class="err">' + esc(String(e.message||e)) + '</p>'; }
}

function render(detail, run, spans) {
  const tree = flattenTree(buildSpanTree(spans));
  const costs = perAgentCost(spans);
  detail.innerHTML =
    \`<h3>\${esc(run.workflow)} <span class="pill s-\${run.status}">\${run.status}</span></h3>\` +
    \`<div id="cost">\` + Object.entries(costs).map(([a,c]) => \`<div><b>\${esc(a)}</b> \${formatCost(c)}</div>\`).join("") +
      \`<div class="muted">total \${formatCost(run.totalCostUsd)}</div></div>\` +
    \`<div id="tree">\` + tree.map(nodeHtml).join("") + \`</div>\` +
    (run.error ? \`<p class="err">\${esc(run.error)}</p>\` : "");
  for (const el of detail.querySelectorAll("[data-tool]")) {
    el.onclick = async () => {
      if (el.dataset.loaded) return; el.dataset.loaded = "1";
      try {
        const { toolCalls } = await api("/runs/" + run.id + "/tool-calls");
        const name = el.dataset.tool;
        const mine = toolCalls.filter((t) => t.payload && t.payload.name === name);
        el.insertAdjacentHTML("beforeend", '<div class="muted">' + esc(JSON.stringify(mine, null, 1).slice(0, 2000)) + '</div>');
      } catch {}
    };
  }
}

function nodeHtml(n) {
  const pad = "  ".repeat(n.depth);
  const dur = formatDuration(n.startedAt, n.finishedAt);
  const cls = n.status === "error" ? "err" : "";
  const toolAttr = n.kind === "tool" ? \` data-tool="\${esc(n.name)}"\` : "";
  return \`<div class="node \${cls}"\${toolAttr}>\${pad}<span class="kind muted">\${n.kind}</span> \${esc(n.name)} <span class="muted">\${dur}</span></div>\`;
}

function live(id) {
  const k = $("key").value.trim();
  es = new EventSource("/runs/" + id + "/stream?key=" + encodeURIComponent(k));
  // Debounce: many events can arrive in a burst; coalesce into one refetch.
  const schedule = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refreshDetail(id), 150); };
  es.onmessage = schedule;
  for (const ev of ["lifecycle", "message", "tool", "model", "step", "approval", "context", "delegation"]) {
    es.addEventListener(ev, schedule);
  }
  es.onerror = () => { /* EventSource auto-reconnects via Last-Event-ID */ };
}

function esc(s){ return String(s).replace(/[&<>"]/g, (c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }

$("refresh").onclick = loadRuns;
$("status").onchange = loadRuns;
$("key").onchange = loadRuns;
loadRuns();
</script>
</body>
</html>`;
