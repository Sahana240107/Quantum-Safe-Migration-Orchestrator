#!/usr/bin/env python3
"""
tools/dev_server.py -- FALLBACK server using only the Python standard library.
Same URLs as console/live_app.py. Use it if FastAPI/uvicorn will not install.

    python3 tools/dev_server.py [--port 8000]      (run from the repo root)
"""
import argparse, json, mimetypes, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from console import live_data as L  # noqa: E402

STATIC = os.path.join(ROOT, "console", "static", "live")
API = "/api/v1/live"


def route(path, q):
    one = lambda k, d=None: (q.get(k) or [d])[0]
    if path == "/status": return L.status()
    if path == "/topology": return L.topology()
    if path == "/timeline": return L.timeline(one("since"), int(one("limit", 200)))
    if path == "/monitoring": return L.monitoring()
    if path.startswith("/history/"): return L.history(path.split("/", 2)[2], int(one("limit", 300)))
    if path == "/ledger": return L.ledger()
    if path == "/report": return L.report()
    return None


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        u = urlparse(self.path)
        if u.path.startswith(API + "/") or u.path == API:
            try:
                data = route(u.path[len(API):], parse_qs(u.query))
            except Exception as e:
                return self._send(500, json.dumps({"detail": str(e)}).encode(), "application/json")
            if data is None:
                return self._send(404, b'{"detail":"not found"}', "application/json")
            return self._send(200, json.dumps(data).encode(), "application/json")
        if u.path == "/":
            self.send_response(302); self.send_header("Location", "/live-ui/"); self.end_headers(); return
        if u.path.startswith("/live-ui/"):
            rel = u.path[len("/live-ui/"):] or "index.html"
            f = os.path.normpath(os.path.join(STATIC, rel))
            if f.startswith(STATIC) and os.path.isfile(f):
                ctype = mimetypes.guess_type(f)[0] or "application/octet-stream"
                return self._send(200, open(f, "rb").read(), ctype)
        self._send(404, b"not found", "text/plain")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="0.0.0.0"); a = ap.parse_args()
    L.start_sampler()
    print(f"QSMO Live Console (stdlib server) on http://localhost:{a.port}   runtime={L.store().runtime}")
    ThreadingHTTPServer((a.host, a.port), H).serve_forever()
