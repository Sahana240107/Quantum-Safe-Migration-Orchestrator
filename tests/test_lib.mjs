import assert from "node:assert/strict";
import * as L from "./lib.js";

assert.equal(L.esc('<b>"x"&\'</b>'), "&lt;b&gt;&quot;x&quot;&amp;&#39;&lt;/b&gt;");
assert.equal(L.fmtMs(null), "–"); assert.equal(L.fmtMs(3.567), "3.6 ms"); assert.equal(L.fmtMs(246.3), "246 ms");
assert.equal(L.fmtPct(34.4), "+34%"); assert.equal(L.fmtPct(-5), "-5%"); assert.equal(L.fmtRate(1), "100%");
assert.equal(L.nodeClass({ state: "Legacy" }), "legacy");
assert.equal(L.nodeClass({ state: "Hybrid", health: "healthy" }), "hybrid-ok");
assert.equal(L.nodeClass({ state: "Hybrid", health: "degraded" }), "hybrid-bad");
assert.equal(L.nodeClass({ state: "Hybrid", health: "pending" }), "hybrid-pending");

// diffNodes
const n = (id, state, health) => ({ id, state, health });
const prev = new Map([["a", { state: "Legacy", health: "n/a" }], ["b", { state: "Hybrid", health: "healthy" }],
  ["c", { state: "Hybrid", health: "healthy" }], ["d", { state: "Hybrid", health: "degraded" }]]);
const ev = L.diffNodes(prev, [n("a", "Hybrid", "pending"), n("b", "Legacy", "n/a"), n("c", "Hybrid", "degraded"), n("d", "Hybrid", "healthy")]);
assert.deepEqual(ev.map((e) => e.type), ["migrated", "rolled_back", "degraded", "recovered"]);
assert.deepEqual(L.diffNodes(new Map(), [n("a", "Hybrid", "x")]), []);          // first load: no events

// layout: 15-node tree like the real network (core + 2 aggs + leaves), ring, line, empty, single, disconnected
const mk = (k) => Array.from({ length: k }, (_, i) => ({ id: String(i + 1).padStart(4, "0") }));
const tree = mk(15), te = [];
for (let i = 1; i < 15; i++) te.push({ source: tree[Math.floor((i - 1) / 2)].id, target: tree[i].id });
const cases = { tree: [tree, te], ring: [mk(8), mk(8).map((x, i, a) => ({ source: x.id, target: a[(i + 1) % 8].id }))],
  line: [mk(6), mk(6).slice(1).map((x, i) => ({ source: mk(6)[i].id, target: x.id }))], single: [mk(1), []],
  disconnected: [mk(5), [{ source: "0001", target: "0002" }]], empty: [[], []] };
for (const [name, [nodes, edges]] of Object.entries(cases)) {
  const W = 900, H = 520, p1 = L.layout(nodes, edges, W, H), p2 = L.layout(nodes, edges, W, H);
  assert.equal(p1.size, nodes.length, name + ": every node positioned");
  const seen = new Set();
  for (const nd of nodes) {
    const a = p1.get(nd.id), b = p2.get(nd.id);
    assert.ok(a.x >= 0 && a.x <= W && a.y >= 0 && a.y <= H, name + ": inside canvas");
    assert.deepEqual(a, b, name + ": deterministic");
    const key = Math.round(a.x) + "," + Math.round(a.y);
    assert.ok(!seen.has(key), name + ": no two nodes on the same spot"); seen.add(key);
  }
}
const tp = L.layout(tree, te, 900, 520);                       // root on top, leaves lowest
assert.ok(tp.get("0001").y < tp.get("0002").y && tp.get("0002").y < tp.get("0008").y);

// chart + strikes
assert.match(L.chartSvg([], {}), /Collecting/);
const pts = Array.from({ length: 20 }, (_, i) => ({ t: i, latency_ms: 240 + (i % 3), median_ms: 241 }));
const svg = L.chartSvg(pts, { legacy_mean_ms: 3.5, limit_ms: 10.7 });
assert.match(svg, /<svg/); assert.match(svg, /ln-latency/); assert.match(svg, /limit 10\.7 ms/); assert.ok(!svg.includes("NaN"));
assert.equal(L.strikeHtml(undefined, 3), ""); assert.equal(L.strikeHtml(1, undefined), "");
assert.equal((L.strikeHtml(2, 3).match(/class="strike /g) || []).length, 3);
assert.match(L.strikeHtml(3, 3), /strike full/);
assert.equal(L.kindMeta("rolled_back").cls, "bad"); assert.equal(L.kindMeta("zzz").label, "zzz");

// ---- v5: timeline model, friendly text, report builders
import * as R from "./report.js";
assert.match(L.humanReason("[legacy-compare] median(last 5)=256.446 ms > limit 10.105 ms (Legacy mean=3.368 ms)"), /256 ms.*10\.1 ms.*3\.37 ms/);
assert.equal(L.humanReason("3 strikes"), "3 strikes"); assert.equal(L.fmtDur(812.4), "812 ms"); assert.equal(L.fmtDur(3700), "3.7 s"); assert.equal(L.fmtDur(125000), "2 min 5 s");
const T0 = Date.parse("2026-10-18T14:00:00Z"), iso = (s) => new Date(T0 + s * 1000).toISOString();
const items = [{ key: "L1", ts: iso(0), kind: "migrated", dpid: "a", switch: "s1" }, { key: "L2", ts: iso(30), kind: "migrated", dpid: "b", switch: "s2" },
  { key: "L3", ts: iso(60), kind: "rolled_back", dpid: "b", switch: "s2", recovery_latency_ms: 900 }, { key: "E1", ts: iso(10), kind: "reconcile", dpid: null }];
const M = L.buildTimeline(items, [{ id: "a", name: "s1", state: "Hybrid" }, { id: "b", name: "s2", state: "Legacy" }, { id: "c", name: "s3", state: "Legacy" }], T0 + 90000);
assert.equal(M.lanes.length, 3); assert.equal(M.sys.length, 1);
assert.deepEqual(M.lanes[0].segs.map((g) => g.ongoing), [true]); assert.equal(M.lanes[1].segs.length, 1); assert.equal(M.lanes[1].segs[0].ongoing, false);
assert.equal(M.max, 2); assert.ok(M.t0 < T0 && M.t1 > T0 + 90000);
assert.equal(L.buildTimeline(items, [], T0 + 90000, 20000).lanes.every((l) => l.evs.every((e) => e.t >= T0 + 70000 - 2000)), true);
assert.match(L.sparkSvg([{ latency_ms: 1 }, { latency_ms: 2 }, { latency_ms: 1.5 }], { limit_ms: 3 }), /sp-limit/); assert.match(L.sparkSvg([], {}), /Collecting/);
const rep = { generated_at: T0 / 1000, rollback_rate: 0.25, policy: { legacy_threshold_percent: 200 },
  summary: { switches_total: 5, links: 4, switches_with_history: 3, hybrid_now: 2, rolled_back: 1, never_migrated: 2, avg_change_pct: 55, avg_recovery_ms: 3700, max_recovery_ms: 3700 },
  rows: [{ switch: "s0", dpid: "0", status: "HEALTHY", legacy_ms: 3.1, hybrid_ms: 4.8, change_pct: 54.8, legacy_source: "baseline", hybrid_source: "baseline", recovery_ms: null, rollbacks: 0 },
    { switch: "s1", dpid: "1", status: "ROLLED BACK", legacy_ms: 3.368, hybrid_ms: 256.4, change_pct: 7513, legacy_source: "baseline", hybrid_source: "at rollback", recovery_ms: 3700, rollbacks: 1,
      rollback_reason: "[legacy-compare] median(last 5)=256.446 ms > limit 10.105 ms (Legacy mean=3.368 ms)" }] };
const body = R.reportBody(rep);
for (const nd of ["Migration Report", "3 of 5", "+7,513%", "256 ms", "Rolled back", "No rollback", "rp-chart", "†"]) assert.ok(body.includes(nd), "report body has " + nd);
assert.ok(!/undefined|NaN|null/.test(body), "report body clean");
const doc = R.reportDocument(rep); assert.ok(doc.startsWith("<!doctype html>") && doc.includes("@page") && doc.includes(".rp-doc{"));
const csv = R.reportCsv(rep); assert.equal(csv.split("\r\n").length, 4); assert.ok(csv.includes('"Hybrid stayed too slow')); assert.ok(csv.charCodeAt(0) === 0xfeff);
assert.match(R.reportFileName(rep, "html"), /^qsmo-migration-report-\d{8}-\d{4}\.html$/);
assert.ok(R.reportBody({ rows: [], summary: {} }).includes("No migrations recorded yet"));

// ---- v6: run matrix
{
  const ev = (key, s, kind, dpid, sw) => ({ key, ts: iso(s), kind, dpid, switch: sw });
  const its = [ev("a", 0, "migrated", "a", "s1"), ev("b", 20, "migrated", "b", "s2"), ev("f", 25, "migration_failed", "c", "s3"), ev("sys", 30, "reconcile", null),
    ev("r", 600, "rolled_back", "b", "s2"),                       // rollback of run 1 happens long after run 2 started
    ev("d", 1000, "migrated", "b", "s2"), ev("e", 1010, "migrated", "d", "s4")];
  const nodes = [{ id: "a", name: "s1", state: "Hybrid" }, { id: "b", name: "s2", state: "Hybrid" }, { id: "c", name: "s3", state: "Legacy" }, { id: "d", name: "s4", state: "Hybrid" }, { id: "z", name: "s5", state: "Legacy" }];
  const R2 = L.buildRuns(its, nodes, T0 + 1100000);
  assert.equal(R2.runs.length, 2, "two bursts -> two runs");
  assert.deepEqual(R2.runs.map((r) => [r.mig, r.rb, r.bad]), [[2, 1, 1], [2, 0, 0]]);
  const k = (n) => R2.lanes.find((l) => l.name === n).cells.map((c) => c.kind);
  assert.deepEqual(k("s1"), ["up", "stay"]); assert.deepEqual(k("s2"), ["rb2", "up"]); assert.deepEqual(k("s3"), ["fail", "none"]);
  assert.deepEqual(k("s4"), ["none", "up"]); assert.deepEqual(k("s5"), ["none", "none"]); assert.equal(R2.lanes.find((l) => l.name === "s2").cells[0].hybridMs, 580000);
  assert.equal(R2.runs[0].evs.some((e) => e.key === "sys"), true); assert.equal(R2.runs[1].hybrid, 3); assert.equal(R2.runs[0].hybrid, 1);
  assert.equal(L.buildRuns([], nodes, T0).runs.length, 0); assert.equal(L.shortDur(45000), "45 s"); assert.equal(L.shortDur(720000), "12 min");
  assert.deepEqual(L.buildRuns([], [{ id: "q", name: "s9", state: "Hybrid" }], T0).lanes[0].cells, []);
}
console.log("lib tests passed");
