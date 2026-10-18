// report.js -- builds the Migration Report (on-screen AND the downloadable file from the same code).
// Pure functions, no DOM: unit-tested in tests/test_lib.mjs.
import { esc, fmtMs2, fmtPct2, fmtDur, humanReason } from "./lib.js";

const STATUS = {
  HEALTHY: ["good", "Healthy"], DEGRADED: ["warn", "Degraded"], "ROLLED BACK": ["bad", "Rolled back"],
  LEGACY: ["muted", "Legacy"], MEASURING: ["info", "Measuring"],
};
const SRC_NOTE = {
  "at rollback": ["†", "Latency that triggered the rollback (the Hybrid baseline is deleted when a switch is rolled back)."],
  remembered: ["‡", "Last Legacy-vs-Hybrid measurement seen by the console before the baseline was cleared."],
  "migration check": ["§", "Single latency check taken during the migration itself; the monitor's full baseline was not available."],
};

const when = (ms) => new Date(ms).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const fileStamp = (ms) => { const d = new Date(ms), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };
export const reportFileName = (r, ext) => `qsmo-migration-report-${fileStamp((r.generated_at || Date.now() / 1000) * 1000)}.${ext}`;

const limitPct = (r) => Number(r?.policy?.legacy_threshold_percent ?? 200);

function changeCell(row, lim) {
  if (row.change_pct == null) return `<span class="rp-na">Not measured</span>`;
  const cls = row.change_pct > lim ? "bad" : row.change_pct > lim / 2 ? "warn" : "good";
  return `<span class="rp-pill ${cls}">${esc(fmtPct2(row.change_pct))}</span>`;
}
function valueCell(ms, src) {
  if (ms == null) return `<span class="rp-na">Not measured</span>`;
  const n = SRC_NOTE[src];
  return `<span class="rp-num">${esc(fmtMs2(ms))}</span>${n ? `<sup title="${esc(n[1])}">${n[0]}</sup>` : ""}`;
}
function noteFor(row) {
  if (row.status === "ROLLED BACK") return esc(humanReason(row.rollback_reason) || "Rolled back to Legacy.");
  if (row.status === "DEGRADED") return "Currently degraded – the monitor is counting bad readings.";
  if (row.status === "MEASURING") return "Hybrid baseline is still being measured.";
  if (row.rollbacks > 0) return `Re-migrated after ${row.rollbacks} earlier rollback${row.rollbacks > 1 ? "s" : ""}.`;
  return "";
}

// ---- Legacy vs Hybrid, paired bars on a LOG scale (a 3 ms and a 256 ms switch must both stay readable)
export function reportChart(rows) {
  const data = rows.filter((x) => x.legacy_ms > 0 && x.hybrid_ms > 0);
  if (!data.length) return `<div class="rp-na">No latency measurements yet.</div>`;
  const all = data.flatMap((x) => [x.legacy_ms, x.hybrid_ms]);
  const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...all)) - 0.0001)), hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...all)) + 0.0001));
  const W = 760, L = 54, R = 70, rh = 30, top = 22, H = top + data.length * rh + 8;
  const X = (v) => L + ((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (W - L - R);
  let ticks = "";
  for (let v = lo; v <= hi * 1.0001; v *= 10) {
    ticks += `<line class="rp-grid" x1="${X(v).toFixed(1)}" x2="${X(v).toFixed(1)}" y1="${top - 6}" y2="${H - 6}"/>` +
      `<text class="rp-tick" x="${X(v).toFixed(1)}" y="12" text-anchor="middle">${v >= 1 ? v : v.toFixed(1)} ms</text>`;
  }
  const colour = { HEALTHY: "#16a34a", DEGRADED: "#d97706", "ROLLED BACK": "#dc2626", MEASURING: "#0d9488", LEGACY: "#64748b" };
  const bars = data.map((x, i) => {
    const y = top + i * rh, c = colour[x.status] || "#16a34a";
    return `<text class="rp-lab" x="${L - 8}" y="${y + 17}" text-anchor="end">${esc(x.switch)}</text>` +
      `<rect x="${L}" y="${y + 3}" width="${Math.max(2, X(x.legacy_ms) - L).toFixed(1)}" height="9" rx="2" fill="#94a3b8"/>` +
      `<text class="rp-val" x="${(X(x.legacy_ms) + 5).toFixed(1)}" y="${y + 11.5}">${esc(fmtMs2(x.legacy_ms))}</text>` +
      `<rect x="${L}" y="${y + 14}" width="${Math.max(2, X(x.hybrid_ms) - L).toFixed(1)}" height="9" rx="2" fill="${c}"/>` +
      `<text class="rp-val" x="${(X(x.hybrid_ms) + 5).toFixed(1)}" y="${y + 22.5}">${esc(fmtMs2(x.hybrid_ms))}</text>`;
  }).join("");
  return `<svg class="rp-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Legacy versus Hybrid latency per switch">${ticks}${bars}</svg>` +
    `<div class="rp-legend"><span><i style="background:#94a3b8"></i>Legacy</span><span><i style="background:#16a34a"></i>Hybrid (healthy)</span>` +
    `<span><i style="background:#dc2626"></i>Hybrid (rolled back)</span><span class="rp-muted">Logarithmic scale</span></div>`;
}

function findings(r) {
  const s = r.summary || {}, rows = r.rows || [], out = [];
  out.push(`<b>${s.switches_with_history ?? rows.length} of ${s.switches_total ?? rows.length} switches</b> have been through a migration; ` +
    `<b>${s.hybrid_now ?? 0}</b> currently run Hybrid` + (s.never_migrated ? ` and ${s.never_migrated} have not been migrated yet.` : "."));
  const rb = rows.filter((x) => x.status === "ROLLED BACK");
  if (rb.length) out.push(`<b>${rb.length} switch${rb.length > 1 ? "es were" : " was"} rolled back</b> to Legacy (${rb.map((x) => esc(x.switch)).join(", ")}) ` +
    `because Hybrid latency exceeded the policy limit. Overall rollback rate: <b>${Math.round((r.rollback_rate || 0) * 100)}%</b> of migration attempts.`);
  else out.push(`No switch has been rolled back. Rollback rate: <b>0%</b>.`);
  if (s.avg_change_pct != null) out.push(`On switches still running Hybrid, latency is on average <b>${esc(fmtPct2(s.avg_change_pct))}</b> versus Legacy.`);
  if (s.avg_recovery_ms != null) out.push(`When a rollback happened, Legacy service was restored in <b>${esc(fmtDur(s.avg_recovery_ms))}</b> on average (slowest: ${esc(fmtDur(s.max_recovery_ms))}).`);
  const dg = rows.filter((x) => x.status === "DEGRADED");
  if (dg.length) out.push(`<b>Attention:</b> ${dg.map((x) => esc(x.switch)).join(", ")} ${dg.length > 1 ? "are" : "is"} degraded right now.`);
  return out.map((t) => `<li>${t}</li>`).join("");
}

const kpi = (v, l, cls = "") => `<div class="rp-kpi ${cls}"><div class="rp-kv">${v}</div><div class="rp-kl">${l}</div></div>`;

// rows: rows to show in the table (the screen may filter them); the summary always uses the full report
export function reportBody(r, rows = r.rows || []) {
  const s = r.summary || {}, lim = limitPct(r), gen = (r.generated_at || Date.now() / 1000) * 1000;
  const trs = rows.map((x) => {
    const [cls, label] = STATUS[x.status] || ["muted", x.status];
    return `<tr class="${x.status === "ROLLED BACK" ? "rp-row-bad" : x.status === "DEGRADED" ? "rp-row-warn" : ""}">` +
      `<td><b>${esc(x.switch)}</b></td><td><span class="rp-pill ${cls}">${esc(label)}</span></td>` +
      `<td>${valueCell(x.legacy_ms, x.legacy_source)}</td><td>${valueCell(x.hybrid_ms, x.hybrid_source)}</td><td>${changeCell(x, lim)}</td>` +
      `<td>${x.recovery_ms ? `<span class="rp-num">${esc(fmtDur(x.recovery_ms))}</span>` : `<span class="rp-na">No rollback</span>`}</td>` +
      `<td class="rp-notes">${noteFor(x)}</td></tr>`;
  }).join("");
  const used = new Set(rows.flatMap((x) => [x.legacy_source, x.hybrid_source]).filter((k) => SRC_NOTE[k]));
  const notes = [...used].map((k) => `<li><b>${SRC_NOTE[k][0]}</b> ${esc(SRC_NOTE[k][1])}</li>`).join("");
  return `<div class="rp-doc">
<header class="rp-head"><div><div class="rp-eyebrow">QSMO · Quantum-Safe Migration Orchestrator</div><h1>Migration Report</h1>
<div class="rp-sub">Legacy → Hybrid (post-quantum) results for the live network</div></div>
<dl class="rp-meta"><dt>Generated</dt><dd>${esc(when(gen))}</dd><dt>Network</dt><dd>${s.switches_total ?? "–"} switches · ${s.links ?? "–"} links</dd></dl></header>
<section class="rp-kpis">${kpi(`${s.switches_with_history ?? 0}<small> / ${s.switches_total ?? 0}</small>`, "Switches migrated")}
${kpi(s.hybrid_now ?? 0, "Running Hybrid now", "good")}${kpi(s.rolled_back ?? 0, "Rolled back", s.rolled_back ? "bad" : "")}
${kpi(Math.round((r.rollback_rate || 0) * 100) + "%", "Rollback rate", r.rollback_rate > 0.25 ? "bad" : "")}
${kpi(s.avg_change_pct != null ? esc(fmtPct2(s.avg_change_pct)) : "–", "Avg latency change (Hybrid)")}
${kpi(s.avg_recovery_ms != null ? esc(fmtDur(s.avg_recovery_ms)) : "–", "Avg rollback recovery")}</section>
<section><h2>Summary</h2><ul class="rp-find">${findings(r)}</ul></section>
<section class="rp-avoid"><h2>Latency: Legacy vs Hybrid</h2>${reportChart(rows)}</section>
<section class="rp-details"><h2>Switch details</h2>${rows.length ? `<table class="rp-table"><thead><tr><th>Switch</th><th>Status</th><th>Legacy</th><th>Hybrid</th><th>Change</th><th>Last recovery</th><th>Notes</th></tr></thead><tbody>${trs}</tbody></table>`
    : `<div class="rp-na">No migrations recorded yet.</div>`}
<ul class="rp-foot">${notes}<li>Legacy and Hybrid are mean Echo round-trip times measured by the monitor. Change = (Hybrid − Legacy) ÷ Legacy; amber/red marks changes above ${lim / 2}% / ${lim}% (the Legacy-compare limit).
Recovery = time to reconnect the switch to its Legacy controller after a rollback.</li></ul></section>
<footer class="rp-end">Generated by QSMO Live Console · ${esc(when(gen))}</footer></div>`;
}

export const REPORT_CSS = `
.rp-doc{--ink:#0f172a;--mut:#64748b;--line:#e2e8f0;--ok:#16a34a;--bad:#dc2626;--warn:#d97706;--info:#2563eb;background:#fff;color:var(--ink);font:13.5px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
 -webkit-print-color-adjust:exact;print-color-adjust:exact}
.rp-doc *{box-sizing:border-box}
.rp-head{display:flex;justify-content:space-between;gap:20px;flex-wrap:wrap;padding-bottom:16px;border-bottom:3px solid var(--info);margin-bottom:18px}
.rp-eyebrow{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--info)}
.rp-doc h1{margin:2px 0 2px;font-size:28px;letter-spacing:-.01em}.rp-sub{color:var(--mut)}
.rp-meta{margin:0;display:grid;grid-template-columns:auto auto;gap:2px 12px;font-size:12px;align-content:start}.rp-meta dt{color:var(--mut)}.rp-meta dd{margin:0;font-weight:600;text-align:right}
.rp-doc h2{font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--mut);margin:22px 0 8px;padding-bottom:5px;border-bottom:1px solid var(--line)}
.rp-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px}
.rp-kpi{border:1px solid var(--line);border-top:3px solid var(--info);border-radius:8px;padding:10px 12px;background:#f8fafc}
.rp-kpi.good{border-top-color:var(--ok)}.rp-kpi.bad{border-top-color:var(--bad)}
.rp-kv{font-size:24px;font-weight:800;line-height:1.1}.rp-kv small{font-size:13px;color:var(--mut);font-weight:600}.rp-kl{font-size:11.5px;color:var(--mut);margin-top:3px}
.rp-find{margin:0;padding-left:20px}.rp-find li{margin:4px 0}
.rp-table{width:100%;border-collapse:collapse;font-size:13px}
.rp-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);background:#f1f5f9;padding:8px 10px;border-bottom:2px solid var(--line)}
.rp-table th,.rp-table td{white-space:normal}.rp-table td{padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.rp-table tr{break-inside:avoid;page-break-inside:avoid}
.rp-row-bad td{background:#fff5f5}.rp-row-warn td{background:#fffbeb}
.rp-num{font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap}.rp-na{color:#94a3b8;font-style:italic;white-space:nowrap}.rp-muted{color:var(--mut)}
.rp-notes{color:#334155;font-size:12.5px;min-width:240px;max-width:380px}
.rp-pill{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid transparent;font-variant-numeric:tabular-nums;white-space:nowrap}
.rp-pill.good{background:#dcfce7;color:#166534;border-color:#86efac}.rp-pill.warn{background:#fef3c7;color:#92400e;border-color:#fcd34d}
.rp-pill.bad{background:#fee2e2;color:#991b1b;border-color:#fca5a5}.rp-pill.info{background:#dbeafe;color:#1e40af;border-color:#93c5fd}
.rp-pill.muted{background:#e2e8f0;color:#334155;border-color:#cbd5e1}
.rp-chart{width:100%;max-width:860px;height:auto;display:block}.rp-grid{stroke:#e2e8f0;stroke-width:1}.rp-tick{font-size:10px;fill:#64748b}
.rp-lab{font-size:12px;font-weight:700;fill:#0f172a}.rp-val{font-size:10.5px;fill:#475569}
.rp-legend{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:#334155;margin-top:4px}.rp-legend i{display:inline-block;width:11px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.rp-foot{margin:10px 0 0;padding-left:18px;color:var(--mut);font-size:11.5px}
.rp-end{margin-top:26px;padding-top:10px;border-top:1px solid var(--line);color:#94a3b8;font-size:11px;text-align:center}
.rp-doc h2{break-after:avoid}
@media print{.rp-kpis{grid-template-columns:repeat(6,1fr);gap:8px}.rp-kv{font-size:19px}.rp-kl{font-size:10.5px}.rp-details{break-before:page}}
sup{color:var(--info);font-weight:700;margin-left:1px}
`;

export function reportDocument(r) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>QSMO Migration Report</title><style>html,body{margin:0;background:#eef2f7}body{padding:24px}
.rp-doc{max-width:980px;margin:0 auto;padding:36px 40px;border-radius:6px;box-shadow:0 2px 14px rgba(15,23,42,.12)}
@page{size:A4;margin:14mm}@media print{html,body{background:#fff}body{padding:0}.rp-doc{box-shadow:none;padding:0;max-width:none}.rp-avoid{break-inside:avoid}}
${REPORT_CSS}</style></head><body>${reportBody(r)}</body></html>`;
}

const csvCell = (v) => { const t = v == null ? "" : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export function reportCsv(r) {
  const head = ["Switch", "DPID", "Status", "Legacy mean (ms)", "Hybrid mean (ms)", "Change (%)", "Legacy source", "Hybrid source",
    "Last recovery (ms)", "Migrations", "Rollbacks", "Migrated at", "Last rollback at", "Notes"];
  const lines = [head.join(",")];
  for (const x of r.rows || []) {
    lines.push([x.switch, x.dpid, x.status, x.legacy_ms, x.hybrid_ms, x.change_pct, x.legacy_source, x.hybrid_source, x.recovery_ms,
      x.migrations, x.rollbacks, x.migrated_at, x.rolled_back_at, humanReason(x.rollback_reason)].map(csvCell).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}
