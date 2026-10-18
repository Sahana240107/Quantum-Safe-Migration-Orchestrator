// Runs the REAL app.js against the REAL API (dev_server) with a stub DOM. No browser needed.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const els = {};
const el = (id) => (els[id] ??= { id, innerHTML: "", value: "", classList: { toggle() {} }, addEventListener() {} });
globalThis.document = { getElementById: el, querySelectorAll: () => [], addEventListener() {}, visibilityState: "visible" };
globalThis.window = { addEventListener() {} };
globalThis.location = { hash: "" };
globalThis.QSMO_BASE = process.env.BASE;
globalThis.QSMO_NO_AUTOSTART = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = (id = "view") => els[id].innerHTML;
const mutate = (c) => execFileSync("python3", ["tests/mutate.py", c], { env: process.env });

const { S, tick, setPage, setApiBase } = await import("./app.js");

// ---- 1. every page renders from live API data -----------------------------------
await tick();
assert.equal(S.err, null, "API reachable: " + S.err);
assert.match(html("banner"), /LIVE/);
const want = { dashboard: ["Switches", "Latest events", "Hybrid"], topology: ["<svg", "node hybrid-ok", "Click a switch"],
  switches: ["<table", "s1", "Legacy"], timeline: ["<table", "Migrated to Hybrid", "Migration runs", "Run 1", "s1"], monitoring: ["Monitor policy", "Hybrid switches monitored", "mcard", "s2"],
  report: ["<table", "Healthy", "s5", "Migration Report", "Download report"] };
for (const [page, needles] of Object.entries(want)) {
  setPage(page); await tick();
  assert.equal(S.err, null, page + ": " + S.err);
  for (const nd of needles) assert.ok(html().includes(nd), `${page} page should contain "${nd}"`);
  if (page === "report") assert.ok(!html().includes("Not measured"), "report must not show blank Legacy/Hybrid/Change values");
  assert.ok(!/undefined|NaN|\[object/.test(html()), page + " page has undefined/NaN/[object]");
}

// ---- 2. select a switch: panel + chart from the API's latency history ------------
setPage("topology"); S.sel = "0000000000000003";
await sleep(3500); await tick(); await tick();
assert.ok(html().includes("s2") && html().includes("Legacy baseline"), "panel shows details");
assert.ok(html().includes("ln-latency"), "chart drawn from /history");
assert.ok(html().includes("limit "), "limit line labelled");
assert.ok(/class="strike/.test(html()), "strike meter shown (policy + degraded_count present)");

// ---- 3. degrade, then roll back, while polling ----------------------------------
mutate("degrade"); await tick();
assert.ok(html().includes("2/3"), "strike meter shows 2/3");
assert.ok(S.toasts.some((t) => /degraded/.test(t.text)), "toast: degraded");
assert.match(html(), /hybrid-bad/);
await sleep(30); mutate("rollback"); await tick();
assert.equal(S.flash.get("0000000000000003")?.type, "rolled_back", "node flashes after rollback");
assert.ok(html().includes("f-rolled_back"), "flash class rendered");
assert.ok(S.toasts.some((t) => /Rolled back/.test(t.text) && /812/.test(t.text)), "toast: rolled back with recovery time");
setPage("timeline"); await tick();
assert.ok(html().includes("Rolled back to Legacy"), "timeline legend / graph present");
const rbEv = S.timeline.filter((i) => i.kind === "rolled_back").pop();
assert.ok(rbEv, "rollback event loaded");
S.tsel = rbEv.key; await tick();                                    // click a marker -> detail panel
assert.ok(html().includes("812 ms") && html().includes("What happened") && html().includes("Inspect switch"), "event detail shows recovery");
S.tsel = null; S.tview = "list"; await tick();
assert.ok(html().includes("recovery 812 ms"), "list view shows the rollback");
S.tview = "graph";
setPage("report"); await tick();
assert.ok(html().includes("Rolled back") && html().includes("812 ms"), "report row: Rolled back + recovery");
assert.ok(!html().includes("Not measured"), "rolled-back row still has numbers");
S.mexp.add("0000000000000002"); setPage("monitoring"); await tick();
assert.ok(html().includes("mdetail"), "monitor card expands on click");
setPage("switches"); await tick();
assert.ok(html().includes("s2") && html().includes("badge legacy"));

// ---- 4. outage handling: API unreachable -> red banner, last data stays on screen ----
setPage("switches"); await tick();
const before = html();
setApiBase("http://127.0.0.1:9");                      // nothing listens here
await tick();
assert.ok(S.err, "error recorded");
assert.match(html("banner"), /Cannot reach the console API/);
assert.equal(html(), before, "last good data stays visible");
console.log("frontend harness passed");
