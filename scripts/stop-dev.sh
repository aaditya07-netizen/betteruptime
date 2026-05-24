#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PID_DIR="$ROOT/.codex-runtime/pids"

if [[ ! -d "$PID_DIR" ]]; then
  echo "No BetterStack dev processes found."
  exit 0
fi

stopped=0
for pid_file in "$PID_DIR"/*.pid; do
  [[ -e "$pid_file" ]] || continue

  name="$(basename "$pid_file" .pid)"
  pid="$(cat "$pid_file")"

  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    echo "Stopped $name ($pid)"
    stopped=1
  fi

  rm -f "$pid_file"
done

while read -r pid; do
  [[ -n "$pid" ]] || continue
  pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
  if [[ -n "$pgid" ]]; then
    kill -- "-$pgid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    echo "Stopped web child process ($pid)"
    stopped=1
  fi
done < <(pgrep -f "$ROOT/apps/web/.+next" || true)

if [[ "$stopped" == "0" ]]; then
  echo "No BetterStack dev processes were running."
fi
