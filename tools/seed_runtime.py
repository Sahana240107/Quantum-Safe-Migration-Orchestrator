#!/usr/bin/env python3
"""
tools/seed_runtime.py -- fake-but-realistic QSMO runtime/ for FRONTEND DEVELOPMENT (no VM needed).

Writes the SAME files the real programs write (runtime/qsmo.db via migration.store.Store,
topology.json, monitor_status.json), so the console API + React UI cannot tell the difference.

    export QSMO_RUNTIME=/tmp/qsmo_fake        # point everything at a scratch folder
    python3 tools/seed_runtime.py             # write one snapshot (s1,s2,s5 Hybrid), then exit
    python3 tools/seed_runtime.py --live      # keep running: noisy latency, then s2 degrades and is
                                              # rolled back after 3 strikes, then s2 is migrated again
Run the console with the same QSMO_RUNTIME.
"""
import argparse, json, os, random, sys, time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from migration.store import Store, _iso  # noqa: E402

N = 7
DPIDS = ["%016x" % i for i in range(1, N + 1)]
NAMES = {d: f"s{i}" for i, d in enumerate(DPIDS)}
EDGES = [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 6), (6, 0), (1, 4)]
POLICY = {"poll_interval": 0.5, "rolling_window": 5, "failure_window": 10, "failure_threshold": 2,
          "sigma_multiplier": 3.0, "min_latency_threshold_ms": 1.0, "legacy_threshold_percent": 200.0, "legacy_threshold_floor_ms": 5.0,
          "consecutive_degraded_observations": 3, "degradation_threshold_percent": 50.0}


def baseline(mean):
    return {"switch": "", "mean_ms": mean, "median_ms": mean * 0.98, "stddev_ms": mean * 0.06,
            "failures": 0, "attempt_count": 30, "samples": 27}


def hybrid_baseline(leg, mean):
    h = baseline(mean)
    h["latency_threshold_ms"] = mean * 1.2 + 1
    h["legacy_comparison"] = {"legacy_mean_ms": leg, "hybrid_mean_ms": mean, "legacy_median_ms": leg * 0.98,
                              "hybrid_median_ms": mean * 0.98, "delta_ms": mean - leg,
                              "percent_change": (mean - leg) / leg * 100}
    return h


def write_json(rt, name, obj):
    p = os.path.join(rt, name)
    with open(p + ".tmp", "w") as fh:
        json.dump(obj, fh)
    os.replace(p + ".tmp", p)
    os.chmod(p, 0o666)


def migrate(store, d, leg_mean, hyb_mean, port):
    store.set_state(d, "Hybrid", name=NAMES[d], hybrid_port=port)
    lb, hb = baseline(leg_mean), hybrid_baseline(leg_mean, hyb_mean)
    store.save_baseline(d, "legacy", lb)
    store.save_baseline(d, "hybrid", hb)
    # REAL ledger shape: the migration-time check only. The Legacy-vs-Hybrid comparison is NOT in the ledger
    # (the monitor saves it in the baselines table) -- the old seed hid that and the Report showed blanks.
    store.ledger_add(d, {"latency_ms": leg_mean, "failure_rate": 0.0, "overhead_bytes": 0},
                     {"latency_ms": hyb_mean, "failure_rate": 0.0, "overhead_bytes": 4096}, "success")
    store.add_event("executor", "adopt", f"{NAMES[d]}: Hybrid path verified", d)


def publish(rt, store, lat, counts, controller=True):
    states = store.states()
    sw = {}
    for d in DPIDS:
        st = states.get(d, "Legacy")
        v = {"state": st, "legacy_baseline": True, "hybrid_baseline": st == "Hybrid",
             "status": None, "latency_ms": None, "rolling_median_ms": None, "success_rate": None,
             "reasons": None, "degraded_count": 0}
        if st == "Hybrid":
            x = lat[d]
            bad = counts.get(d, 0) > 0
            v.update(status="degraded" if bad else "healthy", latency_ms=x, rolling_median_ms=x * 0.97,
                     success_rate=0.7 if bad else 1.0, degraded_count=counts.get(d, 0),
                     reasons=[f"median {x:.1f} ms above limit"] if bad else [])
        sw[d] = v
    write_json(rt, "monitor_status.json", {"heartbeat": time.time(), "pid": os.getpid(),
               "controller_up": controller, "switches": sw, "policy": POLICY})
    write_json(rt, "topology.json", {"updated": time.time(),
               "nodes": [{"dpid": d, "name": NAMES[d]} for d in DPIDS],
               "edges": [[DPIDS[a], DPIDS[b]] for a, b in EDGES]})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true")
    a = ap.parse_args()
    real = os.path.realpath(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runtime"))
    env = os.environ.get("QSMO_RUNTIME")
    if not env or os.path.realpath(env) == real:
        sys.exit("REFUSING to run: this tool WIPES its runtime folder.\n"
                 "Point it at a scratch folder first:  export QSMO_RUNTIME=/tmp/qsmo_fake\n"
                 "(your real data in ./runtime is untouched)")
    store = Store()
    rt = store.runtime
    store.wipe()
    rnd = random.Random(7)
    leg = {d: 3.0 + rnd.random() for d in DPIDS}
    for d in DPIDS:
        store.note_switch(d, name=NAMES[d], hybrid_port=20000 + int(d, 16))
        store.save_baseline(d, "legacy", baseline(leg[d]))
    for i in (1, 2, 5):
        migrate(store, DPIDS[i], leg[DPIDS[i]], leg[DPIDS[i]] * 1.3, 20000 + i + 1)
    store.add_event("monitor", "reconcile", "reconciled: 3 Hybrid, 4 Legacy")
    lat = {d: leg[d] * 1.3 for d in DPIDS}
    counts = {}
    publish(rt, store, lat, counts)
    print(f"seeded {rt}")
    if not a.live:
        return
    t0, target = time.time(), DPIDS[2]
    rolled = False
    while True:
        t = time.time() - t0
        for d in DPIDS:
            if store.get_state(d) == "Hybrid":
                lat[d] = leg[d] * 1.3 * (1 + rnd.uniform(-0.05, 0.05))
        if 20 < t < 32 and not rolled:                       # degrade s2: one strike every 4 s
            lat[target] = leg[target] * 3.0
            counts[target] = min(3, int((t - 20) // 4) + 1)
        if t >= 32 and not rolled:                           # strike 3 -> automatic rollback
            store.set_state(target, "Legacy", name=NAMES[target])
            store.delete_baseline(target, "hybrid")
            store.ledger_add(target, {"latency_ms": leg[target]}, {"latency_ms": leg[target] * 1.3}, "reverted",
                             reason="[legacy-compare] median(last 5)=9.100 ms > limit 5.200 ms (Legacy mean=%.3f ms)" % leg[target],
                             recovery_latency_ms=812.4)
            store.add_event("monitor", "rollback", f"{NAMES[target]} rolled back to Legacy", target)
            counts.pop(target, None)
            rolled = True
        if t >= 50 and rolled and store.get_state(target) == "Legacy":     # operator migrates it again
            migrate(store, target, leg[target], leg[target] * 1.3, 20003)
            rolled = False
            t0 = time.time() - 40                               # stay healthy for a while, then repeat
        publish(rt, store, lat, counts)
        time.sleep(1.0)


if __name__ == "__main__":
    main()
