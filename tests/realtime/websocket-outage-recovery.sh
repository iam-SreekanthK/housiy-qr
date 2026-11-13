#!/usr/bin/env bash
# Housiy WebSocket outage/recovery smoke test (DEV only).
# Keep at least one authenticated host/player room page open while running.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
COMPOSE=(docker compose -f deployment/docker/docker-compose.yml --env-file deployment/docker/.env.dev)

if [[ ! -f deployment/docker/.env.dev ]]; then
  echo "ERROR: deployment/docker/.env.dev not found" >&2
  exit 1
fi
command -v docker >/dev/null || { echo "ERROR: docker is required" >&2; exit 1; }

restore_gateway() {
  "${COMPOSE[@]}" start realtime >/dev/null 2>&1 || true
}
trap restore_gateway EXIT

wait_gateway() {
  local attempt
  for attempt in $(seq 1 30); do
    if "${COMPOSE[@]}" exec -T realtime wget -qO- http://127.0.0.1:8090/healthz >/tmp/housiy-ws-health.json 2>/dev/null; then
      cat /tmp/housiy-ws-health.json
      return 0
    fi
    sleep 1
  done
  echo "ERROR: realtime gateway did not become healthy within 30 seconds" >&2
  "${COMPOSE[@]}" logs --tail=100 realtime >&2 || true
  return 1
}

echo "[1/6] Validate Nginx configuration"
"${COMPOSE[@]}" exec -T app nginx -t

echo "[2/6] Capture initial service state"
"${COMPOSE[@]}" ps

echo "[3/6] Stop realtime gateway (browser must remain open)"
"${COMPOSE[@]}" stop realtime
sleep 8

echo "[4/6] Confirm HTTP fallback traffic reached the app"
OUTAGE_LOG="$(${COMPOSE[@]} logs --since=20s --no-color app 2>&1 || true)"
printf '%s\n' "$OUTAGE_LOG" | grep -E 'GET /api/(results|ticket|reactions)\.php' | tail -20 || true
if ! printf '%s\n' "$OUTAGE_LOG" | grep -Eq 'GET /api/(results|ticket|reactions)\.php'; then
  echo "WARNING: no fallback API traffic was observed. Confirm an authenticated room page was open." >&2
fi

echo "[5/6] Restart gateway and wait for health"
"${COMPOSE[@]}" start realtime
wait_gateway
sleep 3

echo "[6/6] Verify Nginx recovered and show realtime metrics"
"${COMPOSE[@]}" exec -T app nginx -t
"${COMPOSE[@]}" exec -T realtime wget -qO- http://127.0.0.1:8090/metrics
"${COMPOSE[@]}" logs --since=15s --no-color realtime | tail -60
"${COMPOSE[@]}" ps

echo "\nGateway outage/restart smoke test completed."
echo "Browser verification still required: confirm fallback requests stop after the replacement socket receives HELLO."
