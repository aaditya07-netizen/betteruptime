#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

source ~/.nvm/nvm.sh 2>/dev/null || true
nvm use 23 --silent 2>/dev/null || true

services=(web backend pusher worker)

for service in "${services[@]}"; do
  echo "==> Pruning workspace for ${service}"
  rm -rf out
  corepack pnpm exec turbo prune "$service" --docker

  echo "==> Building betterstack1-${service}:local"
  docker build --progress=plain \
    -f "apps/${service}/Dockerfile" \
    -t "betterstack1-${service}:local" \
    .
done

rm -rf out
echo "Built BetterStack images: ${services[*]}"
