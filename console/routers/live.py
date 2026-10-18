"""console/routers/live.py -- read-only endpoints for the REAL QSMO network. Add to console/main.py:

    from console.routers import live
    app.include_router(live.router)

    @app.on_event("startup")
    def _live_sampler():
        from console import live_data
        live_data.start_sampler()
"""
from fastapi import APIRouter, Query

from console import live_data as L

router = APIRouter(prefix="/api/v1/live", tags=["13. Live network (real data)"])


@router.get("/status", summary="Are the network / controller / monitor running? Counts")
def status():
    return L.status()


@router.get("/topology", summary="Real switches + links: Legacy/Hybrid state, health, latency")
def topology():
    return L.topology()


@router.get("/timeline", summary="Migrations, rollbacks and system events. Poll with since=<last_ts>")
def timeline(since: str | None = None, limit: int = Query(200, ge=1, le=1000)):
    return L.timeline(since, limit)


@router.get("/monitoring", summary="Live health of every Hybrid switch + monitor policy")
def monitoring():
    return L.monitoring()


@router.get("/history/{dpid}", summary="Latency history of one switch (API keeps a ring buffer)")
def history(dpid: str, limit: int = Query(300, ge=1, le=600)):
    return L.history(dpid, limit)


@router.get("/ledger", summary="Raw migration ledger (success / failed / reverted)")
def ledger():
    return L.ledger()


@router.get("/report", summary="Legacy vs Hybrid vs Change vs Recovery vs Status")
def report():
    return L.report()
