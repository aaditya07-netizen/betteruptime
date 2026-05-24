# syntax=docker/dockerfile:1

# ─── Stage 1: base ────────────────────────────────────────────────────────────
# Shared base for both builder and runner. node:20-alpine keeps the image small.
# libc6-compat is required for native Node.js addons (Prisma query engine binary)
# on Alpine (musl libc). Both stages use the same base so the Prisma .so.node
# binary generated in the builder is binary-compatible with the runner OS.
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat

# ─── Stage 2: builder ─────────────────────────────────────────────────────────
# Installs ALL dependencies (including devDependencies), generates the Prisma
# client, and compiles TypeScript to JavaScript. Never shipped to production.
FROM base AS builder
WORKDIR /app

# Enable pnpm via corepack (matches "packageManager": "pnpm@9.0.0" in root package.json)
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Install turbo globally at the exact version pinned in root devDependencies.
RUN npm install -g turbo@2.9.6

# ── Layer-cache optimisation: copy manifests BEFORE source ──────────────────
# out/json/ contains only package.json files (no source). Copying this first
# means the pnpm install layer is only invalidated when dependencies change,
# not on every source edit.
COPY out/json/ .
COPY out/pnpm-lock.yaml ./pnpm-lock.yaml

# Install all dependencies. --frozen-lockfile ensures reproducible installs.
RUN pnpm install --frozen-lockfile

# ── Now copy the full source (invalidates on any source change) ──────────────
COPY out/full/ .

# Generate the Prisma client BEFORE TypeScript compilation.
# The native query engine binary is built for linux-musl (Alpine) here and
# must match the runner stage OS — both use node:20-alpine so they match.
RUN pnpm --filter=@repo/store exec prisma generate --schema=prisma/schema.prisma

# Build the worker. turbo respects dependsOn so @repo/store and @repo/redisstream
# build before the worker.
RUN pnpm exec turbo run build --filter=worker

# ─── Stage 3: runner ──────────────────────────────────────────────────────────
# Minimal production image. Contains only compiled JS, production node_modules,
# and the Prisma generated client. No TypeScript source, no devDependencies.
FROM base AS runner
WORKDIR /app

# Create a non-root system user/group (UID/GID 1001) named nodejs.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs --no-create-home nodejs

ENV NODE_ENV=production

# Copy compiled worker application code.
COPY --chown=nodejs:nodejs --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --chown=nodejs:nodejs --from=builder /app/apps/worker/package.json ./apps/worker/package.json
COPY --chown=nodejs:nodejs --from=builder /app/apps/worker/node_modules ./apps/worker/node_modules

# Copy compiled @repo/store package (Prisma client wrapper).
COPY --chown=nodejs:nodejs --from=builder /app/packages/store/dist ./packages/store/dist
COPY --chown=nodejs:nodejs --from=builder /app/packages/store/package.json ./packages/store/package.json

# Copy the generated Prisma client including the native .so.node query engine.
COPY --chown=nodejs:nodejs --from=builder /app/packages/store/generated ./packages/store/generated

# Copy compiled @repo/redisstream package (Redis Streams helpers).
COPY --chown=nodejs:nodejs --from=builder /app/packages/redisstream/dist ./packages/redisstream/dist
COPY --chown=nodejs:nodejs --from=builder /app/packages/redisstream/package.json ./packages/redisstream/package.json
COPY --chown=nodejs:nodejs --from=builder /app/packages/redisstream/node_modules ./packages/redisstream/node_modules

# Copy the full node_modules from the builder (includes pnpm virtual store with
# workspace symlinks). The pruned workspace ensures only relevant packages are here.
COPY --chown=nodejs:nodejs --from=builder /app/node_modules ./node_modules

# The worker is a background consumer — it does NOT expose any network port.
# It reads from a Redis Stream and writes results to NeonDB.

# Drop to non-root user before starting the process.
USER nodejs

# Set working directory to where dist/index.js lives.
WORKDIR /app/apps/worker

# Start the worker process. Exec-form makes node PID 1 — signals and exit codes
# propagate unmodified to Kubernetes liveness probes.
# Required env vars at runtime: DATABASE_URL, REDIS_URL, REGION_ID, WORKER_ID
# Each Kubernetes replica must receive a unique WORKER_ID within its REGION_ID
# consumer group (inject via Downward API or ConfigMap).
CMD ["node", "dist/index.js"]
