#!/usr/bin/env python3
"""
tools/patch_monitor_thresholds.py -- makes the monitor's "legacy-compare" limit tunable from the environment.
Idempotent. Makes migration/monitor_service.py.bak. --revert undoes it. Run from the repo root.

  QSMO_LEGACY_PCT       default 200   (limit = Legacy mean + max(mean*PCT/100, FLOOR))
  QSMO_LEGACY_FLOOR_MS  default 5     (the code's own defaults, so behaviour is unchanged until you set them)

Example for a slow VM where Hybrid really sits at ~250 ms:
  QSMO_LEGACY_FLOOR_MS=600 sudo -E ./run_monitor.sh
"""
import shutil, sys
P = "migration/monitor_service.py"
OLD = "                degradation_threshold_percent=20.0,\n"
NEW = OLD + ("                legacy_threshold_percent=float(os.environ.get(\"QSMO_LEGACY_PCT\", \"200\")),  # QSMO-UI\n"
             "                legacy_threshold_floor_ms=float(os.environ.get(\"QSMO_LEGACY_FLOOR_MS\", \"5\")),  # QSMO-UI\n")
if "--revert" in sys.argv:
    shutil.move(P + ".bak", P); print("reverted"); sys.exit()
s = open(P, encoding="utf-8").read()
if "QSMO_LEGACY_PCT" in s:
    print("already patched"); sys.exit()
if OLD not in s:
    sys.exit("anchor not found - monitor_service.py changed; add the two MonitorConfig arguments by hand")
shutil.copy(P, P + ".bak")
open(P, "w", encoding="utf-8").write(s.replace(OLD, NEW))
print("patched", P)
