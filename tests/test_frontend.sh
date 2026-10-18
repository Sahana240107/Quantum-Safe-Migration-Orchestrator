#!/bin/bash
# Run from the repo root:  bash tests/test_frontend.sh      (needs node >= 18 and python3; no browser, no npm)
set -e
command -v node >/dev/null || { echo 'node is not installed - skipping the browser-side tests (the UI itself does not need node)'; exit 0; }
export QSMO_RUNTIME=$(mktemp -d)
export QSMO_CACHE_S=0
PORT=${PORT:-18765}
TMP=$(mktemp -d)
cp console/static/live/*.js tests/frontend_harness.mjs tests/test_lib.mjs "$TMP"/
echo '{"type":"module"}' > "$TMP/package.json"

echo "== 1. pure-function tests"
node "$TMP/test_lib.mjs"

echo "== 2. seed a fake runtime and start the stdlib server"
python3 tools/seed_runtime.py
python3 tools/dev_server.py --port $PORT --host 127.0.0.1 & SRV=$!
( while true; do python3 tests/mutate.py beat 2>/dev/null; sleep 0.5; done ) & BEAT=$!   # acts like the real monitor
trap 'kill $SRV $BEAT 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -sf localhost:$PORT/api/v1/live/status >/dev/null && break; sleep 0.2; done
curl -sf localhost:$PORT/live-ui/ | grep -q "QSMO Live Console" && echo "   static UI served"
curl -sf localhost:$PORT/live-ui/app.js | grep -q "export async function tick" && echo "   app.js served"

echo "== 3. the real app.js against the real API (stub DOM, no browser)"
BASE=http://127.0.0.1:$PORT node "$TMP/frontend_harness.mjs"
echo "ALL FRONTEND TESTS PASSED"
