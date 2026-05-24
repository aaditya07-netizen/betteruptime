#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.codex-runtime/logs"
PID_DIR="$ROOT/.codex-runtime/pids"

mkdir -p "$LOG_DIR" "$PID_DIR"

source ~/.nvm/nvm.sh 2>/dev/null || true
nvm use 23 --silent 2>/dev/null || true

stop_service() {
  local name="$1"
  local pid_file="$PID_DIR/$name.pid"

  if [[ -f "$pid_file" ]]; then
    local pid
    pid="$(cat "$pid_file")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      sleep 1
    fi
    rm -f "$pid_file"
  fi
}

stop_web_leftovers() {
  while read -r pid; do
    [[ -n "$pid" ]] || continue
    local pgid
    pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
    if [[ -n "$pgid" ]]; then
      kill -- "-$pgid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    fi
  done < <(pgrep -f "$ROOT/apps/web/.+next" || true)
}

start_service() {
  local name="$1"
  local dir="$2"
  shift 2

  stop_service "$name"

  (
    cd "$ROOT/$dir"
    setsid nohup "$@" >"$LOG_DIR/$name.log" 2>&1 </dev/null &
    echo $! >"$PID_DIR/$name.pid"
  )
}

ensure_redis() {
  if timeout 2 bash -c "</dev/tcp/127.0.0.1/6379" 2>/dev/null; then
    return
  fi

  if ! command -v docker >/dev/null 2>&1; then
    echo "Redis is not running on localhost:6379 and Docker is not available." >&2
    exit 1
  fi

  if docker ps --format '{{.Names}}' | grep -qx 'redis-betteruptime'; then
    return
  fi

  docker start redis-betteruptime >/dev/null 2>&1 || \
    docker run -d --name redis-betteruptime -p 6379:6379 redis >/dev/null
}

load_database_env() {
  set -a
  . "$ROOT/packages/store/.env"
  set +a

  if [[ "$DATABASE_URL" != *".neon.tech"* ]]; then
    export DATABASE_URL
    return
  fi

  if ! command -v psql >/dev/null 2>&1; then
    echo "psql is required to select a reachable Neon endpoint from this WSL environment." >&2
    exit 1
  fi

  local endpoint_host endpoint_id base_database_url endpoint_ip candidate_url
  endpoint_host="$(printf "%s" "$DATABASE_URL" | sed -E 's#^[^@]+@([^/:?]+).*$#\1#')"
  endpoint_host="${endpoint_host/-pooler/}"
  endpoint_id="${endpoint_host%%.*}"

  base_database_url="${DATABASE_URL/-pooler/}"
  base_database_url="${base_database_url/&channel_binding=require/}"
  base_database_url="${base_database_url/?channel_binding=require&/?}"
  base_database_url="${base_database_url/?channel_binding=require/}"

  DATABASE_URL=""
  while read -r endpoint_ip; do
    [[ -n "$endpoint_ip" ]] || continue
    candidate_url="${base_database_url/$endpoint_host/$endpoint_ip}"
    candidate_url="${candidate_url}&connect_timeout=10&options=endpoint%3D${endpoint_id}"

    if timeout 15 psql "$candidate_url" -Atc "select 1" >/dev/null 2>&1; then
      DATABASE_URL="$candidate_url"
      break
    fi
  done < <(getent ahostsv4 "$endpoint_host" | awk '{print $1}' | sort -u)

  if [[ -z "$DATABASE_URL" ]]; then
    echo "Could not find a reachable Neon IPv4 address for $endpoint_host." >&2
    exit 1
  fi

  export DATABASE_URL
}

ensure_redis
load_database_env

export NODE_OPTIONS="${NODE_OPTIONS:-"--dns-result-order=ipv4first"}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export BACKEND_URL="${BACKEND_URL:-http://localhost:3001}"

start_service backend apps/backend node dist/index.js
start_service pusher apps/pusher node dist/index.js
start_service worker apps/worker node dist/index.js
stop_web_leftovers
start_service web apps/web corepack pnpm dev --hostname 0.0.0.0

echo "Started BetterStack services:"
for name in backend pusher worker web; do
  printf "  %s pid=%s log=%s\n" "$name" "$(cat "$PID_DIR/$name.pid")" "$LOG_DIR/$name.log"
done
echo
echo "Web:     http://localhost:3000"
echo "Backend: http://localhost:3001"
