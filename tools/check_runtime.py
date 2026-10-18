#!/usr/bin/env python3
"""tools/check_runtime.py -- run as your NORMAL user (no sudo) from the repo root. Read-only.
Tells you whether the console will be able to read what the sudo programs wrote."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from migration.store import Store, runtime_dir  # noqa: E402

rt = runtime_dir()
print("runtime folder:", rt)
if not os.path.isdir(rt):
    sys.exit("  ✗ does not exist. Start ./run_controller.sh and ./run_monitor.sh first")
for name in ("qsmo.db", "topology.json", "monitor_status.json"):
    p = os.path.join(rt, name)
    if not os.path.exists(p):
        print(f"  ✗ {name}: missing"); continue
    ok = os.access(p, os.R_OK)
    age = time.time() - os.path.getmtime(p)
    print(f"  {'✓' if ok else '✗'} {name}: {'readable' if ok else 'NOT readable (permission)'}, updated {age:.0f}s ago")
try:
    s = Store()
    st = s.states()
    print(f"  ✓ database opens: {len(st)} switches, {sum(v == 'Hybrid' for v in st.values())} Hybrid")
except Exception as e:
    print("  ✗ database error:", e)
try:
    hb = json.load(open(os.path.join(rt, "monitor_status.json")))
    print(f"  ✓ monitor heartbeat {time.time() - hb['heartbeat']:.1f}s ago, controller_up={hb.get('controller_up')}, "
          f"policy published={'yes' if hb.get('policy') else 'NO (run tools/patch_monitor_status.py)'}")
except Exception as e:
    print("  ✗ monitor_status.json:", e)
