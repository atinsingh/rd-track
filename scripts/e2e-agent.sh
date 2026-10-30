#!/usr/bin/env bash
# End-to-end: the real Rust agent (simulated input) against the real API + worker.
# Requires Postgres (DATABASE_URL) and a Rust toolchain. Exits non-zero on mismatch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DATABASE_URL="${E2E_DATABASE_URL:-postgres://rd:rd@localhost:5432/rd_track_e2e}"
export NODE_ENV=development STORAGE=local MFA_REQUIRED_FOR_ADMINS=false PORT="${E2E_PORT:-4100}"
export PUBLIC_API_URL="http://127.0.0.1:${PORT}" LOCAL_STORAGE_DIR="$(mktemp -d)"
DATA_DIR="$(mktemp -d)"
DURATION="${E2E_DURATION:-150}"

psql "${DATABASE_URL%/*}/postgres" -qc "DROP DATABASE IF EXISTS ${DATABASE_URL##*/}" -c "CREATE DATABASE ${DATABASE_URL##*/}"
cd "$ROOT/apps/api"
SETUP="$(npx tsx test/e2e/setup.ts)"
CODE="$(node -e "console.log(JSON.parse(process.argv[1]).code)" "$SETUP")"
PROJECT="$(node -e "console.log(JSON.parse(process.argv[1]).project_id)" "$SETUP")"
USER_ID="$(node -e "console.log(JSON.parse(process.argv[1]).user_id)" "$SETUP")"

npx tsx src/main.ts > "$DATA_DIR/api.log" 2>&1 &
API_PID=$!
npx tsx src/worker.ts > "$DATA_DIR/worker.log" 2>&1 &
WORKER_PID=$!
trap 'kill $API_PID $WORKER_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null && break; sleep 0.2; done

cd "$ROOT/agent"
cargo build -q -p rd-agent
AGENT="$ROOT/agent/target/debug/rd-agent"
"$AGENT" enroll --server "http://127.0.0.1:${PORT}" --code "$CODE" --data-dir "$DATA_DIR/agent"
"$AGENT" run --simulate --project "$PROJECT" --seed 86 --duration "$DURATION" --data-dir "$DATA_DIR/agent"
"$AGENT" status --data-dir "$DATA_DIR/agent" || true
sleep 3 # let the worker drain

q() { psql "$DATABASE_URL" -Atc "$1"; }
SESSIONS=$(q "SELECT count(*) FROM work_sessions WHERE user_id = '$USER_ID' AND state = 'stopped'")
BUCKETS=$(q "SELECT count(*) FROM activity_buckets WHERE user_id = '$USER_ID'")
TRACKED=$(q "SELECT COALESCE(sum(active_seconds + idle_seconds), 0) FROM activity_buckets WHERE user_id = '$USER_ID'")
APPS=$(q "SELECT count(*) FROM app_usage WHERE user_id = '$USER_ID'")
SHOTS=$(q "SELECT count(*) FROM screenshots WHERE user_id = '$USER_ID' AND status = 'stored' AND blurred")
REJECTED=$(q "SELECT count(*) FROM ingest_events WHERE status = 'rejected'")
PENDING=$(q "SELECT count(*) FROM ingest_events WHERE status = 'pending'")
echo "sessions=$SESSIONS buckets=$BUCKETS tracked_seconds=$TRACKED app_usage=$APPS screenshots=$SHOTS rejected=$REJECTED pending=$PENDING"

fail=0
[ "$SESSIONS" -eq 1 ] || { echo "expected 1 stopped session"; fail=1; }
[ "$BUCKETS" -ge $((DURATION / 60 - 1)) ] || { echo "expected at least $((DURATION / 60 - 1)) buckets"; fail=1; }
[ "$TRACKED" -le "$DURATION" ] || { echo "tracked time exceeds wall-clock run time"; fail=1; }
[ "$APPS" -ge 1 ] || { echo "expected app usage"; fail=1; }
[ "$SHOTS" -ge 1 ] || { echo "expected a stored, blurred screenshot"; fail=1; }
[ "$REJECTED" -eq 0 ] || { echo "events were rejected:"; q "SELECT event_type, reason FROM ingest_events WHERE status = 'rejected'"; fail=1; }
[ "$PENDING" -eq 0 ] || { echo "events still pending"; fail=1; }
if [ $fail -ne 0 ]; then echo "--- api.log"; tail -40 "$DATA_DIR/api.log"; echo "--- worker.log"; tail -20 "$DATA_DIR/worker.log"; exit 1; fi
echo "E2E OK"
