# Requirements Document

## Introduction

This feature adds production-grade Docker containerization to the `betterstack1` Turborepo + pnpm monorepo. The monorepo contains four deployable applications — `web` (Next.js frontend), `backend` (Express REST API), `worker` (Redis Streams consumer), and `pusher` (Redis Streams producer/scheduler) — plus four shared packages: `@repo/store` (Prisma/NeonDB client), `@repo/redisstream` (Redis client wrapper), `@repo/ui` (React component library, source-only), and `@repo/typescript-config` (shared TypeScript config).

Each application receives its own Dockerfile using multi-stage builds, `turbo prune` for dependency isolation, Node 20 Alpine base images, and non-root runtime users. The resulting images are optimised for minimal size, aggressive Docker layer caching, and Kubernetes deployment. Redis runs as an external Docker container; PostgreSQL is provided by NeonDB (serverless, external). No `docker-compose` file is produced.

## Glossary

- **Build_System**: The Turborepo + pnpm toolchain responsible for building all packages and applications.
- **Pruned_Workspace**: The subset of the monorepo produced by `turbo prune --docker` that contains only the packages and lock-file entries required by a specific application.
- **Builder_Stage**: The intermediate Docker stage that installs all dependencies and compiles TypeScript source to JavaScript.
- **Runner_Stage**: The final Docker stage that contains only the production runtime artefacts and no build tooling.
- **Shared_Package**: Any package under `packages/` that is consumed by one or more applications via `workspace:*` dependencies (`@repo/store`, `@repo/redisstream`, `@repo/ui`, `@repo/typescript-config`).
- **Prisma_Client**: The generated TypeScript/JavaScript database client produced by `prisma generate` from the schema in `packages/store`.
- **Redis_Stream**: The Redis data structure used as a message queue between the `pusher` and `worker` applications.
- **REGION_ID**: An environment variable that identifies the geographic region a `worker` instance serves.
- **WORKER_ID**: An environment variable that uniquely identifies a `worker` replica within a consumer group scoped to a given `REGION_ID`.
- **NODE_ENV**: The Node.js environment variable set to `production` in all Runner_Stages.
- **Frozen_Lockfile**: A `pnpm install` flag (`--frozen-lockfile`) that prevents lock-file mutation and ensures reproducible installs.
- **Non_Root_User**: A Linux user account with UID/GID 1001, no login shell, and no password, named `nodejs`, created inside the container to run the application process without root privileges.
- **Dockerignore**: A `.dockerignore` file at the monorepo root that prevents unnecessary files from being sent to the Docker build context.
- **Layer_Cache**: Docker's mechanism for reusing unchanged image layers across builds, exploited by ordering Dockerfile instructions from least-frequently-changed to most-frequently-changed.

---

## Requirements

### Requirement 1: Monorepo Build Context and .dockerignore

**User Story:** As a platform engineer, I want a `.dockerignore` file at the monorepo root, so that Docker build contexts are small, fast, and free of secrets or generated artefacts.

#### Acceptance Criteria

1. THE Build_System SHALL include a `.dockerignore` file at the repository root that excludes `node_modules`, `.git`, `.turbo`, `dist`, `.next`, `*.log`, `.env*`, and all `*.pid` files from the Docker build context.
2. WHEN a Docker image is built for any application, THE Build_System SHALL send only files not matched by the exclusion patterns in criterion 1 to the Docker daemon (i.e., source files, configuration files, and `pnpm-lock.yaml`).
3. THE `.dockerignore` file SHALL exclude the `.codex-runtime` directory from the build context.

---

### Requirement 2: turbo prune — Dependency Isolation per Application

**User Story:** As a platform engineer, I want each application's Dockerfile to use `turbo prune`, so that only the packages and lock-file entries relevant to that application are installed, keeping images small and builds fast.

#### Acceptance Criteria

1. WHEN a Dockerfile for any application (`web`, `backend`, `worker`, or `pusher`) is built, THE Build_System SHALL execute `turbo prune --filter=<app-name> --docker` before any dependency installation step, where `<app-name>` is the exact `name` field from the application's `package.json` (`web`, `backend`, `worker`, or `pusher`).
2. THE Pruned_Workspace SHALL contain an `out/json/` directory with a pruned `package.json` for each package in the dependency graph of the target application, and an `out/full/` directory with the full source of all those packages.
3. THE Pruned_Workspace SHALL contain an `out/pnpm-lock.yaml` that includes only the lock-file entries for the pruned dependency graph.
4. IF `turbo prune` exits with a non-zero code, THE Build_System SHALL fail the Docker build immediately with an error message.

---

### Requirement 3: Multi-Stage Docker Builds

**User Story:** As a platform engineer, I want every Dockerfile to use multi-stage builds, so that build tooling, TypeScript compiler, and development dependencies are excluded from the final production image.

#### Acceptance Criteria

1. THE Build_System SHALL implement a minimum of three named stages in each Dockerfile: `base`, `builder`, and `runner`.
2. THE `base` stage SHALL use `node:20-alpine` as the base image and install `libc6-compat` to support native Node.js addons on Alpine.
3. THE Builder_Stage SHALL install all workspace dependencies (including `devDependencies`) using `pnpm install --frozen-lockfile` against the Pruned_Workspace produced by `turbo prune --docker`.
4. THE Builder_Stage SHALL compile all TypeScript source to JavaScript by running `turbo run build --filter=<app-name>` for the target application.
5. THE Runner_Stage SHALL copy only the compiled JavaScript output (`dist/` or `.next/standalone`) and the production `node_modules` from the Builder_Stage; it SHALL NOT contain `.ts` source files, `devDependencies`, or the TypeScript compiler binary.
6. THE Runner_Stage SHALL set `NODE_ENV=production` via an `ENV` instruction.

---

### Requirement 4: pnpm and Turborepo Installation in Builder Stage

**User Story:** As a platform engineer, I want pnpm and turbo installed consistently in every Builder_Stage, so that workspace installs and pruning work correctly inside Docker.

#### Acceptance Criteria

1. THE Builder_Stage SHALL enable pnpm via `corepack enable && corepack prepare pnpm@9.0.0 --activate` to match the `packageManager` field in the root `package.json`.
2. THE Builder_Stage SHALL install `turbo` globally at the exact version declared in the root `package.json` `devDependencies` (currently `2.9.6`) via `pnpm add -g turbo@2.9.6` before executing `turbo prune`.
3. WHEN pnpm installs workspace dependencies, THE Build_System SHALL use `--frozen-lockfile` to prevent lock-file mutation.
4. THE Builder_Stage SHALL copy `pnpm-workspace.yaml`, the root `package.json`, and `pnpm-lock.yaml` before copying application source, so that the dependency installation layer is cached independently of source changes.

---

### Requirement 5: Shared Package Support — @repo/store (Prisma)

**User Story:** As a platform engineer, I want the `@repo/store` package to be correctly built and its Prisma client generated inside Docker, so that applications depending on it can connect to NeonDB at runtime.

#### Acceptance Criteria

1. WHEN building an image for `backend`, `worker`, or `pusher`, THE Builder_Stage SHALL run `prisma generate` and confirm it exits with code 0 before invoking `tsc` compilation for the application.
2. THE Builder_Stage SHALL copy the Prisma schema file from `packages/store/prisma/schema.prisma` into the image before running `prisma generate`, with the output directed to `packages/store/generated/prisma` as declared in the schema's `output` directive.
3. THE Runner_Stage SHALL include the generated Prisma client artefacts from the Builder_Stage — including the native query engine binary (`.so.node`) — so that the application can connect to NeonDB without regenerating the client at runtime.
4. IF the `DATABASE_URL` environment variable is absent when the `backend`, `worker`, or `pusher` container starts, THE container SHALL exit with a non-zero code and emit an error message identifying `DATABASE_URL` as the missing variable.
5. THE Builder_Stage and Runner_Stage SHALL use the same Linux base image variant (both `node:20-alpine`) so that the generated native Prisma query engine binary is compatible with the runner OS and OpenSSL version.

---

### Requirement 6: Shared Package Support — @repo/ui (Source-Only)

**User Story:** As a platform engineer, I want the `@repo/ui` package to be handled correctly in the `web` image, so that Next.js can resolve and compile its React components.

#### Acceptance Criteria

1. WHEN building the `web` image, THE Pruned_Workspace SHALL include the `packages/ui/src/` directory with all `.tsx` source files, because `@repo/ui` has no separate build step and exports directly from source.
2. THE `web` `next.config.js` SHALL declare `@repo/ui` in the `transpilePackages` array so that Next.js compiles its TypeScript source during `next build`.
3. THE Runner_Stage for `web` SHALL copy the `.next/standalone` output directory from the Builder_Stage; this directory SHALL contain all transpiled `@repo/ui` component code bundled by Next.js.

---

### Requirement 7: web — Next.js Production Image

**User Story:** As a platform engineer, I want a production Docker image for the `web` application, so that the Next.js frontend can be deployed as a standalone container.

#### Acceptance Criteria

1. THE `web` Dockerfile SHALL produce a Runner_Stage image whose `CMD` runs `node server.js` with the working directory set to `/app/.next/standalone`.
2. THE `web` Runner_Stage SHALL listen on port `3000` and the Dockerfile SHALL declare `EXPOSE 3000`.
3. THE `web` `next.config.js` SHALL set `output: 'standalone'` so that Next.js emits a self-contained server bundle that does not require the full `node_modules` tree at runtime.
4. THE Runner_Stage for `web` SHALL copy `.next/standalone` from the Builder_Stage to `/app/.next/standalone`, then copy `.next/static` into `/app/.next/standalone/.next/static`, and copy `public/` into `/app/.next/standalone/public`, so that static assets are served correctly.
5. THE Runner_Stage for `web` SHALL declare `BACKEND_URL` as an available environment variable via an `ENV` instruction (with an empty default), so that the value can be overridden at runtime via Kubernetes ConfigMap or `docker run -e`.
6. THE Runner_Stage for `web` SHALL run as a Non_Root_User with UID 1001.
7. THE Builder_Stage for `web` SHALL run `turbo run build --filter=web` to produce the `.next/standalone` output before the Runner_Stage copies it.

---

### Requirement 8: backend — Express REST API Image

**User Story:** As a platform engineer, I want a production Docker image for the `backend` application, so that the Express REST API can be deployed as a scalable container.

#### Acceptance Criteria

1. THE `backend` Dockerfile SHALL produce a Runner_Stage image whose `CMD` runs `node dist/index.js` with the working directory set to `/app`.
2. THE `backend` Runner_Stage SHALL declare `EXPOSE 3001`; the application SHALL listen on `process.env.PORT` when set, and fall back to port `3001` when `PORT` is not set.
3. THE Runner_Stage for `backend` SHALL require `DATABASE_URL` and `JWT_SECRET` to be injected at runtime; `PORT` is optional with a default of `3001`.
4. THE Runner_Stage for `backend` SHALL NOT contain any `.env` file at any path reachable by the application process (including `apps/backend/.env` and any path resolved by `loadLocalEnv()`); all secrets SHALL be injected via environment variables.
5. THE Runner_Stage for `backend` SHALL run as a Non_Root_User with UID 1001, and the `dist/` directory SHALL be owned by UID 1001 with read and execute permissions.

---

### Requirement 9: worker — Redis Streams Consumer Image

**User Story:** As a platform engineer, I want a production Docker image for the `worker` application, so that Redis Streams consumer replicas can be deployed and autoscaled independently.

#### Acceptance Criteria

1. THE `worker` Dockerfile SHALL produce a Runner_Stage image whose `CMD` runs `node dist/index.js` with the working directory set to `/app`, using `node:20-alpine` as the base image.
2. THE Runner_Stage for `worker` SHALL NOT include an `EXPOSE` instruction, because the worker only consumes from a Redis Stream and writes to NeonDB.
3. THE Runner_Stage for `worker` SHALL require the following environment variables to be injected at runtime: `REDIS_URL`, `DATABASE_URL`, `REGION_ID`, and `WORKER_ID`.
4. IF `REGION_ID` or `WORKER_ID` is absent at container startup, THE worker process SHALL exit with a non-zero code and emit an error message identifying which variable is missing.
5. THE Runner_Stage for `worker` SHALL run as a Non_Root_User with UID 1001.
6. WHERE multiple `worker` replicas are deployed in Kubernetes, EACH replica SHALL receive a `WORKER_ID` value that is unique within the same `REGION_ID` consumer group, injected via a Kubernetes Downward API field or ConfigMap.

---

### Requirement 10: pusher — Redis Streams Producer/Scheduler Image

**User Story:** As a platform engineer, I want a production Docker image for the `pusher` application, so that the website-URL scheduler can be deployed as a single-replica container.

#### Acceptance Criteria

1. THE `pusher` Builder_Stage SHALL install pnpm workspace dependencies and compile TypeScript, producing `dist/index.js` in the `apps/pusher` directory.
2. THE `pusher` Runner_Stage SHALL use `node:20-alpine` as the base image and its `CMD` SHALL run `node dist/index.js` with the working directory set to `/app`.
3. THE Runner_Stage for `pusher` SHALL NOT include an `EXPOSE` instruction, because the pusher only reads from NeonDB and writes to a Redis Stream.
4. IF `REDIS_URL` or `DATABASE_URL` is absent at container startup, THE pusher process SHALL exit with a non-zero code and emit an error message identifying the missing variable.
5. THE Runner_Stage for `pusher` SHALL run as a Non_Root_User with UID 1001.

---

### Requirement 11: Non-Root User and Security Hardening

**User Story:** As a security engineer, I want all container processes to run as a non-root user, so that a container breakout does not grant root access to the host.

#### Acceptance Criteria

1. THE Build_System SHALL create a system user and group named `nodejs` with UID 1001 and GID 1001, no login shell (`/sbin/nologin`), and no password in every Runner_Stage; verification: `id nodejs` inside the container returns `uid=1001(nodejs) gid=1001(nodejs)`.
2. WHEN the Runner_Stage copies artefacts from the Builder_Stage, THE resulting files SHALL be owned by UID 1001 and GID 1001; verification: `stat` on any copied path shows owner UID 1001.
3. WHEN a Dockerfile defines a Runner_Stage, THE Runner_Stage SHALL include a `USER nodejs` instruction placed before the `CMD` instruction, so that the effective user for the container process is `nodejs` (UID 1001).
4. THE Runner_Stage SHALL NOT run any process as UID 0, and SHALL NOT install setuid binaries or grant additional Linux capabilities to the container process.

---

### Requirement 12: Docker Layer Caching Optimisation

**User Story:** As a platform engineer, I want Dockerfiles to be structured to maximise Docker layer cache reuse, so that incremental builds after source-only changes complete in the shortest possible time.

#### Acceptance Criteria

1. THE Build_System SHALL, in each application's Dockerfile, first copy `package.json` files and `pnpm-lock.yaml` (from `out/json/`) and run `pnpm install`, then in a separate `RUN` instruction copy the full source (from `out/full/`) and run the build, so that the install layer is ordered before the source layer.
2. THE Build_System SHALL place the `pnpm install` step and the `turbo build` step in separate `RUN` instructions in every Dockerfile, so that a source-only change does not re-execute dependency installation.
3. THE Build_System SHALL use the `out/json/` output of `turbo prune` for the dependency installation layer and the `out/full/` output for the source compilation layer.
4. IF only source files change between two consecutive builds (i.e., `out/json/` and `pnpm-lock.yaml` are unchanged), THEN the Docker build SHALL report a cache hit for the `pnpm install` layer and not re-execute it, evidenced by `CACHED` in the build output.
5. IF any file in `out/json/` or `pnpm-lock.yaml` changes between two consecutive builds, THEN the Docker build SHALL re-execute the `pnpm install` layer and all subsequent layers.

---

### Requirement 13: Kubernetes Readiness

**User Story:** As a platform engineer, I want the container images to be designed for Kubernetes deployment, so that each service can be scaled, configured, and managed independently.

#### Acceptance Criteria

1. THE Runner_Stage for each application SHALL accept all configuration exclusively via environment variables, with no configuration baked into the image, so that a single image can be deployed to multiple environments by changing only the Kubernetes ConfigMap or Secret.
2. THE Runner_Stage for `worker` SHALL read `WORKER_ID` from the environment and use it as the Redis Stream consumer name; IF `WORKER_ID` is absent, THE container SHALL exit with a non-zero code and an error message identifying `WORKER_ID` as the missing variable.
3. THE Build_System SHALL document, for each application image, the name, required/optional status, and description of every environment variable the application reads, so that Kubernetes manifests can be authored without inspecting source code.
4. THE `web` Runner_Stage SHALL declare `EXPOSE 3000` and the `backend` Runner_Stage SHALL declare `EXPOSE 3001`, so that Kubernetes `containerPort` declarations can reference them.
5. WHEN a container process exits with a non-zero code, THE container SHALL propagate that exit code unmodified so that Kubernetes can detect the failure via its default exit-code-based liveness mechanism.
6. IF any required environment variable (`DATABASE_URL`, `REDIS_URL`, `REGION_ID`, `WORKER_ID`, `JWT_SECRET`) is absent at startup for the application that requires it, THE container SHALL exit with a non-zero code and emit an error message identifying the missing variable by name.

---

### Requirement 14: Build and Run Command Documentation

**User Story:** As a developer, I want documented `docker build` and `docker run` commands for each application, so that I can build and test images locally without guessing the correct flags.

#### Acceptance Criteria

1. THE Build_System SHALL document a `docker build` command for each application specifying `--file apps/<app>/Dockerfile` and `.` (monorepo root) as the build context: `web` → `apps/web/Dockerfile`, `backend` → `apps/backend/Dockerfile`, `worker` → `apps/worker/Dockerfile`, `pusher` → `apps/pusher/Dockerfile`.
2. THE Build_System SHALL document a `docker run` command for each application that includes: for `web` — `-e BACKEND_URL -p 3000:3000`; for `backend` — `-e DATABASE_URL -e JWT_SECRET [-e PORT] -p 3001:3001`; for `worker` — `-e REDIS_URL -e DATABASE_URL -e REGION_ID -e WORKER_ID` (no `-p`); for `pusher` — `-e REDIS_URL -e DATABASE_URL` (no `-p`).
3. THE Build_System SHALL document two normative image tag conventions: (a) `<app-name>:latest` for local development builds; (b) `<app-name>:<git-sha>` (7-character short SHA) for CI/CD and production deployments.

---

### Requirement 15: Turbo Build Output Configuration

**User Story:** As a platform engineer, I want the `turbo.json` build pipeline to correctly declare outputs for all applications, so that `turbo prune` and Docker layer caching work correctly for compiled TypeScript apps.

#### Acceptance Criteria

1. THE `turbo.json` SHALL declare `dist/**` as a build output via per-package task overrides (`backend#build`, `worker#build`, `pusher#build`) so that the `dist/**` output is scoped only to those apps and does not override the `.next/**` output for `web`.
2. WHEN `turbo run build` is executed, THE Build_System SHALL build Shared_Packages before the application that depends on them, as enforced by the `"dependsOn": ["^build"]` pipeline declaration in `turbo.json`.
3. IF an application imports `@repo/store/client`, THEN that application's `build` task SHALL declare `db:generate` in its `dependsOn` array in `turbo.json`, where `db:generate` is a Turbo task defined in `packages/store/package.json` that runs `prisma generate`.
