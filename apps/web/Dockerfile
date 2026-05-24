# syntax=docker/dockerfile:1

# ─── Stage 1: base ────────────────────────────────────────────────────────────
# Shared base for both builder and runner. node:20-alpine keeps the image small.
# libc6-compat is required for native Node.js addons (e.g. Prisma query engine)
# on Alpine (musl libc).
FROM node:20-alpine AS base
RUN apk add --no-cache libc6-compat

# ─── Stage 2: builder ─────────────────────────────────────────────────────────
# Installs ALL dependencies (including devDependencies) and compiles TypeScript.
# This stage is never shipped — only its artefacts are copied to the runner.
FROM base AS builder
WORKDIR /app

# Enable pnpm via corepack (matches "packageManager": "pnpm@9.0.0" in root package.json)
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate

# Install turbo globally at the exact version pinned in root devDependencies.
# turbo prune --docker is run on the HOST before docker build, producing out/.
# Inside Docker we only need turbo for `turbo run build`.
RUN npm install -g turbo@2.9.6

# ── Layer-cache optimisation: copy manifests BEFORE source ──────────────────
# out/json/ contains only package.json files (no source). Copying this first
# means the pnpm install layer is only invalidated when dependencies change,
# not on every source edit.
COPY out/json/ .
COPY out/pnpm-lock.yaml ./pnpm-lock.yaml

# Install dependencies. --frozen-lockfile prevents lock-file mutation and
# ensures the install is reproducible.
RUN pnpm install --frozen-lockfile

# ── Now copy the full source (invalidates on any source change) ──────────────
# out/full/ contains the complete source of all packages in the pruned graph.
COPY out/full/ .

# Build the web app. turbo respects dependsOn so shared packages build first.
# next.config.js has output:'standalone' so .next/standalone is emitted.
RUN pnpm exec turbo run build --filter=web

# ─── Stage 3: runner ──────────────────────────────────────────────────────────
# Minimal production image. Contains only the compiled artefacts — no TypeScript
# source, no devDependencies, no build tooling.
FROM base AS runner
WORKDIR /app

# Create a non-root system user/group (UID/GID 1001) named nodejs.
# Running as non-root limits blast radius if the container is compromised.
RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 --ingroup nodejs --no-create-home nodejs

# Set production environment — disables Next.js dev overlays, enables optimisations.
ENV NODE_ENV=production

# BACKEND_URL is read by Next.js API routes at runtime. Default is empty so the
# image can be deployed to any environment by injecting the correct value via
# Kubernetes ConfigMap or `docker run -e BACKEND_URL=...`.
ENV BACKEND_URL=""

# Copy the standalone server bundle from the builder.
# .next/standalone is a self-contained directory with a minimal node_modules tree
# — it does NOT require the full workspace node_modules at runtime.
COPY --chown=nodejs:nodejs --from=builder /app/apps/web/.next/standalone ./

# Copy static assets into the location the standalone server expects them.
# Without this, Next.js serves 404 for all /_next/static/* requests.
COPY --chown=nodejs:nodejs --from=builder /app/apps/web/.next/static ./apps/web/.next/static

# Copy public/ assets (favicon, images, etc.)
COPY --chown=nodejs:nodejs --from=builder /app/apps/web/public ./apps/web/public

# Inform Kubernetes / Docker that the container listens on port 3000.
EXPOSE 3000

# Drop to non-root user before starting the process.
USER nodejs

# Start the Next.js standalone server. Exec-form (JSON array) makes node PID 1
# so it receives signals directly and exit codes propagate unmodified.
CMD ["node", "apps/web/server.js"]
