// app.js -- QSMO Live Console. No framework, no build step. Polls /api/v1/live/* every 2 seconds.
import * as L from "./lib.js";
import * as R from "./report.js";

let API = (globalThis.QSMO_BASE || "") + "/api/v1/live";
export const setApiBase = (b) => { API = b + "/api/v1/live"; };   // used by tests
const $ = (id) => document.getElementById(id);
const PAGES = ["dashboard", "topology", "switches", "timeline", "monitoring", "report"];
const TOAST_KINDS = new Set(["migrated", "rolled_back", "migration_failed", "restore-failed", "reconcile-error"]);

export const S = {
  page: "dashboard", status: null, topo: null, mon: null, report: null,
  timeline: [], lastTs: null, hist: {}, sel: null, filter: "all", err: null,
  prevNodes: new Map(), flash: new Map(), toasts: [], sig: {}, n: 0, layouts: new Map(),
  paused: false, showLat: true, legend: null, sort: null,
  mflt: "all", mexp: new Set(), polOpen: false,
  tsel: null, tlane: null, trun: null, tidle: false, tview: "graph", trange: 8, tkind: "all",
};

async function api(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error("HTTP " + r.status + " " + path);
  return r.json();
}
const query = () => (($("q") && $("q").value) || "").trim().toLowerCase();
const matches = (name, id) => { const q = query(); return !q || String(name).toLowerCase().includes(q) || String(id).includes(q); };
const nameOf = (id) => (S.topo?.nodes.find((n) => n.id === id)?.name) || String(id).slice(-4);

function paint(id, html) {
  const el = $(id);
  if (!el || S.sig[id] === html) return;
  el.innerHTML = html; S.sig[id] = html;
}
function toast(text, cls = "info", ms = 6000) { S.toasts.push({ text, cls, until: Date.now() + ms }); }

// ------------------------------------------------------------------ polling
export async function tick() {
  if (globalThis.document && document.visibilityState === "hidden") return;
  if (S.paused) return;
  S.n++;
  try {
    S.status = await api("/status");
    S.topo = await api("/topology");
    S.mon = await api("/monitoring");
    onTopologyChange();
    await loadTimeline();
    if (S.page === "report") S.report = await api("/report");
    if ((S.page === "topology" || S.page === "dashboard") && S.sel) S.hist[S.sel] = await api("/history/" + S.sel + "?limit=150");
    if (S.page === "monitoring") {
      for (const it of S.mon.items) if (!S.hist[it.dpid] || S.n % 2 === 0) S.hist[it.dpid] = await api("/history/" + it.dpid + "?limit=150");
    }
    S.err = null;
  } catch (e) { S.err = e.message || String(e); }
  renderAll();
}

function onTopologyChange() {
  const now = Date.now();
  for (const ev of L.diffNodes(S.prevNodes, S.topo.nodes)) {
    if (ev.type === "migrated" || ev.type === "rolled_back") S.flash.set(ev.id, { type: ev.type, until: now + 3000 });
    if (ev.type === "degraded") toast(`${nameOf(ev.id)} is degraded`, "bad");
    if (ev.type === "recovered") toast(`${nameOf(ev.id)} recovered`, "good");
  }
  S.prevNodes = new Map(S.topo.nodes.map((n) => [n.id, { state: n.state, health: n.health }]));
  for (const [id, f] of S.flash) if (f.until < now) S.flash.delete(id);
}

async function loadTimeline() {
  const first = S.lastTs == null;
  const r = await api("/timeline?limit=300" + (first ? "" : "&since=" + encodeURIComponent(S.lastTs)));
  const have = new Set(S.timeline.map((i) => i.key));
  const fresh = r.items.filter((i) => !have.has(i.key));
  if (!first) for (const i of fresh) if (TOAST_KINDS.has(i.kind)) {
    const m = L.kindMeta(i.kind);
    toast(`${i.switch || ""} ${m.label}` + (i.recovery_latency_ms ? ` (${Math.round(i.recovery_latency_ms)} ms)` : ""), m.cls === "good" ? "good" : "bad");
  }
  S.timeline = S.timeline.concat(fresh).slice(-500);
  if (r.last_ts) S.lastTs = r.last_ts;
}

// ------------------------------------------------------------------ views
function bannerHtml() {
  if (S.err) return `<div class="b err">Cannot reach the console API (${L.esc(S.err)}). Is uvicorn running?</div>`;
  const s = S.status;
  if (!s) return `<div class="b off">Connecting…</div>`;
  const cls = s.state === "running" ? "running" : s.state === "offline" ? "off" : "warn";
  const txt = s.state === "running"
    ? `● LIVE · monitor heartbeat ${L.ago(s.monitor.age_s)} · ${s.counts.switches} switches, ${s.counts.links} links`
    : `${L.esc(s.message)}`;
  return `<div class="b ${cls}">${txt}</div>`;
}

const sameId = (a, b) => String(a ?? "").toLowerCase().replace(/^0+/, "") === String(b ?? "").toLowerCase().replace(/^0+/, "");

function topoSvg(nodes, edges, W, H) {
  const sig = nodes.map((n) => n.id).join(",") + "|" + W + "x" + H;
  let pos = S.layouts.get(sig);
  if (!pos) { pos = L.layout(nodes, edges, W, H); S.layouts.clear(); S.layouts.set(sig, pos); }
  const nb = new Set();                                   // selected switch + its neighbours stay bright
  if (S.sel) { nb.add(S.sel); for (const e of edges) { if (e.source === S.sel) nb.add(e.target); if (e.target === S.sel) nb.add(e.source); } }
  const q = query();
  const dimmed = (n) => (S.sel && !nb.has(n.id)) || (S.legend && L.nodeClass(n) !== S.legend) || (q && !matches(n.name, n.id));
  const eh = edges.filter((e) => pos.has(e.source) && pos.has(e.target)).map((e) => {
    const a = pos.get(e.source), b = pos.get(e.target);
    const hl = S.sel && (e.source === S.sel || e.target === S.sel);
    return `<line class="edge ${e.protected ? "prot" : ""} ${hl ? "hl" : ""} ${S.sel && !hl ? "dim" : ""}" x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}"/>`;
  }).join("");
  const nh = nodes.map((n) => {
    const p = pos.get(n.id); if (!p) return "";
    const f = S.flash.get(n.id);
    const cls = ["node", L.nodeClass(n), f ? "f-" + f.type : "", S.sel === n.id ? "sel" : "", dimmed(n) ? "dim" : ""].join(" ");
    const sub = S.showLat && n.state === "Hybrid" && n.latency_ms != null ? L.fmtMs(n.latency_ms) : "";
    return `<g class="${cls}" data-node="${L.esc(n.id)}">` +
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="20"/>` +
      `<text x="${p.x.toFixed(1)}" y="${(p.y + 4).toFixed(1)}">${L.esc(n.name)}</text>` +
      `<text class="sub" x="${p.x.toFixed(1)}" y="${(p.y + 36).toFixed(1)}">${L.esc(sub)}</text></g>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}">${eh}${nh}</svg>`;
}

const legendHtml = () => {
  const it = (k, color, text, extra = "") => `<span data-act="legend" data-id="${k}" class="${S.legend === k ? "active" : ""}" title="Click to highlight only these"><i class="dot" style="background:${color};${extra}"></i>${text}</span>`;
  return `<div class="legend">${it("legacy", "#7c8aa5", "Legacy")}${it("hybrid-ok", "#22c55e", "Hybrid healthy")}${it("hybrid-bad", "#f59e0b", "Hybrid degraded")}` +
    `${it("hybrid-pending", "#5eead4", "Hybrid, waiting for health", "border:1px dashed #0d9488")}` +
    `<span><i class="dot" style="background:#16a34a;height:4px;border-radius:2px;width:16px"></i>Protected link</span></div>`;
};
const toolsHtml = () => `<div class="tools"><button data-act="resetlayout">↺ Reset layout</button>` +
  `<button data-act="togglelat" class="${S.showLat ? "active" : ""}">Latency labels</button>` +
  `<button data-act="clearsel" ${S.sel ? "" : "disabled"}>Clear selection</button><span class="hint">Drag nodes · click to inspect · hover for details</span></div>`;

const badge = (cls, text) => `<span class="badge ${cls}">${L.esc(text)}</span>`;
const stateBadge = (n) => badge(L.nodeClass(n), n.state === "Hybrid" ? (n.health === "n/a" ? "Hybrid" : "Hybrid · " + n.health) : "Legacy");
const kpi = (v, l, cls = "", go = "") => `<div class="kpi ${cls}" ${go ? `data-act="goto" data-id="${go}" title="Click to open"` : ""}><div class="v">${v}</div><div class="l">${l}</div></div>`;

function eventRow(i) {
  const m = L.kindMeta(i.kind);
  const extra = i.recovery_latency_ms ? ` <span class="muted">· recovery ${Math.round(i.recovery_latency_ms)} ms</span>` : "";
  return `<div class="ev ${m.cls}" ${i.dpid ? `data-act="sel" data-id="${L.esc(i.dpid)}" title="Click to inspect this switch"` : ""}><span class="t">${L.timeShort(i.ts)}</span><span class="ic">${m.icon}</span>` +
    `<div><b>${L.esc(i.switch || "")}</b> ${L.esc(m.label)}${extra}<div class="muted small">${L.esc(i.message || "")}</div></div></div>`;
}

function viewDashboard() {
  const s = S.status, c = s?.counts || { switches: 0, hybrid: 0, legacy: 0, degraded: 0 };
  const pct = c.switches ? Math.round((c.hybrid / c.switches) * 100) : 0;
  const recent = S.timeline.slice(-8).reverse().map(eventRow).join("") || `<div class="muted">No events yet.</div>`;
  const topo = S.topo && S.topo.nodes.length
    ? `<div class="topo">${toolsHtml()}${topoSvg(S.topo.nodes, S.topo.edges, 600, 320)}${legendHtml()}</div>`
    : `<div class="empty">No switches yet. Waiting for the controller to discover the network…</div>`;
  const side = (S.sel ? `<div class="card panel">${panelHtml()}</div>` : "") + `<div class="card"><h2>Latest events</h2>${recent}</div>`;
  return `<div class="grid">${kpi(c.switches, "Switches", "k-all", "switches|all")}${kpi(c.hybrid + ` <span class="muted small">(${pct}%)</span>`, "Hybrid (quantum-safe)", "k-hyb", "switches|Hybrid")}` +
    `${kpi(c.legacy, "Legacy", "k-leg", "switches|Legacy")}${kpi(c.degraded, "Degraded", "k-bad", "switches|degraded")}${kpi(s ? Math.round(s.rollback_rate * 100) + "%" : "–", "Rollback rate", "k-roll", "report|all")}</div>` +
    `<div class="row"><div><h2>Network</h2>${topo}</div><div class="stack">${side}</div></div>`;
}

function panelHtml() {
  const n = S.topo?.nodes.find((x) => x.id === S.sel);
  if (!n) return `<div class="muted">Click a switch to see its details.</div>`;
  const h = S.hist[n.id];
  const limit = S.mon?.policy?.consecutive_degraded_observations;
  const mi = S.mon?.items.find((x) => x.dpid === n.id);
  const rb = S.timeline.filter((i) => i.kind === "rolled_back" && sameId(i.dpid, n.id)).pop();
  const slow = n.state === "Hybrid" && n.change_pct != null && n.change_pct > 200;
  return `<h3>${L.esc(n.name)} ${stateBadge(n)}</h3><div class="muted small">${L.esc(n.id)}</div><dl>` +
    `<dt>Latency</dt><dd>${L.fmtMs(n.latency_ms)}</dd><dt>Rolling median</dt><dd>${L.fmtMs(n.rolling_median_ms)}</dd>` +
    `<dt>Success rate</dt><dd>${L.fmtRate(n.success_rate)}</dd><dt>Legacy baseline</dt><dd>${L.fmtMs(n.legacy_baseline_ms)}</dd>` +
    `<dt>Hybrid baseline</dt><dd>${L.fmtMs(n.hybrid_baseline_ms)}</dd><dt>Change</dt><dd>${L.fmtPct(n.change_pct)}</dd></dl>` +
    (n.state === "Hybrid" ? L.strikeHtml(n.degraded_count, limit) : "") +
    (mi?.reasons?.length ? `<div class="small" style="color:var(--warn)">${mi.reasons.map(L.esc).join("<br>")}</div>` : "") +
    (n.state === "Hybrid" ? `<div style="margin-top:8px">${L.chartSvg(h?.points, h)}</div>` : "") +
    (slow ? `<div class="callout">Hybrid latency is ${L.fmtPct(n.change_pct)} vs Legacy. This switch will be rolled back by the legacy-compare check.</div>` : "") +
    (n.state !== "Hybrid" && rb ? `<div class="callout bad"><b>Last rollback</b> (${L.timeShort(rb.ts)}):<br>${L.esc(rb.message || "")}</div>` : "");
}

function viewTopology() {
  if (!S.topo || !S.topo.nodes.length) return `<div class="empty">No switches yet. Waiting for the controller to discover the network…</div>`;
  return `<div class="row"><div class="topo">${toolsHtml()}${topoSvg(S.topo.nodes, S.topo.edges, 900, 520)}${legendHtml()}</div>` +
    `<div class="card panel">${panelHtml()}</div></div>`;
}

function viewSwitches() {
  const f = S.filter;
  const btn = (k, t) => `<button data-act="filter" data-id="${k}" class="${f === k ? "active" : ""}">${t}</button>`;
  const cmp = S.sort
    ? (a, b) => { const x = a[S.sort.key], y = b[S.sort.key]; const r = x == null ? (y == null ? 0 : 1) : y == null ? -1 : typeof x === "string" ? x.localeCompare(y, undefined, { numeric: true }) : x - y; return S.sort.dir * r; }
    : (a, b) => (a.state === b.state ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.state === "Hybrid" ? -1 : 1);
  const th = (key, t) => `<th data-act="sort" data-id="${key}" title="Click to sort">${t}${S.sort?.key === key ? (S.sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`;
  const rows = (S.topo?.nodes || []).filter((n) => matches(n.name, n.id))
    .filter((n) => f === "all" || (f === "degraded" ? n.health === "degraded" : n.state === f))
    .sort(cmp)
    .map((n) => `<tr data-act="opensw" data-id="${L.esc(n.id)}" class="${n.health === "degraded" ? "degraded" : ""} ${S.sel === n.id ? "sel" : ""}"><td><b>${L.esc(n.name)}</b></td><td class="muted small">${L.esc(n.id)}</td>` +
      `<td>${stateBadge(n)}</td><td>${L.fmtMs(n.latency_ms)}</td><td>${L.fmtMs(n.rolling_median_ms)}</td>` +
      `<td>${L.fmtMs(n.legacy_baseline_ms)}</td><td>${L.fmtMs(n.hybrid_baseline_ms)}</td><td>${L.fmtPct(n.change_pct)}</td></tr>`).join("");
  return `<div class="filters">${btn("all", "All")}${btn("Hybrid", "Hybrid")}${btn("Legacy", "Legacy")}${btn("degraded", "Degraded")}</div>` +
    (rows ? `<div class="tablewrap"><table><tr>${th("name", "Switch")}<th>DPID</th>${th("state", "State")}${th("latency_ms", "Latency")}${th("rolling_median_ms", "Median")}${th("legacy_baseline_ms", "Legacy baseline")}${th("hybrid_baseline_ms", "Hybrid baseline")}${th("change_pct", "Change")}</tr>${rows}</table></div>`
          : `<div class="empty">No switches match.</div>`);
}

// ====================================================================== TIMELINE (graph + detail)
const TL_KIND = { all: "Everything", mig: "Migrations", rb: "Rollbacks", bad: "Failures", sys: "System" };
const tlKindOf = (k) => (k === "migrated" || k === "adopt" ? "mig" : k === "rolled_back" ? "rb" : /failed|error/.test(k) ? "bad" : "sys");
const MARK = { good: "#16a34a", bad: "#dc2626", warn: "#d97706", info: "#2563eb" };

const CELL = { up: ["▲ Hybrid", "Migrated to Hybrid"], rb2: ["▲▼", "Migrated, then rolled back"], rb: ["▼ Legacy", "Rolled back to Legacy"], fail: ["✕ Failed", "Migration failed"], stay: ["Hybrid", "Still in Hybrid"], none: ["·", "No activity"] };
const runLabel = (r) => {
  const d = new Date(r.start), today = new Date().toDateString() === d.toDateString();
  return (today ? "" : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " · ") + L.clock(r.start, false);
};

function cellHtml(c, ln, run) {
  const [txt, what] = CELL[c.kind];
  const label = c.kind === "rb2" ? `▲▼ ${L.shortDur(c.hybridMs)}` : txt;
  const tip = `<b>${L.esc(ln.name)}</b> · Run ${run.n}<br>${L.esc(what)}` +
    (c.hybridMs != null ? `<br>Stayed in Hybrid ${L.esc(L.fmtDur(c.hybridMs))}` : "") +
    (c.evs.length ? `<br><span style="opacity:.7">Click for details</span>` : "");
  const sel = c.key && S.tsel === c.key;
  const act = c.key ? `data-act="tsel" data-id="${L.esc(c.key)}"` : "";
  return `<td class="c ${c.kind} ${sel ? "sel" : ""} ${c.key ? "click" : ""}" ${act} data-tip="${L.esc(tip)}"><span class="pill">${label}${c.note ? `<i class="note">•</i>` : ""}</span></td>`;
}

function timelineGraph(M) {
  const all = M.runs;
  if (!all.length) return `<div class="empty">Nothing to show yet.</div>`;
  const runs = S.trange ? all.slice(-S.trange) : all, off = all.length - runs.length;
  const idle = M.lanes.filter((l) => !runs.some((_, i) => l.cells[off + i].evs.length) && l.state !== "Hybrid");
  const lanes = M.lanes.filter((l) => matches(l.name, l.id) && (S.tidle || !idle.includes(l)));
  const head = runs.map((r) => `<th class="rh ${S.trun === r.n ? "sel" : ""}" data-act="trun" data-id="${r.n}" title="Click for the full list of events in this run">` +
    `<b>Run ${r.n}</b><span class="rt">${L.esc(runLabel(r))}</span>` +
    `<span class="rc">${r.mig ? `<i class="g">▲${r.mig}</i>` : ""}${r.rb ? `<i class="r">▼${r.rb}</i>` : ""}${r.bad ? `<i class="x">✕${r.bad}</i>` : ""}${!r.mig && !r.rb && !r.bad ? `<i class="m">events ${r.evs.length}</i>` : ""}</span></th>`).join("");
  const rows = lanes.map((l) => {
    const node = S.topo?.nodes.find((n) => n.id === l.id);
    return `<tr><th class="sw ${S.tlane === l.id ? "sel" : ""}" data-act="tlane" data-id="${L.esc(l.id)}" title="Click for ${L.esc(l.name)} history">${L.esc(l.name)}</th>` +
      runs.map((r, i) => cellHtml(l.cells[off + i], l, r)).join("") +
      `<td class="now">${node ? stateBadge(node) : `<span class="muted">–</span>`}</td></tr>`;
  }).join("");
  const sum = `<tr class="sum"><th class="sw">In Hybrid</th>${runs.map((r) => `<td><b>${r.hybrid}</b><div class="mb"><i style="width:${Math.round((r.hybrid / M.max) * 100)}%"></i></div></td>`).join("")}` +
    `<td class="now"><b>${(S.topo?.nodes || []).filter((n) => n.state === "Hybrid").length}</b> <span class="muted small">now</span></td></tr>`;
  const w = 70 + runs.length * 84 + 150;
  return (off ? `<div class="muted small tl-note">Showing the latest ${runs.length} of ${all.length} runs.</div>` : "") +
    `<div class="rmwrap"><table class="rm" style="min-width:${w}px"><colgroup><col style="width:70px">${runs.map(() => `<col>`).join("")}<col style="width:150px"></colgroup>` +
    `<thead><tr><th class="sw">Switch</th>${head}<th class="now">Now</th></tr></thead><tbody>${rows}${sum}</tbody></table></div>` +
    (idle.length ? `<div class="muted small tl-note">${S.tidle ? "Showing" : "Hiding"} ${idle.length} idle switch${idle.length === 1 ? "" : "es"} (${L.esc(idle.slice(0, 6).map((l) => l.name).join(", "))}${idle.length > 6 ? "…" : ""}) · <button class="linkbtn" data-act="tidle">${S.tidle ? "Hide them" : "Show them"}</button></div>` : "") +
    `<div class="legend tl-legend"><span><i class="lg up"></i>Migrated to Hybrid</span><span><i class="lg rb2"></i>Migrated, then rolled back (time in Hybrid)</span>` +
    `<span><i class="lg rb"></i>Rolled back to Legacy</span><span><i class="lg fail"></i>Failed</span><span><i class="lg stay"></i>Still in Hybrid</span>` +
    `<span class="hint">Click a cell for details · a run header for all its events · a switch name for its history</span></div>`;
}

function evKv(k, v) { return v == null || v === "" ? "" : `<dt>${k}</dt><dd>${v}</dd>`; }

function tlEventRow(i) {
  const m = L.kindMeta(i.kind);
  return `<div class="ev ${m.cls} ${S.tsel === i.key ? "sel" : ""}" data-act="tsel" data-id="${L.esc(i.key)}"><span class="t">${L.timeShort(i.ts)}</span><span class="ic">${m.icon}</span>` +
    `<div><b>${L.esc(i.switch || "System")}</b> ${L.esc(m.label)}${i.recovery_latency_ms ? ` <span class="muted">· recovery ${L.esc(L.fmtDur(i.recovery_latency_ms))}</span>` : ""}` +
    `<div class="muted small">${L.esc(L.humanReason(i.message || ""))}</div></div></div>`;
}

function timelineDetail(M) {
  const run = S.trun != null && M.runs.find((r) => r.n === S.trun);
  if (run) {
    return `<div class="card detail"><div class="dhead"><div><b class="dtitle">Run ${run.n} · ${L.esc(runLabel(run))}</b>` +
      `<div class="muted small">${run.mig} migrated · ${run.rb} rolled back · ${run.bad} failed · ${run.other} other event${run.other === 1 ? "" : "s"} · lasted ${L.esc(L.shortDur(run.end - run.start))}</div></div>` +
      `<div class="dbtn"><button data-act="tclear">✕ Close</button></div></div>${run.evs.slice(-60).map(tlEventRow).join("")}</div>`;
  }
  const ev = S.tsel && S.timeline.find((i) => i.key === S.tsel);
  if (ev) {
    const m = L.kindMeta(ev.kind), flows = ev.flows || [];
    const same = S.timeline.filter((i) => ev.dpid && i.dpid === ev.dpid && i.key !== ev.key).slice(-4).reverse();
    return `<div class="card detail ${m.cls}"><div class="dhead"><div><span class="dic ${m.cls}">${m.icon}</span> <b class="dtitle">${L.esc(ev.switch || "System")} · ${L.esc(m.label)}</b>` +
      `<div class="muted small">${L.esc(new Date(ev.ts).toLocaleString([], { hour12: false }))} · recorded by ${L.esc(ev.source)}</div></div>` +
      `<div class="dbtn">${ev.dpid ? `<button data-act="sel" data-id="${L.esc(ev.dpid)}">Inspect switch</button>` : ""}<button data-act="tclear">✕ Close</button></div></div>` +
      `<dl class="dl">${evKv("What happened", L.esc(L.humanReason(ev.message)))}${ev.message && L.humanReason(ev.message) !== ev.message ? evKv("Raw reason", `<code class="small">${L.esc(ev.message)}</code>`) : ""}` +
      `${evKv("Recovery time", ev.recovery_latency_ms ? L.esc(L.fmtDur(ev.recovery_latency_ms)) : "")}` +
      `${evKv("Latency before → after", ev.before_ms != null || ev.after_ms != null ? `${L.fmtMs(ev.before_ms)} → ${L.fmtMs(ev.after_ms)}` : "")}` +
      `${evKv("Flows affected", flows.length ? `${flows.length} <span class="muted small">${flows.slice(0, 4).map((f) => L.esc(typeof f === "string" ? f : JSON.stringify(f))).join(" · ")}${flows.length > 4 ? " …" : ""}</span>` : "")}` +
      `${evKv("Switch ID", `<code class="small">${L.esc(ev.dpid || "–")}</code>`)}</dl>` +
      (same.length ? `<div class="small muted" style="margin-top:6px">Also on ${L.esc(ev.switch)}:</div>${same.map(tlEventRow).join("")}` : "") + `</div>`;
  }
  const ln = S.tlane && S.topo?.nodes.find((n) => n.id === S.tlane);
  if (ln) {
    const mine = S.timeline.filter((i) => i.dpid === ln.id).slice().reverse();
    const nm = mine.filter((i) => i.kind === "migrated").length, nr = mine.filter((i) => i.kind === "rolled_back").length;
    return `<div class="card detail"><div class="dhead"><div><b class="dtitle">${L.esc(ln.name)}</b> ${stateBadge(ln)}<div class="muted small">${nm} migration${nm === 1 ? "" : "s"} · ${nr} rollback${nr === 1 ? "" : "s"} · ${L.esc(ln.id)}</div></div>` +
      `<div class="dbtn"><button data-act="sel" data-id="${L.esc(ln.id)}">Inspect switch</button><button data-act="tclear">✕ Close</button></div></div>` +
      (mine.map(tlEventRow).join("") || `<div class="muted">No events recorded for this switch yet.</div>`) + `</div>`;
  }
  return `<div class="card detail hintcard"><b>Details appear here.</b> <span class="muted">Click any cell, a run header, or a switch name, to see exactly what happened, why, and how long recovery took.</span></div>`;
}

function viewTimeline() {
  const cnt = { mig: 0, rb: 0, bad: 0, sys: 0 };
  for (const i of S.timeline) cnt[tlKindOf(i.kind)]++;
  const M = L.buildRuns(S.timeline, S.topo?.nodes || [], Date.now());
  const all = S.timeline.filter((i) => !i.switch || matches(i.switch, i.dpid || ""));
  const chip = (act, id, cur, text) => `<button data-act="${act}" data-id="${id}" class="${String(cur) === String(id) ? "active" : ""}">${text}</button>`;
  const bar = `<div class="tlbar"><div class="seg2">${chip("tview", "graph", S.tview, "▦ Runs")}${chip("tview", "list", S.tview, "☰ List")}</div>` +
    (S.tview === "graph" ? `<div class="seg2">${[[8, "Last 8 runs"], [16, "Last 16"], [0, "All runs"]].map(([m, t]) => chip("trange", m, S.trange, t)).join("")}</div>`
      : `<div class="seg2">${Object.entries(TL_KIND).map(([k, t]) => chip("tkind", k, S.tkind, t + (k !== "all" ? ` <span class="n">${cnt[k]}</span>` : ""))).join("")}</div>`) +
    `<div class="tlstats"><span>${M.runs.length} run${M.runs.length === 1 ? "" : "s"}</span><span class="good">▲ ${cnt.mig} migrated</span><span class="bad">▼ ${cnt.rb} rolled back</span>${cnt.bad ? `<span class="bad">✕ ${cnt.bad} failed</span>` : ""}</div></div>`;
  let main;
  if (!S.timeline.length) main = `<div class="card"><div class="muted">No events yet. Run <code>sudo ./run_migration.sh</code> to create some.</div></div>`;
  else if (S.tview === "graph") main = `<div class="card"><h2>Migration runs · what happened to each switch</h2>${timelineGraph(M)}</div>`;
  else main = `<div class="card">${all.filter((i) => S.tkind === "all" || tlKindOf(i.kind) === S.tkind).slice().reverse().map(tlEventRow).join("") || `<div class="muted">No events in this group.</div>`}</div>`;
  return bar + main + timelineDetail(M);
}


// ====================================================================== MONITORING
function polHtml(pol) {
  const keys = Object.keys(pol || {});
  if (!keys.length) return `<div class="muted small">Monitor policy and strike counters are not published yet. Run <code>python3 tools/patch_monitor_status.py</code>, then restart <code>./run_monitor.sh</code>.</div>`;
  const seen = new Set();
  const grp = L.POLICY_GROUPS.map(([title, map]) => {
    const rows = Object.entries(map).filter(([k]) => pol[k] != null).map(([k, [lab, unit]]) => { seen.add(k); return `<dt>${lab}</dt><dd>${L.esc(pol[k])}${unit ? ` <span class="muted small">${unit}</span>` : ""}</dd>`; }).join("");
    return rows ? `<div class="pg"><h4>${title}</h4><dl>${rows}</dl></div>` : "";
  });
  const rest = keys.filter((k) => !seen.has(k)).map((k) => `<dt>${L.esc(k)}</dt><dd>${L.esc(pol[k])}</dd>`).join("");
  return `<div class="pgrid">${grp.join("")}${rest ? `<div class="pg"><h4>Other</h4><dl>${rest}</dl></div>` : ""}</div>`;
}

function monCard(i, limit) {
  const h = S.hist[i.dpid], open = S.mexp.has(i.dpid), bad = i.status === "degraded";
  const st = bad ? "bad" : i.status ? "ok" : "wait";
  const med = i.rolling_median_ms ?? i.latency_ms, lim = h?.limit_ms;
  const used = lim && med != null ? Math.round((med / lim) * 100) : null;
  const barCls = used == null ? "" : used >= 100 ? "bad" : used >= 70 ? "warn" : "ok";
  const lat = i.latency_ms == null ? "–" : (i.latency_ms >= 100 ? i.latency_ms.toFixed(0) : i.latency_ms.toFixed(1));
  const strikes = i.degraded_count > 0 && limit ? `<div class="mstrike">⚠ Strike ${i.degraded_count} of ${limit}</div>` : "";
  const details = open ? `<div class="mdetail"><dl>` +
    `<dt>Rolling median</dt><dd>${L.fmtMs(i.rolling_median_ms)}</dd><dt>Success rate</dt><dd>${L.fmtRate(i.success_rate)}</dd>` +
    `<dt>Limit</dt><dd>${L.fmtMs(lim)}${h?.limits_estimated ? ` <span class="muted small">(estimated)</span>` : ""}</dd><dt>Legacy baseline</dt><dd>${L.fmtMs(h?.legacy_mean_ms)}</dd>` +
    `<dt>Hybrid baseline</dt><dd>${L.fmtMs(h?.hybrid_mean_ms)}</dd></dl>${L.strikeHtml(i.degraded_count, limit)}${L.chartSvg(h?.points, h)}` +
    (i.reasons?.length ? `<div class="small" style="color:var(--warn);margin-top:6px">${i.reasons.map(L.esc).join("<br>")}</div>` : "") +
    `<button class="linkbtn" data-act="sel" data-id="${L.esc(i.dpid)}">Open in topology →</button></div>` : "";
  return `<div class="mcard ${st} ${open ? "open" : ""}" data-act="mexp" data-id="${L.esc(i.dpid)}" title="Click for details">` +
    `<div class="mhead"><b>${L.esc(i.switch)}</b>${badge(bad ? "hybrid-bad" : i.status ? "hybrid-ok" : "hybrid-pending", bad ? "degraded" : i.status === "healthy" ? "healthy" : "waiting")}<span class="chev">${open ? "▴" : "▾"}</span></div>` +
    `<div class="mval"><span class="big">${lat}</span><span class="unit"> ms</span><span class="muted small"> &nbsp;median ${L.fmtMs(i.rolling_median_ms)}</span></div>` +
    `${L.sparkSvg(h?.points, h)}` +
    (used != null ? `<div class="hb ${barCls}"><i style="width:${Math.min(100, used)}%"></i></div><div class="small muted">${used}% of the ${L.fmtMs(lim)} limit</div>` : "") +
    strikes + details + `</div>`;
}

function viewMonitoring() {
  const pol = S.mon?.policy || {}, limit = pol.consecutive_degraded_observations;
  const all = (S.mon?.items || []).filter((i) => matches(i.switch, i.dpid));
  const cls = (i) => (i.status === "degraded" ? "degraded" : i.status ? "healthy" : "waiting");
  const cnt = { all: all.length, degraded: 0, healthy: 0, waiting: 0 };
  for (const i of all) cnt[cls(i)]++;
  const chip = (k, t) => `<button data-act="mflt" data-id="${k}" class="${S.mflt === k ? "active" : ""}">${t} <span class="n">${cnt[k]}</span></button>`;
  const rank = { degraded: 0, waiting: 1, healthy: 2 };
  const shown = all.filter((i) => S.mflt === "all" || cls(i) === S.mflt).sort((a, b) => rank[cls(a)] - rank[cls(b)] || a.switch.localeCompare(b.switch, undefined, { numeric: true }));
  const summary = L.policySummary(pol);
  const kpis = `<div class="grid">${kpi(cnt.all, "Hybrid switches monitored", "k-all")}${kpi(cnt.healthy, "Healthy", "k-hyb")}${kpi(cnt.degraded, "Degraded", "k-bad")}${kpi(cnt.waiting, "Waiting for first reading", "k-leg")}</div>`;
  const policy = `<div class="card polcard"><div class="polhead"><div><h2 style="margin:0">Monitor policy</h2>${summary ? `<div class="small muted" style="margin-top:3px">${L.esc(summary)}</div>` : ""}</div>` +
    `<button data-act="poltoggle">${S.polOpen ? "Hide settings ▴" : "Show all settings ▾"}</button></div>${S.polOpen ? polHtml(pol) : ""}</div>`;
  const body = shown.length ? `<div class="mgrid">${shown.map((i) => monCard(i, limit)).join("")}</div>`
    : all.length ? `<div class="empty">No switches in this group.</div>`
    : `<div class="empty">No Hybrid switches yet. Migrate some with <code>sudo ./run_migration.sh</code>.</div>`;
  return kpis + policy + `<div class="filters" style="margin-top:14px">${chip("all", "All")}${chip("degraded", "Degraded")}${chip("healthy", "Healthy")}${chip("waiting", "Waiting")}</div>` + body;
}

// ====================================================================== REPORT
function viewReport() {
  const r = S.report;
  if (!r) return `<div class="muted">Loading…</div>`;
  const rows = r.rows.filter((x) => matches(x.switch, x.dpid));
  return `<div class="rp-bar"><div><b>Migration report</b><div class="muted small">Live view · the downloaded file is a snapshot of what you see now</div></div>` +
    `<div class="rp-actions"><button class="primary" data-act="dl-html">⬇ Download report</button><button data-act="dl-pdf">🖨 Save as PDF</button><button data-act="dl-csv">⬇ CSV (Excel)</button></div></div>` +
    `<div class="rp-screen">${R.reportBody(r, rows)}</div>`;
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
}
async function fresh() { try { S.report = await api("/report"); } catch (e) { /* keep what is on screen */ } return S.report; }
async function doDownload(kind) {
  const r = await fresh(); if (!r) return;
  if (kind === "html") { download(R.reportFileName(r, "html"), R.reportDocument(r), "text/html;charset=utf-8"); toast("Report downloaded", "good"); }
  else if (kind === "csv") { download(R.reportFileName(r, "csv"), R.reportCsv(r), "text/csv;charset=utf-8"); toast("CSV downloaded", "good"); }
  else {                                                    // PDF: print the standalone report from a hidden frame -> "Save as PDF"
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    f.srcdoc = R.reportDocument(r); document.body.appendChild(f);
    f.onload = () => { try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e) { toast("Printing is blocked – use Download report instead", "bad"); } setTimeout(() => f.remove(), 60000); };
  }
  renderAll();
}

const VIEWS = { dashboard: viewDashboard, topology: viewTopology, switches: viewSwitches, timeline: viewTimeline, monitoring: viewMonitoring, report: viewReport };

export function renderAll() {
  const now = Date.now();
  S.toasts = S.toasts.filter((t) => t.until > now);
  paint("banner", bannerHtml());
  paint("view", VIEWS[S.page]());
  paint("toasts", S.toasts.map((t) => `<div class="toast ${t.cls}">${L.esc(t.text)}</div>`).join(""));
}

export function setPage(p) {
  const tp = globalThis.document && $("tip"); if (tp && tp.style) tp.style.display = "none";
  S.page = PAGES.includes(p) ? p : "dashboard";
  if (globalThis.document) document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.page === S.page));
  renderAll();
}

export function start() {
  if (globalThis.document && document.head && !document.getElementById("rp-css")) {
    const st = document.createElement("style"); st.id = "rp-css"; st.textContent = R.REPORT_CSS; document.head.appendChild(st);
  }
  const fromHash = () => setPage((location.hash || "").replace("#/", ""));
  window.addEventListener("hashchange", () => { fromHash(); tick(); });
  const tip = $("tip");
  const select = (id) => { S.sel = S.sel === id ? null : id; renderAll(); tick(); };

  document.addEventListener("click", (e) => {
    const t = e.target.closest && e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act, id = t.dataset.id;
    if (act === "sel") { S.sel = id; if (S.page !== "dashboard") location.hash = "#/topology"; renderAll(); tick(); }
    else if (act === "opensw") { S.sel = id; location.hash = "#/topology"; }
    else if (act === "filter") { S.filter = id; renderAll(); }
    else if (act === "goto") { const [pg, fl] = id.split("|"); S.filter = fl; location.hash = "#/" + pg; }
    else if (act === "legend") { S.legend = S.legend === id ? null : id; renderAll(); }
    else if (act === "sort") { const d = S.sort && S.sort.key === id ? -S.sort.dir : 1; S.sort = { key: id, dir: d }; renderAll(); }
    else if (act === "resetlayout") { S.layouts.clear(); renderAll(); }
    else if (act === "togglelat") { S.showLat = !S.showLat; renderAll(); }
    else if (act === "mexp") { S.mexp.has(id) ? S.mexp.delete(id) : S.mexp.add(id); renderAll(); }
    else if (act === "mflt") { S.mflt = id; renderAll(); }
    else if (act === "poltoggle") { S.polOpen = !S.polOpen; renderAll(); }
    else if (act === "tsel") { S.tsel = S.tsel === id ? null : id; S.tlane = null; S.trun = null; renderAll(); }
    else if (act === "trun") { S.trun = S.trun === Number(id) ? null : Number(id); S.tsel = null; S.tlane = null; renderAll(); }
    else if (act === "tidle") { S.tidle = !S.tidle; renderAll(); }
    else if (act === "tlane") { S.tlane = S.tlane === id ? null : id; S.tsel = null; S.trun = null; renderAll(); }
    else if (act === "tclear") { S.tsel = null; S.tlane = null; S.trun = null; renderAll(); }
    else if (act === "tview") { S.tview = id; renderAll(); }
    else if (act === "trange") { S.trange = Number(id); renderAll(); }
    else if (act === "tkind") { S.tkind = id; renderAll(); }
    else if (act === "dl-html" || act === "dl-csv" || act === "dl-pdf") doDownload(act.slice(3));
    else if (act === "clearsel") { S.sel = null; renderAll(); }
  });

  // pause button
  const pb = $("pause");
  if (pb) pb.addEventListener("click", () => {
    S.paused = !S.paused; pb.textContent = S.paused ? "▶ Resume" : "⏸ Pause"; pb.classList.toggle("on", S.paused);
    if (!S.paused) tick();
  });

  // drag a node to rearrange; a click without movement selects it
  let drag = null;
  const svgPoint = (e) => {
    const svg = $("view").querySelector(".topo svg"); if (!svg) return null;
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY;
    const m = svg.getScreenCTM(); if (!m) return null;
    const p = pt.matrixTransform(m.inverse()), vb = svg.viewBox.baseVal;
    return { x: Math.min(vb.width - 20, Math.max(20, p.x)), y: Math.min(vb.height - 30, Math.max(20, p.y)) };
  };
  document.addEventListener("pointerdown", (e) => {
    const g = e.target.closest && e.target.closest("g.node[data-node]");
    if (g) drag = { id: g.dataset.node, x: e.clientX, y: e.clientY, moved: false };
  });
  document.addEventListener("pointermove", (e) => {
    if (drag) {
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      drag.moved = true; if (tip) tip.style.display = "none";
      const p = svgPoint(e), pos = [...S.layouts.values()][0];
      if (p && pos) { pos.set(drag.id, p); renderAll(); }
      return;
    }
    // hover tooltip (works even though the SVG is re-rendered every second)
    const tt = e.target.closest && e.target.closest("[data-tip]");
    if (tt && tip) {
      tip.innerHTML = tt.dataset.tip; tip.style.display = "block";
      tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 270) + "px"; tip.style.top = (e.clientY + 14) + "px"; return;
    }
    const g = e.target.closest && e.target.closest("g.node[data-node]");
    if (!g || !tip) { if (tip) tip.style.display = "none"; return; }
    const n = S.topo?.nodes.find((x) => x.id === g.dataset.node); if (!n) return;
    tip.innerHTML = `<b>${L.esc(n.name)}</b> · ${L.esc(n.state)}${n.health && n.health !== "n/a" ? " · " + L.esc(n.health) : ""}<br>` +
      `Latency ${L.fmtMs(n.latency_ms)} · median ${L.fmtMs(n.rolling_median_ms)}<br>Legacy ${L.fmtMs(n.legacy_baseline_ms)} → Hybrid ${L.fmtMs(n.hybrid_baseline_ms)}`;
    tip.style.display = "block";
    tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 270) + "px"; tip.style.top = (e.clientY + 14) + "px";
  });
  document.addEventListener("pointerup", () => {
    if (!drag) return;
    const d = drag; drag = null;
    if (!d.moved) select(d.id);
  });

  const q = $("q"); if (q) q.addEventListener("input", renderAll);
  fromHash(); tick(); setInterval(tick, globalThis.QSMO_POLL_MS || 2000);
}

if (globalThis.document && !globalThis.QSMO_NO_AUTOSTART) start();
