#!/usr/bin/env bash
# End-to-end, website domains (Pro): the Track extension in a real Chromium → the native
# messaging host (the agent binary, started by the browser) → the agent → the API.
# Requires Postgres, a Rust toolchain and Playwright's Chromium. Exits non-zero on mismatch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DATABASE_URL="${E2E_DATABASE_URL:-postgres://rd:rd@localhost:5432/rd_track_e2e_browser}"
export NODE_ENV=development STORAGE=local MFA_REQUIRED_FOR_ADMINS=false PORT="${E2E_PORT:-4200}"
export PUBLIC_API_URL="http://127.0.0.1:${PORT}" LOCAL_STORAGE_DIR="$(mktemp -d)" E2E_DOMAINS=1
WORK="$(mktemp -d)"
DURATION="${E2E_DURATION:-75}"

psql "${DATABASE_URL%/*}/postgres" -qc "DROP DATABASE IF EXISTS ${DATABASE_URL##*/}" -c "CREATE DATABASE ${DATABASE_URL##*/}"
cd "$ROOT/apps/api"
SETUP="$(npx tsx test/e2e/setup.ts)"
field() { node -e "console.log(JSON.parse(process.argv[1]).$1)" "$SETUP"; }
CODE="$(field code)" PROJECT="$(field project_id)" USER_ID="$(field user_id)"

npx tsx src/main.ts > "$WORK/api.log" 2>&1 &
API_PID=$!
npx tsx src/worker.ts > "$WORK/worker.log" 2>&1 &
WORKER_PID=$!
BROWSER_PID=
trap 'kill $API_PID $WORKER_PID $BROWSER_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null && break; sleep 0.2; done

cd "$ROOT/agent"
cargo build -q -p rd-agent
node browser-extension/build.mjs >/dev/null
AGENT="$ROOT/agent/target/debug/rd-agent"
DATA="$WORK/agent"
"$AGENT" enroll --server "http://127.0.0.1:${PORT}" --code "$CODE" --data-dir "$DATA"

# The browser finds the host in <profile>/NativeMessagingHosts (Chromium on Linux, per profile).
PROFILE="$WORK/profile"
mkdir -p "$PROFILE/NativeMessagingHosts"
printf '#!/bin/sh\nRD_AGENT_DATA_DIR=%s exec %s "$@"\n' "$DATA" "$AGENT" > "$WORK/host.sh"
chmod +x "$WORK/host.sh"
cat > "$PROFILE/NativeMessagingHosts/digital.round.track.json" <<JSON
{"name": "digital.round.track", "description": "e2e", "path": "$WORK/host.sh", "type": "stdio",
 "allowed_origins": ["chrome-extension://gagmoddppfppofnboknnmkiakhjmacln/"]}
JSON

if [ -z "${PLAYWRIGHT_NODE_PATH:-}" ]; then PLAYWRIGHT_NODE_PATH="$(npm root -g)"; fi
NODE_PATH="$PLAYWRIGHT_NODE_PATH" node "$ROOT/scripts/e2e-browser.mjs" "$PROFILE" "$ROOT/agent/browser-extension/dist/chromium" $((DURATION + 20)) &
BROWSER_PID=$!
sleep 5
# The simulated platform keeps Chromium in front, as on a computer where the browser is.
"$AGENT" run --simulate --foreground-app org.chromium.Chromium --project "$PROJECT" --duration "$DURATION" --data-dir "$DATA"
sleep 3 # let the worker drain

q() { psql "$DATABASE_URL" -Atc "$1"; }
DOMAINS=$(q "SELECT string_agg(DISTINCT coalesce(domain, '-'), ',') FROM app_usage WHERE user_id = '$USER_ID'")
DOMAIN_SECONDS=$(q "SELECT COALESCE(sum(duration_seconds), 0) FROM app_usage WHERE user_id = '$USER_ID' AND domain = 'docs.example'")
EXTENSIONS=$(q "SELECT array_to_string(browser_extensions, ',') FROM devices WHERE user_id = '$USER_ID'")
LEAKS=$(q "SELECT count(*) FROM ingest_events WHERE payload::text ~ '(handbook|payroll|token)'")
REJECTED=$(q "SELECT count(*) FROM ingest_events WHERE status = 'rejected'")
echo "domains=$DOMAINS docs.example_seconds=$DOMAIN_SECONDS browser_extensions=$EXTENSIONS leaks=$LEAKS rejected=$REJECTED"
LEFT=$(ls "$DATA/browser" 2>/dev/null | tr '\n' ' ')
echo "bridge after the session: $LEFT$(cat "$DATA/browser/chromium.json" 2>/dev/null)"

fail=0
[ "$DOMAIN_SECONDS" -ge $((DURATION / 3)) ] || { echo "expected time on docs.example"; fail=1; }
[ "$EXTENSIONS" = "chromium" ] || { echo "expected the heartbeat to report the Chromium extension"; fail=1; }
[ "$LEAKS" -eq 0 ] || { echo "a path or query reached the server"; fail=1; }
[ "$REJECTED" -eq 0 ] || { echo "events were rejected"; fail=1; }
[ ! -e "$DATA/browser/wanted" ] || { echo "domains still wanted after the session"; fail=1; }
! grep -q docs.example "$DATA/browser/chromium.json" 2>/dev/null || { echo "a domain was kept after the session"; fail=1; }
if [ $fail -ne 0 ]; then echo "--- api.log"; tail -30 "$WORK/api.log"; exit 1; fi
echo "E2E browser OK"
