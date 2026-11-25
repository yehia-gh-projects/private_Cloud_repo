#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RATE_LIMIT="${RATE_LIMIT_MAX:-300}"
KILL_PORT_8080=1
PIDS=()
CLEANED_UP=0

usage() {
  cat << 'USAGE'
Usage: ./start-all.sh [options]

Options:
  -r, --rate-limit <num>   Set local dev rate-limit max requests (default: 300; min: 300)
  --no-kill-8080           Do not auto-kill an existing listener on port 8080
  -h, --help               Show this help message

Examples:
  ./start-all.sh
  ./start-all.sh --rate-limit 1000
  ./start-all.sh -r 500
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r|--rate-limit)
      if [[ -z "${2:-}" || ! "$2" =~ ^[0-9]+$ ]]; then
        echo "[launcher] Error: --rate-limit requires a positive integer" >&2
        exit 1
      fi
      RATE_LIMIT="$2"
      shift 2
      ;;
    --no-kill-8080)
      KILL_PORT_8080=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[launcher] Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

# Enforce at least 300 requests for smoother local testing/navigation
if (( RATE_LIMIT < 300 )); then
  echo "[launcher] Rate limit $RATE_LIMIT is below minimum 300; raising to 300."
  RATE_LIMIT=300
fi

free_port_8080() {
  local pids=""
  if command -v powershell.exe >/dev/null 2>&1; then
    pids="$(powershell.exe -NoProfile -Command "Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique" 2>/dev/null | tr -d '\r' | tr '\n' ' ')"
  elif command -v netstat >/dev/null 2>&1; then
    pids="$(netstat -ano 2>/dev/null | awk '/:8080[[:space:]].*LISTENING/ {print $NF}' | sort -u | tr '\n' ' ')"
  elif command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti :8080 2>/dev/null | tr '\n' ' ')"
  fi

  pids="$(echo "$pids" | xargs 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "[launcher] Freeing port 8080 from existing PID(s): $pids"
    for pid in $pids; do
      if command -v taskkill.exe >/dev/null 2>&1; then
        MSYS_NO_PATHCONV=1 taskkill.exe /F /PID "$pid" >/dev/null 2>&1 || true
      else
        kill -9 "$pid" >/dev/null 2>&1 || true
      fi
    done
    sleep 0.5
  fi
}

kill_tree() {
  local target_pid="$1"
  [[ -z "$target_pid" ]] && return
  if command -v taskkill.exe >/dev/null 2>&1; then
    local winpid=""
    if [[ -r "/proc/$target_pid/winpid" ]]; then
      winpid="$(tr -d '\r\n' < "/proc/$target_pid/winpid" 2>/dev/null || true)"
    fi
    if [[ -n "$winpid" ]]; then
      MSYS_NO_PATHCONV=1 taskkill.exe /F /T /PID "$winpid" >/dev/null 2>&1 || true
    fi
  fi
  pkill -P "$target_pid" >/dev/null 2>&1 || true
  kill -TERM "$target_pid" >/dev/null 2>&1 || true
}

cleanup() {
  if (( CLEANED_UP == 1 )); then
    return
  fi
  CLEANED_UP=1
  echo ""
  echo "[launcher] Stopping all services..."
  for pid in "${PIDS[@]}"; do
    kill_tree "$pid"
  done
  wait 2>/dev/null || true
  echo "[launcher] Done."
}

trap cleanup INT TERM HUP EXIT

start_service() {
  local tag="$1"
  local dir="$2"
  shift 2

  (
    cd "$dir" || exit 1
    export RATE_LIMIT_MAX="$RATE_LIMIT"
    exec "$@"
  ) > >(sed -u "s/^/[$tag] /") 2>&1 &

  PIDS+=("$!")
}

if (( KILL_PORT_8080 == 1 )); then
  free_port_8080
fi

echo "[launcher] Starting stack on http://localhost:${PROXY_PORT:-8080} (RATE_LIMIT_MAX=${RATE_LIMIT})..."

# 1. Catalogue & Auth (:3000)
start_service "3000:mohamed" "$ROOT_DIR/mohamed" \
  env PORT="${MOHAMED_PORT:-3000}" \
  node --env-file-if-exists=.env src/server.js

# 2. Timetable (:3002) in live mode
start_service "3002:yehia" "$ROOT_DIR/yehia" \
  env PORT="${YEHIA_PORT:-3002}" \
  DEP_MODE="${DEP_MODE:-live}" \
  CATALOGUE_URL="${CATALOGUE_URL:-http://127.0.0.1:3000}" \
  CATALOGUE_PUBLIC_KEY_URL="${CATALOGUE_PUBLIC_KEY_URL:-http://127.0.0.1:3000/.well-known/jwks.json}" \
  CORS_ORIGINS="${CORS_ORIGINS:-http://127.0.0.1:8080,http://localhost:8080}" \
  AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://127.0.0.1:4566}" \
  AWS_REGION="${AWS_REGION:-us-east-1}" \
  AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" \
  AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}" \
  TIMETABLES_TABLE="${TIMETABLES_TABLE:-timetables}" \
  SECTION_INDEX_TABLE="${SECTION_INDEX_TABLE:-section_timetables}" \
  SECTION_EVENTS_QUEUE="${SECTION_EVENTS_QUEUE:-timetable-section-events}" \
  TERM_START_DATE="${TERM_START_DATE:-2026-09-20}" \
  TERM_END_DATE="${TERM_END_DATE:-2026-12-24}" \
  TIMEZONE="${TIMEZONE:-Africa/Cairo}" \
  node src/server.js

# 3. Compare & Share (:3003)
start_service "3003:mohab" "$ROOT_DIR/mohab" \
  env PORT="${MOHAB_PORT:-3003}" \
  TIMETABLE_SERVICE_URL="${TIMETABLE_SERVICE_URL:-http://127.0.0.1:3002}" \
  CATALOGUE_JWKS_URL="${CATALOGUE_JWKS_URL:-http://127.0.0.1:3000/.well-known/jwks.json}" \
  SHARE_TABLE_NAME="${SHARE_TABLE_NAME:-share_links}" \
  AWS_REGION="${AWS_REGION:-us-east-1}" \
  DYNAMODB_ENDPOINT="${DYNAMODB_ENDPOINT:-http://127.0.0.1:4566}" \
  AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" \
  AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}" \
  TERM_START_DATE="${TERM_START_DATE:-2026-09-20}" \
  TERM_END_DATE="${TERM_END_DATE:-2026-12-24}" \
  TIMEZONE="${TIMEZONE:-Africa/Cairo}" \
  node src/server.js

sleep 1.2

# 4. Reverse proxy (:8080)
if [[ -f "$ROOT_DIR/local-proxy.js" ]]; then
  start_service "8080:proxy" "$ROOT_DIR" \
    env PROXY_PORT="${PROXY_PORT:-8080}" \
    node local-proxy.js
else
  echo "[launcher] Warning: $ROOT_DIR/local-proxy.js not found." >&2
fi

echo "[launcher] Press Ctrl+C once to stop everything."
wait
