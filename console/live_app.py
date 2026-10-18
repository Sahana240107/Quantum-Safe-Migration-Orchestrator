"""
console/live_app.py -- the QSMO Live Console: real-data API + the web UI, in ONE process.

    cd ~/ndc/Migration-Orchestrator
    source .venv-console/bin/activate
    uvicorn console.live_app:app --host 0.0.0.0 --port 8000
    # open http://localhost:8000     (API docs: http://localhost:8000/docs)

It does NOT touch the old simulated console (console/main.py). Run from the repo root.
"""
import os

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from fastapi.staticfiles import StaticFiles

from console import live_data
from console.routers import live

app = FastAPI(title="QSMO Live Console", version="5.0",
              description="Read-only view of the real QSMO runtime (runtime/qsmo.db, topology.json, monitor_status.json)")
app.include_router(live.router)

_STATIC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "live")
app.mount("/live-ui", StaticFiles(directory=_STATIC, html=True), name="live-ui")


@app.get("/", include_in_schema=False)
def _root():
    return RedirectResponse("/live-ui/")


@app.on_event("startup")
def _start_sampler():
    live_data.start_sampler()          # keeps the latency history the charts draw
