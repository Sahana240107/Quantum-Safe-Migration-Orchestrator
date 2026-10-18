// lib.js -- pure helpers (no DOM). Unit-tested in tests/test_lib.mjs.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const fmtMs = (x) => (x == null ? "–" : (x >= 100 ? x.toFixed(0) : x.toFixed(1)) + " ms");
export const fmtPct = (x) => (x == null ? "–" : (x > 0 ? "+" : "") + Math.round(x) + "%");
export const fmtRate = (x) => (x == null ? "–" : Math.round(x * 100) + "%");

export function ago(sec) {
  if (sec == null) return "–";
  if (sec < 2) return "just now";
  if (sec < 60) return Math.round(sec) + " s ago";
  if (sec < 3600) return Math.round(sec / 60) + " min ago";
  return Math.round(sec / 3600) + " h ago";
}

export function timeShort(iso) {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString([], { hour12: false });
}

// ---- classification ---------------------------------------------------
export function nodeClass(n) {
  if (n.state !== "Hybrid") return "legacy";
  if (n.health === "degraded") return "hybrid-bad";
  if (n.health === "healthy") return "hybrid-ok";
  return "hybrid-pending";
}

const KINDS = {
  migrated: { label: "Migrated to Hybrid", cls: "good", icon: "▲" },
  migration_failed: { label: "Migration failed", cls: "bad", icon: "✕" },
  rolled_back: { label: "Rolled back to Legacy", cls: "bad", icon: "▼" },
  reconcile: { label: "Reconciled", cls: "info", icon: "●" },
  adopt: { label: "Adopted running tunnel", cls: "info", icon: "●" },
  restore: { label: "Restored", cls: "warn", icon: "●" },
  fix: { label: "Fixed", cls: "warn", icon: "●" },
  "tunnel-restart": { label: "Tunnel restarted", cls: "warn", icon: "●" },
  "restore-failed": { label: "Restore failed", cls: "bad", icon: "✕" },
  "reconcile-error": { label: "Reconcile error", cls: "bad", icon: "✕" },
};
export const kindMeta = (k) => KINDS[k] || { label: k, cls: "info", icon: "●" };

// ---- change detection -------------------------------------------------
// prev: Map(id -> {state, health});  nodes: Topology.nodes. Returns [{id, type}]
export function diffNodes(prev, nodes) {
  const out = [];
  if (!prev || prev.size === 0) return out;           // first load: nothing "changed"
  for (const n of nodes) {
    const p = prev.get(n.id);
    if (!p) continue;
    if (p.state !== "Hybrid" && n.state === "Hybrid") out.push({ id: n.id, type: "migrated" });
    else if (p.state === "Hybrid" && n.state !== "Hybrid") out.push({ id: n.id, type: "rolled_back" });
    else if (n.state === "Hybrid" && p.health !== "degraded" && n.health === "degraded") out.push({ id: n.id, type: "degraded" });
    else if (n.state === "Hybrid" && p.health === "degraded" && n.health === "healthy") out.push({ id: n.id, type: "recovered" });
  }
  return out;
}

// ---- layered layout (any tree / ring / mesh; deterministic) --------------
export function layout(nodes, edges, W, H, pad = 44) {
  const ids = nodes.map((n) => n.id).sort();
  const adj = new Map(ids.map((i) => [i, new Set()]));
  for (const e of edges) {
    if (adj.has(e.source) && adj.has(e.target) && e.source !== e.target) {
      adj.get(e.source).add(e.target); adj.get(e.target).add(e.source);
    }
  }
  const bfs = (src) => {                                     // distances from src inside its component
    const dist = new Map([[src, 0]]); let fr = [src];
    while (fr.length) { const nx = []; for (const u of fr) for (const v of adj.get(u)) if (!dist.has(v)) { dist.set(v, dist.get(u) + 1); nx.push(v); } fr = nx; }
    return dist;
  };
  const layerOf = new Map();
  let base = 0;
  const left = new Set(ids);
  while (left.size) {
    const comp = [...bfs([...left][0]).keys()];
    // root = most CENTRAL switch of this component (smallest eccentricity), then most links, then smallest id
    const ecc = new Map(comp.map((u) => [u, Math.max(...bfs(u).values())]));
    const root = comp.slice().sort((a, b) => ecc.get(a) - ecc.get(b) || adj.get(b).size - adj.get(a).size || (a < b ? -1 : 1))[0];
    let frontier = [root], depth = 0, maxd = 0;
    layerOf.set(root, base); left.delete(root);
    while (frontier.length) {
      const nxt = [];
      for (const u of frontier) for (const v of [...adj.get(u)].sort()) {
        if (left.has(v)) { left.delete(v); layerOf.set(v, base + depth + 1); nxt.push(v); }
      }
      if (nxt.length) { depth++; maxd = depth; }
      frontier = nxt;
    }
    base += maxd + 1;
  }
  const layers = [];
  for (const [id, l] of layerOf) (layers[l] = layers[l] || []).push(id);
  const pos = new Map();
  const maxL = Math.max(0, layers.length - 1);
  layers.forEach((ls, l) => {
    if (!ls) return;
    const key = (id) => {                                   // barycenter of neighbours already placed
      const xs = [...adj.get(id)].filter((n) => pos.has(n)).map((n) => pos.get(n).x);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Infinity;
    };
    ls.sort((a, b) => (key(a) - key(b)) || (a < b ? -1 : 1));
    const y = maxL === 0 ? H / 2 : pad + (l * (H - 2 * pad)) / maxL;
    ls.forEach((id, i) => pos.set(id, { x: pad + ((i + 0.5) * (W - 2 * pad)) / ls.length, y }));
  });
  return pos;
}

// ---- tiny SVG latency chart --------------------------------------------
// points: [{t, latency_ms, median_ms}], h: history response (legacy_mean_ms, limit_ms ...)
export function chartSvg(points, h, W = 320, H = 110) {
  const pts = (points || []).filter((p) => p.latency_ms != null);
  if (pts.length < 2) return `<div class="muted small">Collecting data…</div>`;
  const vals = pts.flatMap((p) => [p.latency_ms, p.median_ms ?? 0]);
  const refs = [h?.legacy_mean_ms, h?.limit_ms].filter((v) => v != null);
  const ymax = Math.max(...vals, ...refs) * 1.1 || 1;
  const X = (i) => 4 + (i * (W - 8)) / (pts.length - 1);
  const Y = (v) => H - 4 - (v / ymax) * (H - 10);
  const line = (key, cls) => {
    const p = pts.filter((q) => q[key] != null);
    return `<polyline class="${cls}" fill="none" points="${p.map((q) => `${X(pts.indexOf(q)).toFixed(1)},${Y(q[key]).toFixed(1)}`).join(" ")}"/>`;
  };
  const ref = (v, cls, label) => v == null ? "" :
    `<line class="${cls}" x1="0" x2="${W}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>` +
    `<text class="ref-label" x="${W - 2}" y="${(Y(v) - 2).toFixed(1)}" text-anchor="end">${esc(label)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    ref(h?.legacy_mean_ms, "ref-legacy", "Legacy " + fmtMs(h?.legacy_mean_ms)) +
    ref(h?.limit_ms, "ref-limit", "limit " + fmtMs(h?.limit_ms)) +
    line("median_ms", "ln-median") + line("latency_ms", "ln-latency") + `</svg>`;
}

// ---- strike meter ---------------------------------------------------------
export function strikeHtml(count, limit) {
  if (count == null || !limit) return "";
  const n = Math.min(limit, 12);
  let s = "";
  for (let i = 0; i < n; i++) s += `<span class="strike ${i < count ? (count >= limit ? "full" : "on") : ""}"></span>`;
  return `<div class="strikes" title="${count} of ${limit} bad readings in a row">${s}<span class="muted small"> ${count}/${limit}</span></div>`;
}

// ======================================================================
// v5 helpers: friendly text, timeline model, sparkline
// ======================================================================
export const tsMs = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? null : t; };

export function fmtDur(ms) {
  if (ms == null || Number.isNaN(ms)) return "–";
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + " s";
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return m + " min" + (s ? " " + s + " s" : "");
}

// 2 decimals under 10 ms, otherwise 1 (reports compare small numbers: 3.37 ms vs 256.4 ms)
export const fmtMs2 = (x) => (x == null ? "–" : (x >= 1000 ? Math.round(x).toLocaleString("en-US") : x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)) + " ms");
export const fmtPct2 = (x) => (x == null ? "–" : (x > 0 ? "+" : "") + Math.round(x).toLocaleString("en-US") + "%");

const RB = /\[legacy-compare\]\s*median\(last\s*(\d+)\)\s*=\s*([\d.]+)\s*ms\s*>\s*limit\s*([\d.]+)\s*ms\s*\(Legacy mean\s*=\s*([\d.]+)\s*ms\)/i;
// "[legacy-compare] median(last 5)=256.446 ms > limit 10.105 ms (Legacy mean=3.368 ms)"  ->  plain English
export function humanReason(reason) {
  if (!reason) return "";
  if (reason === "success") return "Migration completed successfully.";
  if (reason === "reverted") return "Rolled back to Legacy (no reason recorded).";
  if (reason === "failed") return "Migration failed (no reason recorded).";
  const m = RB.exec(reason);
  if (!m) return String(reason);
  const f = (v) => fmtMs2(parseFloat(v));
  return `Hybrid stayed too slow: the median of the last ${m[1]} readings was ${f(m[2])}, above the ${f(m[3])} limit (Legacy averaged ${f(m[4])}).`;
}

export const POLICY_GROUPS = [
  ["Sampling", { poll_interval: ["Poll every", "s"], baseline_samples: ["Baseline samples", ""], warmup_samples: ["Warm-up samples dropped", ""], rolling_window: ["Rolling window", "readings"] }],
  ["Detection", { sigma_multiplier: ["Sigma multiplier", "σ"], min_latency_threshold_ms: ["Minimum threshold", "ms"], degradation_threshold_percent: ["Degradation threshold", "%"],
    legacy_threshold_percent: ["Legacy-compare threshold", "%"], legacy_threshold_floor_ms: ["Legacy-compare floor", "ms"] }],
  ["Rollback", { consecutive_degraded_observations: ["Strikes before rollback", "in a row"], failure_window: ["Failure window", "readings"], failure_threshold: ["Failure threshold", "failures"] }],
];

export function policySummary(pol) {
  if (!pol || !Object.keys(pol).length) return "";
  const bits = [];
  if (pol.poll_interval != null) bits.push(`Checks every ${pol.poll_interval} s`);
  if (pol.consecutive_degraded_observations != null) bits.push(`rolls back after ${pol.consecutive_degraded_observations} bad readings in a row`);
  if (pol.legacy_threshold_percent != null) bits.push(`Hybrid may be up to ${pol.legacy_threshold_percent}% slower than Legacy`);
  return bits.join(" · ");
}

// ---- timeline model -------------------------------------------------------
const START = new Set(["migrated", "adopt"]);
const nameCmp = (a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true });

// items: /timeline items, nodes: /topology nodes, now: ms, rangeMs: null (all) or window length
export function buildTimeline(items, nodes, now, rangeMs = null) {
  const evs = (items || []).map((i) => ({ ...i, t: tsMs(i.ts) })).filter((i) => i.t != null).sort((a, b) => a.t - b.t);
  const first = evs.length ? evs[0].t : now - 60000;
  let t1 = Math.max(now, evs.length ? evs[evs.length - 1].t : now);
  let t0 = rangeMs ? t1 - rangeMs : first;
  const span = Math.max(t1 - t0, 30000);
  if (!rangeMs) t0 = t1 - span;
  const pad = span * 0.025; t0 -= pad; t1 += pad;

  const lanes = new Map();
  for (const n of nodes || []) lanes.set(n.id, { id: n.id, name: n.name, state: n.state, evs: [], segs: [] });
  const sys = [];
  for (const e of evs) {
    if (!e.dpid) { sys.push(e); continue; }
    if (!lanes.has(e.dpid)) lanes.set(e.dpid, { id: e.dpid, name: e.switch || e.dpid.slice(-4), state: "Legacy", evs: [], segs: [] });
    lanes.get(e.dpid).evs.push(e);
  }
  const deltas = [];
  for (const ln of lanes.values()) {
    let open = null;
    for (const e of ln.evs) {
      if (START.has(e.kind)) { if (open == null) open = e.t; }
      else if (e.kind === "rolled_back") {
        const s = open ?? first;
        ln.segs.push({ start: s, end: e.t, ongoing: false }); open = null;
      }
    }
    if (open != null) ln.segs.push({ start: open, end: now, ongoing: true });
    else if (ln.state === "Hybrid" && !ln.segs.some((g) => g.ongoing)) ln.segs.push({ start: first, end: now, ongoing: true });
    ln.segs = ln.segs.filter((g) => g.end > t0 && g.start < t1).map((g) => ({ ...g, start: Math.max(g.start, t0), end: Math.min(g.end, t1) }));
    ln.evs = ln.evs.filter((e) => e.t >= t0);
    for (const g of ln.segs) { deltas.push([g.start, 1]); if (!g.ongoing) deltas.push([g.end, -1]); }
  }
  deltas.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const steps = []; let c = 0;
  for (const [t, d] of deltas) { c += d; steps.push({ t, count: c }); }
  const list = [...lanes.values()].sort(nameCmp);
  return { t0, t1, lanes: list, sys: sys.filter((e) => e.t >= t0), steps,
    max: Math.max(1, ...steps.map((s) => s.count), list.filter((l) => l.state === "Hybrid").length) };
}


// ---- v6: run matrix --------------------------------------------------------
// Groups events into "runs" (a burst of migrations) so the Timeline can be a compact switch x run grid
// instead of a stretched time axis. Rollbacks belong to the run where that switch was migrated.
export const shortDur = (ms) => (ms == null || Number.isNaN(ms) ? "–" : ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + " s" : ms < 3600000 ? Math.round(ms / 60000) + " min" : (ms / 3600000).toFixed(1) + " h");
const SWEV = new Set(["migrated", "adopt", "rolled_back", "migration_failed"]);
export function buildRuns(items, nodes, now, gapMs = 180000) {
  const evs = (items || []).map((i) => ({ ...i, t: tsMs(i.ts) })).filter((i) => i.t != null).sort((a, b) => a.t - b.t);
  const runs = []; let lastSeed = -Infinity;
  for (const e of evs) {
    if (e.kind === "migrated" || e.kind === "adopt" || e.kind === "migration_failed") {
      if (!runs.length || e.t - lastSeed > gapMs) runs.push({ start: e.t, evs: [] });
      lastSeed = e.t; e._run = runs.length - 1;
    }
  }
  if (!runs.length && evs.length) runs.push({ start: evs[0].t, evs: [] });
  const byTime = (t) => { let r = 0; runs.forEach((x, i) => { if (x.start <= t) r = i; }); return r; };
  const lastRun = new Map();
  for (const e of evs) {
    let r;
    if (e._run != null) { r = e._run; if (e.dpid) lastRun.set(e.dpid, r); }
    else if (e.kind === "rolled_back" && e.dpid && lastRun.has(e.dpid)) r = lastRun.get(e.dpid);
    else r = byTime(e.t);
    runs[r].evs.push(e);
  }
  const lanes = new Map();
  for (const n of nodes || []) lanes.set(n.id, { id: n.id, name: n.name, state: n.state });
  for (const e of evs) if (e.dpid && !lanes.has(e.dpid)) lanes.set(e.dpid, { id: e.dpid, name: e.switch || e.dpid.slice(-4), state: "Legacy" });
  const list = [...lanes.values()].sort(nameCmp);
  for (const ln of list) {
    const has = evs.some((e) => e.dpid === ln.id);
    let st = !has && ln.state === "Hybrid"; ln.cells = [];
    for (const run of runs) {
      const mine = run.evs.filter((e) => e.dpid === ln.id), sw = mine.filter((e) => SWEV.has(e.kind));
      const last = sw[sw.length - 1], mig = sw.find((e) => e.kind === "migrated" || e.kind === "adopt");
      let kind = st ? "stay" : "none", hybridMs = null;
      if (last) {
        if (last.kind === "rolled_back") { kind = mig && mig.t < last.t ? "rb2" : "rb"; hybridMs = mig && mig.t < last.t ? last.t - mig.t : null; st = false; }
        else if (last.kind === "migration_failed") kind = "fail";
        else { kind = "up"; st = true; }
      }
      const pick = last || mine[mine.length - 1];
      ln.cells.push({ kind, evs: mine, key: pick ? pick.key : null, hybridMs, note: !!mine.length && !last });
    }
    ln.active = ln.cells.some((c) => c.evs.length);
  }
  runs.forEach((run, i) => {
    run.n = i + 1;
    run.end = run.evs.length ? run.evs[run.evs.length - 1].t : run.start;
    run.mig = run.evs.filter((e) => e.kind === "migrated" || e.kind === "adopt").length;
    run.rb = run.evs.filter((e) => e.kind === "rolled_back").length;
    run.bad = run.evs.filter((e) => /failed|error/.test(e.kind)).length;
    run.other = run.evs.length - run.mig - run.rb - run.bad;
    run.hybrid = list.filter((ln) => ln.cells[i].kind === "up" || ln.cells[i].kind === "stay").length;
  });
  return { runs, lanes: list, max: Math.max(1, ...runs.map((r) => r.hybrid)) };
}

// round-number ticks (…:00, :15, :30 …) in the viewer's local time
export function timeTicks(t0, t1, n = 6) {
  const STEPS = [5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400].map((s) => s * 1000);
  const step = STEPS.find((s) => (t1 - t0) / s <= n + 1) || STEPS[STEPS.length - 1];
  const off = new Date(t0).getTimezoneOffset() * 60000, out = [];
  for (let t = Math.ceil((t0 - off) / step) * step + off; t <= t1; t += step) out.push(t);
  return out;
}
export const clock = (ms, withSec = true) => new Date(ms).toLocaleTimeString([], { hour12: false, hour: "2-digit", minute: "2-digit", ...(withSec ? { second: "2-digit" } : {}) });

// ---- sparkline (no labels; for cards) --------------------------------------
export function sparkSvg(points, h, W = 240, H = 58) {
  const pts = (points || []).filter((p) => p.latency_ms != null);
  if (pts.length < 2) return `<div class="spark-empty">Collecting data…</div>`;
  const lim = h?.limit_ms;
  const ymax = (Math.max(...pts.map((p) => p.latency_ms), lim ?? 0) * 1.12) || 1;
  const X = (i) => 2 + (i * (W - 4)) / (pts.length - 1), Y = (v) => H - 3 - (v / ymax) * (H - 8);
  const line = pts.map((p, i) => `${X(i).toFixed(1)},${Y(p.latency_ms).toFixed(1)}`).join(" ");
  const area = `${X(0).toFixed(1)},${H} ${line} ${X(pts.length - 1).toFixed(1)},${H}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">` +
    (lim != null ? `<line class="sp-limit" x1="0" x2="${W}" y1="${Y(lim).toFixed(1)}" y2="${Y(lim).toFixed(1)}"/>` : "") +
    `<polygon class="sp-area" points="${area}"/><polyline class="sp-line" fill="none" points="${line}"/></svg>`;
}
