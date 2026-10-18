#!/usr/bin/env python3
"""
tools/patch_monitor_status.py -- 2-line, additive change to migration/monitor_service.py so the UI can
show the "strike meter" and the monitor policy. Idempotent. Makes monitor_service.py.bak. --revert undoes it.

  per switch : "degraded_count"  (0..N, rollback fires at consecutive_degraded_observations)
  top level  : "policy"          (MonitorConfig values: thresholds, window sizes, poll interval)
Run from the repo root:  python3 tools/patch_monitor_status.py
"""
import shutil, sys
P = "migration/monitor_service.py"
A_OLD = '"success_rate": r.get("success_rate"), "reasons": r.get("reasons"),\n'
A_NEW = A_OLD + '                "degraded_count": self.monitor._degraded_counts.get(d, 0),  # QSMO-UI\n'
B_OLD = 'snap = {"heartbeat": time.time(), "pid": os.getpid(), "controller_up": controller, "switches": sw}'
B_NEW = B_OLD + '\n        snap["policy"] = {k: v for k, v in vars(self.monitor.config).items()}  # QSMO-UI'

if "--revert" in sys.argv:
    shutil.move(P + ".bak", P); print("reverted"); sys.exit()
s = open(P, encoding="utf-8").read()
if "QSMO-UI" in s:
    print("already patched"); sys.exit()
if A_OLD not in s or B_OLD not in s:
    sys.exit("anchors not found - monitor_service.py changed; add the two fields by hand (see the doc)")
shutil.copy(P, P + ".bak")
open(P, "w", encoding="utf-8").write(s.replace(A_OLD, A_NEW).replace(B_OLD, B_NEW))
print("patched", P)
