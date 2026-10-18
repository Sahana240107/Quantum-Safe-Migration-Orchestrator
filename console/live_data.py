"""
console/live_data.py -- READ-ONLY view of the real QSMO runtime for the console API.

Sources (all written by the other QSMO programs, never by this module):
    runtime/qsmo.db              SQLite: switches, ledger, baselines, events, kv   (migration/store.py)
    runtime/topology.json        live switch graph, republished by the controller every ~5 s
    runtime/monitor_status.json  monitor heartbeat + per-switch health, every poll

Pure standard library + migration.store. Never raises on missing / half-written files:
it returns an 'offline' answer instead, so the UI can show a banner.
"""
from __future__ import annotations

import contextlib
import functools
import json
import os
import re
import sqlite3
import threading
import time
from collections import deque

from migration.store import Store, norm_dpid, runtime_dir

HEARTBEAT_MAX_AGE_S = 20.0      # same limit run_migration.py uses
TOPOLOGY_MAX_AGE_S = 20.0       # same limit monitor_service.py uses
HISTORY_LEN = 600               # latency samples kept per switch

_store: Store | None = None
_history: dict[str, deque] = {}
_hist_lock = threading.Lock()
_last_hb = None


class _ReadOnlyStore(Store):
    """The console must never disturb the controller/monitor: it opens qsmo.db READ-ONLY (no schema
    writes, no WAL checkpoint, short busy timeout) instead of the read/write connection Store uses."""

    def _ensure_schema(self):
        pass

    @contextlib.contextmanager
    def _conn(self):
        con = sqlite3.connect("file:%s?mode=ro" % self.path, uri=True, timeout=2)
        con.row_factory = sqlite3.Row
        try:
            yield con
        finally:
            con.close()


def store() -> Store:
    global _store
    if _store is None or _store.runtime != runtime_dir():
        probe = os.path.join(runtime_dir(), "qsmo.db")
        # no DB yet (nothing has run) -> normal Store creates it; afterwards we only ever read
        _store = _ReadOnlyStore() if os.path.exists(probe) else Store()
    return _store


CACHE_S = float(os.environ.get("QSMO_CACHE_S", "1.0"))      # many API calls/sec -> one DB read/sec


def _cached(fn):
    box = {"t": 0.0, "v": None, "key": None}
    lock = threading.Lock()

    @functools.wraps(fn)
    def wrapper(*a, **k):
        key = (a, tuple(sorted(k.items())), runtime_dir())
        with lock:
            if CACHE_S > 0 and box["key"] == key and time.monotonic() - box["t"] < CACHE_S:
                return box["v"]
        v = fn(*a, **k)
        with lock:
            box.update(t=time.monotonic(), v=v, key=key)
        return v
    return wrapper


def _read_json(name: str):
    try:
        with open(os.path.join(store().runtime, name), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _num(x, nd=3):
    return round(float(x), nd) if isinstance(x, (int, float)) else None


# ---------------------------------------------------------------- status
def status() -> dict:
    hb = _read_json("monitor_status.json")
    topo = _read_json("topology.json")
    now = time.time()
    hb_age = (now - hb["heartbeat"]) if hb and "heartbeat" in hb else None
    topo_age = (now - topo["updated"]) if topo and "updated" in topo else None
    monitor_up = hb_age is not None and hb_age <= HEARTBEAT_MAX_AGE_S
    controller_up = bool(hb and hb.get("controller_up")) and monitor_up
    topo_fresh = topo_age is not None and topo_age <= TOPOLOGY_MAX_AGE_S
    if not monitor_up and not topo_fresh:
        state, msg = "offline", "Nothing is running. Start ./run_network.sh, ./run_controller.sh, ./run_monitor.sh"
    elif not topo_fresh:
        state, msg = "controller_down", "Controller is not publishing a topology (./run_controller.sh)"
    elif not monitor_up:
        state, msg = "monitor_down", "Monitor is not running (./run_monitor.sh). Data may be stale"
    elif not controller_up:
        state, msg = "controller_down", "Monitor is waiting for the controller"
    else:
        state, msg = "running", "All components running"
    states = store().states()
    nodes = (topo or {}).get("nodes", [])
    total = len(nodes) or len(states)
    hybrid = sum(1 for s in states.values() if s == "Hybrid")
    health = (hb or {}).get("switches", {})
    degraded = sum(1 for v in health.values() if v.get("status") == "degraded")
    return {
        "state": state, "message": msg, "online": state == "running",
        "monitor": {"up": monitor_up, "age_s": _num(hb_age, 1), "pid": (hb or {}).get("pid")},
        "controller": {"up": controller_up, "topology_age_s": _num(topo_age, 1)},
        "counts": {"switches": total, "links": len((topo or {}).get("edges", [])),
                   "hybrid": hybrid, "legacy": total - hybrid, "degraded": degraded},
        "rollback_rate": rollback_rate(),
        "server_time": now,
    }


# ---------------------------------------------------------------- topology
@_cached
def _baseline_maps():
    s = store()
    return s.load_baselines("legacy"), s.load_baselines("hybrid")


def topology() -> dict:
    topo = _read_json("topology.json") or {"nodes": [], "edges": [], "updated": None}
    hb = _read_json("monitor_status.json") or {}
    health = hb.get("switches", {})
    rows = store().all_switches()
    leg, hyb = _baseline_maps()
    nodes = []
    for n in topo["nodes"]:
        d = norm_dpid(n["dpid"])
        r, h = rows.get(d, {}), health.get(d, {})
        st = r.get("state", "Legacy")
        cmp_ = (hyb.get(d) or {}).get("legacy_comparison") or {}
        nodes.append({
            "id": d, "name": n.get("name") or r.get("name") or d[-4:], "state": st,
            "hybrid_port": r.get("hybrid_port"),
            "health": (h.get("status") or ("pending" if st == "Hybrid" else "n/a")),
            "latency_ms": _num(h.get("latency_ms")), "rolling_median_ms": _num(h.get("rolling_median_ms")),
            "success_rate": _num(h.get("success_rate")),
            "degraded_count": h.get("degraded_count", 0),
            "legacy_baseline_ms": _num((leg.get(d) or {}).get("mean_ms")),
            "hybrid_baseline_ms": _num((hyb.get(d) or {}).get("mean_ms")),
            "change_pct": _num(cmp_.get("percent_change"), 1),
            "updated": r.get("updated"),
        })
    state = {n["id"]: n["state"] for n in nodes}
    edges = []
    for a, b in topo["edges"]:
        a, b = norm_dpid(a), norm_dpid(b)
        edges.append({"source": a, "target": b,
                      "protected": state.get(a) == "Hybrid" and state.get(b) == "Hybrid"})
    return {"nodes": nodes, "edges": edges, "updated": topo.get("updated")}


# ---------------------------------------------------------------- timeline / ledger
@_cached
def _ledger_with_ids(limit=2000):
    with store()._conn() as con:
        return [dict(r) for r in con.execute("SELECT * FROM ledger ORDER BY id DESC LIMIT ?", (limit,))][::-1]


def ledger() -> dict:
    items = []
    for r in _ledger_with_ids():
        items.append({"id": r["id"], "dpid": r["dpid"], "timestamp": r["ts"], "outcome": r["outcome"],
                      "reason": r["reason"], "recovery_latency_ms": _num(r["recovery_latency_ms"], 1),
                      "flows": json.loads(r["flows"] or "[]")})
    return {"items": items, "rollback_rate": rollback_rate()}


def rollback_rate() -> float:
    rel = [r for r in _ledger_with_ids() if r["outcome"] in ("success", "reverted")]
    return round(sum(r["outcome"] == "reverted" for r in rel) / len(rel), 3) if rel else 0.0


@_cached
def _names():
    return {d: (r.get("name") or d[-4:]) for d, r in store().all_switches().items()}


def timeline(since: str | None = None, limit: int = 200) -> dict:
    """Ledger rows + events merged, oldest->newest. Pass the last `ts` you got as `since`."""
    names, items = _names(), []
    for r in _ledger_with_ids():
        kind = {"success": "migrated", "failed": "migration_failed", "reverted": "rolled_back"}[r["outcome"]]
        items.append({"key": f"L{r['id']}", "ts": r["ts"], "kind": kind, "source": "ledger", "dpid": r["dpid"],
                      "switch": names.get(r["dpid"], r["dpid"][-4:]), "message": r["reason"] or r["outcome"],
                      "recovery_latency_ms": _num(r["recovery_latency_ms"], 1), "outcome": r["outcome"],
                      "flows": json.loads(r["flows"] or "[]"),
                      "before_ms": _num(_f(_json(r["baseline"]).get("latency_ms"))),
                      "after_ms": _num(_f(_json(r["post"]).get("latency_ms")))})
    with store()._conn() as con:
        for r in con.execute("SELECT * FROM events ORDER BY id DESC LIMIT 500"):
            items.append({"key": f"E{r['id']}", "ts": r["ts"], "kind": r["kind"], "source": r["source"],
                          "dpid": r["dpid"], "switch": names.get(r["dpid"]) if r["dpid"] else None,
                          "message": r["message"], "recovery_latency_ms": None})
    items.sort(key=lambda x: x["ts"])
    if since:
        items = [i for i in items if i["ts"] > since]
    items = items[-limit:]
    return {"items": items, "last_ts": items[-1]["ts"] if items else since}


# ---------------------------------------------------------------- monitoring
def monitoring() -> dict:
    hb = _read_json("monitor_status.json") or {}
    names = _names()
    items = []
    for d, v in (hb.get("switches") or {}).items():
        if v.get("state") != "Hybrid":
            continue
        items.append({"dpid": d, "switch": names.get(d, d[-4:]), **v})
    items.sort(key=lambda x: x["switch"])
    return {"policy": hb.get("policy", {}), "heartbeat": hb.get("heartbeat"),
            "controller_up": hb.get("controller_up", False), "items": items}



# ---------------------------------------------------------------- comparison memory
# The monitor DELETES a switch's Hybrid baseline when it rolls the switch back, so a rolled-back
# switch would lose its Legacy-vs-Hybrid numbers. The console remembers the last comparison it saw
# (in memory + a small console-owned file next to qsmo.db) so the Report can still show them.
_cmp_cache: dict = {}
_cmp_loaded = None


def _cache_path():
    return os.path.join(store().runtime, "console_cache.json")


def _load_cache():
    global _cmp_loaded
    rt = store().runtime
    if _cmp_loaded == rt:
        return
    _cmp_loaded = rt
    try:
        with open(_cache_path(), encoding="utf-8") as fh:
            _cmp_cache.update(json.load(fh))
    except (OSError, ValueError):
        pass


def _remember_comparisons():
    _load_cache()
    leg, hyb = store().load_baselines("legacy"), store().load_baselines("hybrid")
    changed = False
    for d, h in hyb.items():
        lm, hm = (leg.get(d) or {}).get("mean_ms"), h.get("mean_ms")
        c = h.get("legacy_comparison") or {}
        lm = c.get("legacy_mean_ms", lm)
        hm = c.get("hybrid_mean_ms", hm)
        if lm is None or hm is None:
            continue
        new = {"legacy_ms": float(lm), "hybrid_ms": float(hm)}
        if _cmp_cache.get(d, {}).get("hybrid_ms") != new["hybrid_ms"] or _cmp_cache.get(d, {}).get("legacy_ms") != new["legacy_ms"]:
            _cmp_cache[d] = {**new, "seen": time.time()}
            changed = True
    if changed:
        try:
            tmp = _cache_path() + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(_cmp_cache, fh)
            os.replace(tmp, _cache_path())
            os.chmod(_cache_path(), 0o666)
        except OSError:
            pass            # read-only runtime: the in-memory copy still works


# The monitor only writes the LATEST value, so the API keeps its own ring buffer for charts.
def sample() -> bool:
    """Append the monitor's latest per-switch values to the history. Call about once a second."""
    global _last_hb
    try:
        _remember_comparisons()
    except Exception:
        pass
    hb = _read_json("monitor_status.json")
    if not hb or hb.get("heartbeat") == _last_hb:
        return False
    _last_hb = hb.get("heartbeat")
    with _hist_lock:
        for d, v in (hb.get("switches") or {}).items():
            if v.get("state") != "Hybrid":
                continue
            _history.setdefault(d, deque(maxlen=HISTORY_LEN)).append({
                "t": hb["heartbeat"], "latency_ms": _num(v.get("latency_ms")),
                "median_ms": _num(v.get("rolling_median_ms")), "status": v.get("status")})
    return True


POLICY_DEFAULTS = {            # MonitorConfig defaults (migration/monitor.py); used only if the
    "rolling_window": 5, "sigma_multiplier": 3.0, "min_latency_threshold_ms": 1.0,   # monitor did not
    "degradation_threshold_percent": 50.0, "legacy_threshold_percent": 200.0,         # publish its policy
    "legacy_threshold_floor_ms": 5.0,
}


def _limits(d: str):
    """The two limits monitor.py checks. A switch is 'degraded' when the rolling median passes EITHER,
    so the effective limit is the lower one."""
    hb = _read_json("monitor_status.json") or {}
    pol_pub = hb.get("policy") or {}
    pol = {**POLICY_DEFAULTS, **pol_pub}
    leg, hyb = _baseline_maps()
    L, H = leg.get(d) or {}, hyb.get(d) or {}
    hybrid_limit = legacy_limit = None
    if H.get("median_ms") is not None:
        base = float(H["median_ms"])
        margin = max(pol["sigma_multiplier"] * float(H.get("stddev_ms") or 0.0),
                     pol["min_latency_threshold_ms"], base * pol["degradation_threshold_percent"] / 100.0)
        hybrid_limit = base + margin
    if L.get("mean_ms") is not None:
        m = float(L["mean_ms"])
        legacy_limit = m + max(m * pol["legacy_threshold_percent"] / 100.0, pol["legacy_threshold_floor_ms"])
    cands = [x for x in (hybrid_limit, legacy_limit) if x is not None]
    return {"hybrid_limit_ms": _num(hybrid_limit), "legacy_limit_ms": _num(legacy_limit),
            "limit_ms": _num(min(cands)) if cands else None, "limits_estimated": not pol_pub}


def history(dpid: str, limit: int = 300) -> dict:
    d = norm_dpid(dpid)
    with _hist_lock:
        pts = list(_history.get(d, []))[-limit:]
    leg, hyb = _baseline_maps()
    return {"dpid": d, "points": pts,
            "legacy_mean_ms": _num((leg.get(d) or {}).get("mean_ms")),
            "hybrid_mean_ms": _num((hyb.get(d) or {}).get("mean_ms")),
            **_limits(d)}


def start_sampler(interval=1.0):
    def loop():
        while True:
            try:
                sample()
            except Exception:
                pass
            time.sleep(interval)
    threading.Thread(target=loop, name="qsmo-live-sampler", daemon=True).start()


# ---------------------------------------------------------------- report
_ROLLBACK_RE = re.compile(r"median\(last\s*\d+\)\s*=\s*([\d.]+)\s*ms.*?Legacy mean\s*=\s*([\d.]+)\s*ms", re.I | re.S)


def _json(x):
    """Ledger baseline/post columns are JSON but can be 'null' (operator rollbacks, failed migrations)."""
    try:
        v = json.loads(x) if x else {}
    except (ValueError, TypeError):
        return {}
    return v if isinstance(v, dict) else {}


def _f(x):
    try:
        return float(x) if x is not None else None
    except (TypeError, ValueError):
        return None


def report() -> dict:
    """One row per switch that has ever been migrated: Legacy | Hybrid | Change | Recovery | Status.

    Where the numbers come from (first one that exists wins) -- this is why the old report was blank:
      Legacy  : baselines(legacy).mean_ms -> remembered comparison -> ledger.baseline.latency_ms
      Hybrid  : baselines(hybrid).mean_ms -> remembered comparison -> ledger.post.latency_ms
                (a ROLLED BACK switch shows the latency that triggered the rollback, parsed from its reason)
    The ledger's `post` column holds the migration-time check (latency_ms, failure_rate, ...); the
    monitor's Legacy-vs-Hybrid comparison lives in the baselines table, never in the ledger.
    """
    _load_cache()
    try:
        _remember_comparisons()
    except Exception:
        pass
    names, states = _names(), store().states()
    leg, hyb = _baseline_maps()
    hb_all = _read_json("monitor_status.json") or {}
    hb = hb_all.get("switches", {})
    ledger_rows = _ledger_with_ids()
    by_dpid: dict = {}
    for r in ledger_rows:
        by_dpid.setdefault(r["dpid"], []).append(r)
    rows = []
    for d in sorted(d for d, rs in by_dpid.items() if any(x["outcome"] in ("success", "reverted") for x in rs)):
        rs = by_dpid[d]
        oks = [x for x in rs if x["outcome"] == "success"]
        revs = [x for x in rs if x["outcome"] == "reverted"]
        ok, rev = (oks[-1] if oks else None), (revs[-1] if revs else None)
        rolled = bool(rev) and (not ok or rev["id"] > ok["id"])
        is_hybrid = states.get(d) == "Hybrid"
        cache = _cmp_cache.get(d) or {}

        legacy_ms, legacy_src = _f((leg.get(d) or {}).get("mean_ms")), "baseline"
        hybrid_ms, hybrid_src = _f((hyb.get(d) or {}).get("mean_ms")), "baseline"
        if legacy_ms is None:
            legacy_ms, legacy_src = _f(cache.get("legacy_ms")), "remembered"
        if legacy_ms is None and ok:
            legacy_ms, legacy_src = _f(_json(ok["baseline"]).get("latency_ms")), "migration check"
        trigger = None
        if rolled and rev and rev["reason"]:
            m = _ROLLBACK_RE.search(rev["reason"])
            if m:
                trigger = (float(m.group(1)), float(m.group(2)))
        if rolled and trigger:
            hybrid_ms, hybrid_src = trigger[0], "at rollback"
            if legacy_ms is None:
                legacy_ms, legacy_src = trigger[1], "at rollback"
        if hybrid_ms is None and not (is_hybrid and not rolled):
            hybrid_ms, hybrid_src = _f(cache.get("hybrid_ms")), "remembered"
        if hybrid_ms is None and ok and not is_hybrid:
            hybrid_ms, hybrid_src = _f(_json(ok["post"]).get("latency_ms")), "migration check"
        if is_hybrid and hybrid_ms is None:                  # monitor is still measuring the new tunnel
            hybrid_src = None
            post_ms = _f(_json(ok["post"]).get("latency_ms")) if ok else None
            if post_ms is not None:
                hybrid_ms, hybrid_src = post_ms, "migration check"
        if legacy_ms is None:
            legacy_src = None
        if hybrid_ms is None:
            hybrid_src = None
        change = ((hybrid_ms - legacy_ms) / legacy_ms * 100.0) if (legacy_ms and hybrid_ms is not None) else None

        if is_hybrid:
            st = (hb.get(d) or {}).get("status")
            status = "DEGRADED" if st == "degraded" else "HEALTHY" if st == "healthy" else "MEASURING"
        else:
            status = "ROLLED BACK" if rolled else "LEGACY"
        rows.append({
            "dpid": d, "switch": names.get(d, d[-4:]), "state": states.get(d, "Legacy"),
            "legacy_ms": _num(legacy_ms), "hybrid_ms": _num(hybrid_ms), "change_pct": _num(change, 1),
            "legacy_source": legacy_src, "hybrid_source": hybrid_src,
            "recovery_ms": _num(rev["recovery_latency_ms"], 1) if rev else None,
            "rollback_reason": rev["reason"] if rolled else None, "status": status,
            "migrated_at": ok["ts"] if ok else None, "rolled_back_at": rev["ts"] if rev else None,
            "migrations": len(oks), "rollbacks": len(revs),
        })

    changes = [r["change_pct"] for r in rows if r["change_pct"] is not None and r["status"] in ("HEALTHY", "DEGRADED", "MEASURING")]
    recov = [r["recovery_ms"] for r in rows if r["recovery_ms"]]
    nodes = len((_read_json("topology.json") or {}).get("nodes", [])) or len(states)
    summary = {
        "switches_total": nodes, "links": len((_read_json("topology.json") or {}).get("edges", [])),
        "switches_with_history": len(rows),
        "hybrid_now": sum(1 for r in rows if r["state"] == "Hybrid"),
        "rolled_back": sum(1 for r in rows if r["status"] == "ROLLED BACK"),
        "degraded": sum(1 for r in rows if r["status"] == "DEGRADED"),
        "never_migrated": max(0, nodes - len(rows)),
        "avg_change_pct": _num(sum(changes) / len(changes), 1) if changes else None,
        "avg_recovery_ms": _num(sum(recov) / len(recov), 1) if recov else None,
        "max_recovery_ms": _num(max(recov), 1) if recov else None,
    }
    return {"rows": rows, "rollback_rate": rollback_rate(), "summary": summary,
            "policy": hb_all.get("policy", {}), "generated_at": time.time()}
