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
# prisma generate produces packages/store/generated/prisma/ including the
# native query engine binary (.so.node) linked against musl/OpenSSL on Alpine.
# Must run after pnpm install (needs @prisma/client) and before tsc (app imports it).
RUN pnpm --filter=@repo/store exec prisma generate --schema=prisma/schema.prisma

# Build the backend. turbo respects dependsOn so @repo/store builds first.
RUN pnpm exec turbo run build --filter=backend

# ─── Stage 3: runner ──────────────────────────────────────────────────────────
# Minimal production image. Contains only compiled JS, production node_modules,
# and the Prisma generated client. No TypeScript source, no devDependencies.
FROM base AS runner
WORKDIR /app

# Create a non-root system user/group (UID/GID 1001) named nodejs.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs --no-create-home nodejs

ENV NODE_ENV=production

# Copy compiled backend application code.
COPY --chown=nodejs:nodejs --from=builder /app/apps/backend/dist ./apps/backend/dist
COPY --chown=nodejs:nodejs --from=builder /app/apps/backend/package.json ./apps/backend/package.json
COPY --chown=nodejs:nodejs --from=builder /app/apps/backend/node_modules ./apps/backend/node_modules

# Copy compiled @repo/store package (Prisma client wrapper).
COPY --chown=nodejs:nodejs --from=builder /app/packages/store/dist ./packages/store/dist
COPY --chown=nodejs:nodejs --from=builder /app/packages/store/package.json ./packages/store/package.json

# Copy the generated Prisma client including the native .so.node query engine.
# This must be present at runtime — the app cannot connect to NeonDB without it.
COPY --chown=nodejs:nodejs --from=builder /app/packages/store/generated ./packages/store/generated

# Copy the full node_modules from the builder (includes pnpm virtual store with
# workspace symlinks). The pruned workspace ensures only relevant packages are here.
COPY --chown=nodejs:nodejs --from=builder /app/node_modules ./node_modules

# Expose the API port. Kubernetes containerPort declarations reference this.
# The app listens on process.env.PORT || 3001.
EXPOSE 3001

# Drop to non-root user before starting the process.
USER nodejs

# Set working directory to where dist/index.js lives.
WORKDIR /app/apps/backend

# Start the Express server. Exec-form makes node PID 1 — signals and exit codes
# propagate unmodified to Kubernetes liveness probes.
# Required env vars at runtime: DATABASE_URL, JWT_SECRET
# Optional: PORT (defaults to 3001)
CMD ["node", "dist/index.js"]
