#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$ROOT/.codex-runtime"
DOCKER_ENV="$RUNTIME_DIR/docker.env"

mkdir -p "$RUNTIME_DIR"

set -a
. "$ROOT/packages/store/.env"
set +a

if [[ "$DATABASE_URL" == *".neon.tech"* ]]; then
  if ! command -v psql >/dev/null 2>&1; then
    echo "psql is required to select a reachable Neon endpoint from this WSL environment." >&2
    exit 1
  fi

  endpoint_host="$(printf "%s" "$DATABASE_URL" | sed -E 's#^[^@]+@([^/:?]+).*$#\1#')"
  endpoint_host="${endpoint_host/-pooler/}"
  endpoint_id="${endpoint_host%%.*}"

  base_database_url="${DATABASE_URL/-pooler/}"
  base_database_url="${base_database_url/&channel_binding=require/}"
  base_database_url="${base_database_url/?channel_binding=require&/?}"
  base_database_url="${base_database_url/?channel_binding=require/}"

  routed_database_url=""
  while read -r endpoint_ip; do
    [[ -n "$endpoint_ip" ]] || continue
    candidate_url="${base_database_url/$endpoint_host/$endpoint_ip}"
    candidate_url="${candidate_url}&connect_timeout=10&options=endpoint%3D${endpoint_id}"

    if timeout 15 psql "$candidate_url" -Atc "select 1" >/dev/null 2>&1; then
      routed_database_url="$candidate_url"
      break
    fi
  done < <(getent ahostsv4 "$endpoint_host" | awk '{print $1}' | sort -u)

  if [[ -z "$routed_database_url" ]]; then
    echo "Could not find a reachable Neon IPv4 address for $endpoint_host." >&2
    exit 1
  fi

  DATABASE_URL="$routed_database_url"
fi

cat > "$DOCKER_ENV" <<EOF
DATABASE_URL=${DATABASE_URL}
NODE_OPTIONS=--dns-result-order=ipv4first
EOF

cd "$ROOT"
docker compose up -d
