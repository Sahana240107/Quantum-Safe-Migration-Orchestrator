"""Run:  QSMO_RUNTIME=$(mktemp -d) python3 tests/test_live_data.py   (from the repo root)"""
import os, sys, tempfile, time, json
os.environ.setdefault("QSMO_RUNTIME", tempfile.mkdtemp())
sys.path.insert(0, os.getcwd())
sys.argv = ["seed"]
from tools import seed_runtime as S
from migration.store import Store
from console import live_data as L

S.main()                                                    # seeded: s1,s2,s5 Hybrid
st = L.status()
assert st["state"] == "running" and st["online"], st
assert st["counts"] == {"switches": 7, "links": 8, "hybrid": 3, "legacy": 4, "degraded": 0}, st["counts"]

topo = L.topology()
n = {x["name"]: x for x in topo["nodes"]}
assert n["s1"]["state"] == "Hybrid" and n["s1"]["health"] == "healthy" and n["s1"]["change_pct"] > 25
assert n["s0"]["state"] == "Legacy" and n["s0"]["health"] == "n/a" and n["s0"]["legacy_baseline_ms"]
prot = [e for e in topo["edges"] if e["protected"]]
assert len(prot) == 1 and {prot[0]["source"], prot[0]["target"]} == {S.DPIDS[1], S.DPIDS[2]}, prot

tl = L.timeline()
assert [i["kind"] for i in tl["items"]].count("migrated") == 3
mon = L.monitoring()
assert len(mon["items"]) == 3 and mon["policy"]["consecutive_degraded_observations"] == 3

assert L.sample() is True and L.sample() is False             # same heartbeat -> no duplicate point
h = L.history(S.DPIDS[1])
assert len(h["points"]) == 1 and h["legacy_mean_ms"] and h["hybrid_mean_ms"]
leg_m = h["legacy_mean_ms"]
assert abs(h["legacy_limit_ms"] - (leg_m + max(leg_m * 2.0, 5.0))) < 0.01, h     # mean + max(200%, floor)
assert h["limit_ms"] == min(h["hybrid_limit_ms"], h["legacy_limit_ms"]) and h["limits_estimated"] is False

# --- degrade s2 (strike 2 of 3), then rollback --------------------------------
store = Store()
S.publish(store.runtime, store, {d: 9.0 for d in S.DPIDS}, {S.DPIDS[2]: 2})
n = {x["name"]: x for x in L.topology()["nodes"]}
assert n["s2"]["health"] == "degraded" and n["s2"]["degraded_count"] == 2
assert L.status()["counts"]["degraded"] == 1
assert {r["switch"]: r["status"] for r in L.report()["rows"]}["s2"] == "DEGRADED"

since = L.timeline()["last_ts"]
time.sleep(0.01)
d = S.DPIDS[2]
store.set_state(d, "Legacy", name="s2"); store.delete_baseline(d, "hybrid")
store.ledger_add(d, {"latency_ms": 3.0}, {"latency_ms": 4.0}, "reverted", reason="3 strikes", recovery_latency_ms=812.4)
S.publish(store.runtime, store, {x: 4.0 for x in S.DPIDS}, {})
new = L.timeline(since)["items"]
assert [i["kind"] for i in new] == ["rolled_back"] and new[0]["recovery_latency_ms"] == 812.4
rep = {r["switch"]: r for r in L.report()["rows"]}
assert rep["s2"]["status"] == "ROLLED BACK" and rep["s2"]["recovery_ms"] == 812.4 and rep["s2"]["change_pct"] > 25
assert rep["s1"]["status"] == "HEALTHY"
# --- the bug that showed blanks: Legacy/Hybrid/Change must come from the baselines table, not ledger.post
assert rep["s1"]["legacy_ms"] and rep["s1"]["hybrid_ms"] and rep["s1"]["change_pct"] > 25, rep["s1"]
assert rep["s2"]["hybrid_source"] == "remembered", rep["s2"]          # hybrid baseline was deleted at rollback
assert L.report()["summary"]["rolled_back"] == 1 and L.report()["summary"]["avg_change_pct"] > 25
# real rollback reason text -> the latency that triggered it is shown
store.ledger_add(S.DPIDS[5], {"latency_ms": 3.0}, {"latency_ms": 4.0}, "reverted", recovery_latency_ms=900.0,
                 reason="[legacy-compare] median(last 5)=256.446 ms > limit 10.105 ms (Legacy mean=3.368 ms)")
store.set_state(S.DPIDS[5], "Legacy", name="s5"); store.delete_baseline(S.DPIDS[5], "hybrid")
r5 = {r["switch"]: r for r in L.report()["rows"]}["s5"]
assert r5["status"] == "ROLLED BACK" and r5["hybrid_ms"] == 256.446 and r5["hybrid_source"] == "at rollback", r5
assert abs(r5["change_pct"] - (256.446 - r5["legacy_ms"]) / r5["legacy_ms"] * 100) < 5   # legacy_ms is rounded
assert L.rollback_rate() == 0.4, L.rollback_rate()      # 3 success, 2 reverted
assert L.status()["counts"]["hybrid"] == 1

# --- ledger rows whose baseline/post are JSON null (operator rollback / failed migration) must not 500
store.ledger_add(S.DPIDS[6], None, None, "reverted", reason="operator rollback", recovery_latency_ms=500.0)
store.ledger_add(S.DPIDS[6], None, None, "failed", reason="handshake error")
assert L.timeline()["items"] and L.report()["rows"] and L.ledger()["items"]

# --- outages -------------------------------------------------------------------
os.remove(os.path.join(store.runtime, "monitor_status.json"))
assert L.status()["state"] in ("monitor_down", "controller_down"), L.status()["state"]
os.remove(os.path.join(store.runtime, "topology.json"))
assert L.status()["state"] == "offline" and L.topology()["nodes"] == []
print("ALL LIVE_DATA TESTS PASSED")
