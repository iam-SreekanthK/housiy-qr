#!/usr/bin/env bash
# Host-side k6 runner against the already-running real Housiy DEV Compose services.
# It intentionally does not create a test container, test database, proxy, or app process.
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
ENV_NAME="${ENV_NAME:-dev}"
[[ "$ENV_NAME" == "dev" ]] || { echo "ERROR: load runner only permits ENV_NAME=dev." >&2; exit 2; }
ENV_FILE="deployment/docker/.env.dev"
COMPOSE_FILE="deployment/docker/docker-compose.yml"
PROJECT="housiy-dev"
[[ -f "$ENV_FILE" ]] || { echo "ERROR: $ENV_FILE not found. Configure DEV first." >&2; exit 2; }
command -v docker >/dev/null || { echo "ERROR: Docker is required." >&2; exit 2; }
command -v k6 >/dev/null || { echo "ERROR: Install k6 on the host; this script does not run a k6 container." >&2; exit 2; }

val() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r' | sed 's/[[:space:]]*#.*$//'; }
APP_PORT="$(val APP_PORT)"
APP_PORT="${APP_PORT:-8081}"
BASE_URL="${BASE_URL:-http://127.0.0.1:${APP_PORT}}"
[[ "$BASE_URL" == "http://127.0.0.1:"* || "$BASE_URL" == "http://localhost:"* ]] || {
  echo "ERROR: only localhost targets are permitted by this runner. BASE_URL=$BASE_URL" >&2; exit 2;
}
DC=(docker compose --project-name "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# Require existing real service containers and healthy status; never call up/build/down/restart.
for svc in app php worker realtime redis db; do
  cid="$("${DC[@]}" ps -q "$svc")"
  [[ -n "$cid" ]] || { echo "ERROR: real service '$svc' is not created. Start DEV with envctl.sh dev up first." >&2; exit 2; }
  state="$(docker inspect -f '{{.State.Status}}' "$cid")"
  [[ "$state" == running ]] || { echo "ERROR: service '$svc' state=$state; refusing to test." >&2; exit 2; }
  health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")"
  if [[ "$health" != healthy && "$health" != none ]]; then
    echo "ERROR: service '$svc' health=$health; refusing to test." >&2; exit 2
  fi
done
# Guard against the legacy test stack / test-only proxy container.
if "${DC[@]}" ps --services --filter status=running | grep -Eq '^(test-runner|nginx-test)$'; then
  echo "ERROR: a test-only service is running in the DEV project. Stop and remove that test service before testing." >&2; exit 2
fi
curl -fsS --max-time 5 "$BASE_URL/index.html" >/dev/null || { echo "ERROR: real app endpoint $BASE_URL is not responding." >&2; exit 2; }

# The API itself must report dev; k6 independently verifies this before each scenario.
export BASE_URL TARGET_ENV=dev
SCENARIOS="${SCENARIOS:-smoke results load load30 stress ratelimit fullgame_smoke multiroom normal players100 stress25x100 soak}"
INCLUDE_CAPACITY="${INCLUDE_CAPACITY:-NO}"
if [[ "$INCLUDE_CAPACITY" == YES ]]; then SCENARIOS="$SCENARIOS capacity"; fi
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="tests/load/results/${STAMP}"
mkdir -p "$OUT_DIR"
echo "Target: $BASE_URL (real app container through its published port)"
echo "Project: $PROJECT | Scenarios: $SCENARIOS"
echo "No containers will be created, built, restarted, or stopped."

for scenario in $SCENARIOS; do
  case "$scenario" in
    smoke|results|load|load30|stress|ratelimit|fullgame_smoke|multiroom|normal|players100|stress25x100|capacity|soak) ;;
    *) echo "ERROR: unknown scenario '$scenario'." >&2; exit 2;;
  esac
  echo "===== SCENARIO: $scenario ====="
  scenario_dir="$OUT_DIR/$scenario"
  mkdir -p "$scenario_dir"
  # Distinct summary filenames prevent scenarios from overwriting each other.
  if ! BASE_URL="$BASE_URL" TARGET_ENV=dev SCENARIO="$scenario" REPORT_DIR="$scenario_dir" \
       k6 run --out json="$scenario_dir/metrics.json" tests/load/main.js; then
    echo "FAILED: $scenario" | tee -a "$OUT_DIR/status.txt"
    echo "Stopped on first failure. Reports: $OUT_DIR" >&2
    exit 1
  fi
  echo "PASSED: $scenario" | tee -a "$OUT_DIR/status.txt"
done

echo "Completed. Reports: $OUT_DIR"
