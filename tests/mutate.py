"""Helper for tests/test_frontend.sh: change the (fake) runtime while the UI is polling."""
import os, sys
sys.path.insert(0, os.getcwd())
from tools import seed_runtime as S
from migration.store import Store

store, d = Store(), S.DPIDS[2]
if sys.argv[1] == "degrade":
    S.publish(store.runtime, store, {x: 9.0 for x in S.DPIDS}, {d: 2})
elif sys.argv[1] == "rollback":
    store.set_state(d, "Legacy", name="s2"); store.delete_baseline(d, "hybrid")
    store.ledger_add(d, {"latency_ms": 3.0}, {"latency_ms": 4.0}, "reverted",
                     reason="median 9.1 ms above limit (3 strikes)", recovery_latency_ms=812.4)
    S.publish(store.runtime, store, {x: 4.0 for x in S.DPIDS}, {})
elif sys.argv[1] == "beat":          # what the real monitor does every poll: new heartbeat, fresh latencies
    import json, random, time
    p = os.path.join(store.runtime, "monitor_status.json")
    hb = json.load(open(p))
    hb["heartbeat"] = time.time()
    for v in hb["switches"].values():
        if v["state"] == "Hybrid" and v["latency_ms"] is not None:
            v["latency_ms"] = round(v["latency_ms"] * random.uniform(0.97, 1.03), 3)
    topo = os.path.join(store.runtime, "topology.json")
    t = json.load(open(topo)); t["updated"] = time.time()
    for path, obj in ((p, hb), (topo, t)):
        json.dump(obj, open(path + ".tmp", "w")); os.replace(path + ".tmp", path); os.chmod(path, 0o666)
