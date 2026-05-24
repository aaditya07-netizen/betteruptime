# Implementation Plan: docker-containerization

## Overview

Containerize all four monorepo applications (`web`, `backend`, `worker`, `pusher`) using multi-stage Dockerfiles, `turbo prune --docker` for dependency isolation, and Node 20 Alpine base images. The plan proceeds in dependency order: shared config changes first (turbo.json, package.json, next.config.js), then env-var guards in entrypoints, then Dockerfiles, then the `.dockerignore`, and finally property-based and unit tests.

## Tasks

- [x] 1. Update turbo.json with per-package build overrides and db:generate task
  - Add `db:generate` task with `cache: false` to `turbo.json`
  - Add `backend#build`, `worker#build`, `pusher#build` per-package overrides each with `"outputs": ["dist/**"]` and `"dependsOn": ["^build", "db:generate"]`
  - Leave the root `build` task's `outputs` (`.next/**`) unchanged so the web app is unaffected
  - _Requirements: 15.1, 15.2, 15.3_

- [x] 2. Add db:generate script to packages/store/package.json
  - Add `"db:generate": "prisma generate"` to the `scripts` section of `packages/store/package.json`
  - This is the Turbo task target referenced by `db:generate` in `turbo.json`
  - _Requirements: 15.3, 5.1_

- [x] 3. Update apps/web/next.config.js for standalone output and UI transpilation
  - Set `output: 'standalone'` in the `nextConfig` object
  - Add `transpilePackages: ['@repo/ui']` to the `nextConfig` object
  - _Requirements: 6.2, 7.3_

- [x] 4. Add startup env-var guards to application entrypoints
  - [x] 4.1 Add env-var guard to apps/backend/src/index.ts
    - After the existing `loadLocalEnv()` call, add a guard that checks `DATABASE_URL` and `JWT_SECRET`
    - For each missing variable: `console.error(\`Missing required environment variable: \${key}\`)` then `process.exit(1)`
    - Guard must run before any database connection or route registration
    - _Requirements: 5.4, 8.3, 13.6_

  - [x] 4.2 Add env-var guard and loadLocalEnv to apps/pusher/index.ts
    - Add a `loadLocalEnv()` function (same pattern as backend/worker) that reads `.env` silently
    - Call `loadLocalEnv()` before any imports that trigger Redis/DB connections
    - Add a guard that checks `DATABASE_URL` and `REDIS_URL`; exit with code 1 and name the missing variable
    - _Requirements: 5.4, 10.4, 13.6_

  - [x] 4.3 Strengthen env-var guard in apps/worker/index.ts
    - Replace the existing `throw new Error(...)` guards with `console.error(...)` + `process.exit(1)` pattern
    - Extend the guard to also check `DATABASE_URL` and `REDIS_URL` (currently only REGION_ID and WORKER_ID are checked)
    - _Requirements: 5.4, 9.3, 9.4, 13.2, 13.6_

- [x] 5. Create monorepo root .dockerignore
  - Create `.dockerignore` at the repository root
  - Exclude: `node_modules`, `.git`, `.turbo`, `dist`, `.next`, `*.log`, `.env*`, `*.pid`, `.codex-runtime`
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 6. Create apps/web/Dockerfile
  - [x] 6.1 Implement the web Dockerfile with three named stages: base, builder, runner
    - `base`: `FROM node:20-alpine`, `RUN apk add --no-cache libc6-compat`
    - `builder`: enable corepack, install `pnpm@9.0.0`, install `turbo@2.9.6` globally, copy `out/json/` + `out/pnpm-lock.yaml`, run `pnpm install --frozen-lockfile`, copy `out/full/`, run `turbo run build --filter=web`
    - `runner`: create `nodejs` group/user (GID/UID 1001), set `NODE_ENV=production`, set `ENV BACKEND_URL=""`, copy `.next/standalone`, `.next/static`, and `public/` with `--chown=nodejs:nodejs`, `EXPOSE 3000`, `USER nodejs`, set `WORKDIR /app/.next/standalone`, `CMD ["node", "server.js"]`
    - _Requirements: 2.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 6.1, 6.2, 6.3, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 11.1, 11.2, 11.3, 12.1, 12.2, 12.3, 13.1, 13.4_

  - [x]* 6.2 Write property test for web Dockerfile — Property 1: Layer cache ordering
    - **Property 1: Layer Cache Ordering**
    - Use `fast-check` to arbitrarily select the web Dockerfile and assert `COPY out/json/` line index < `COPY out/full/` line index, and `pnpm install` RUN line index < `turbo run build` RUN line index
    - Tag: `Feature: docker-containerization, Property 1: Layer cache ordering`
    - **Validates: Requirements 4.4, 12.1, 12.2, 12.3**

  - [x]* 6.3 Write property test for web Dockerfile — Property 2: Non-root user in runner stage
    - **Property 2: Non-Root User in Every Runner Stage**
    - Assert runner stage contains `addgroup --gid 1001 nodejs`, `adduser --uid 1001 nodejs`, and `USER nodejs` before `CMD`
    - Tag: `Feature: docker-containerization, Property 2: Non-root user in every runner stage`
    - **Validates: Requirements 11.1, 11.3**

  - [x]* 6.4 Write property test for web Dockerfile — Property 3: File ownership via --chown
    - **Property 3: File Ownership via --chown**
    - Assert every `COPY` instruction in the runner stage includes `--chown=nodejs:nodejs`
    - Tag: `Feature: docker-containerization, Property 3: File ownership via --chown`
    - **Validates: Requirements 11.2**

  - [x]* 6.5 Write property test for web Dockerfile — Property 5: Exec-form CMD
    - **Property 5: Exec-Form CMD for Exit Code Propagation**
    - Assert the `CMD` instruction in the runner stage is parsed as a JSON array (exec form), not a shell string
    - Tag: `Feature: docker-containerization, Property 5: Exec-form CMD for exit code propagation`
    - **Validates: Requirements 13.5**

- [x] 7. Create apps/backend/Dockerfile
  - [x] 7.1 Implement the backend Dockerfile with three named stages: base, builder, runner
    - `base`: `FROM node:20-alpine`, `RUN apk add --no-cache libc6-compat`
    - `builder`: enable corepack, install `pnpm@9.0.0`, install `turbo@2.9.6` globally, copy `out/json/` + `out/pnpm-lock.yaml`, run `pnpm install --frozen-lockfile`, copy `out/full/`, run `pnpm exec prisma generate --schema=packages/store/prisma/schema.prisma`, run `turbo run build --filter=backend`
    - `runner`: create `nodejs` group/user (GID/UID 1001), set `NODE_ENV=production`, copy `apps/backend/dist`, `packages/store/dist`, `packages/store/generated`, `node_modules` with `--chown=nodejs:nodejs`, `EXPOSE 3001`, `USER nodejs`, `CMD ["node", "dist/index.js"]`
    - _Requirements: 2.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.5, 8.1, 8.2, 8.3, 8.4, 8.5, 11.1, 11.2, 11.3, 12.1, 12.2, 12.3, 13.1, 13.4_

  - [x]* 7.2 Write property test for backend Dockerfile — Property 1: Layer cache ordering
    - **Property 1: Layer Cache Ordering**
    - Same assertion as 6.2 applied to the backend Dockerfile
    - Tag: `Feature: docker-containerization, Property 1: Layer cache ordering`
    - **Validates: Requirements 4.4, 12.1, 12.2, 12.3**

  - [x]* 7.3 Write property test for backend Dockerfile — Property 2: Non-root user in runner stage
    - **Property 2: Non-Root User in Every Runner Stage**
    - Same assertion as 6.3 applied to the backend Dockerfile
    - Tag: `Feature: docker-containerization, Property 2: Non-root user in every runner stage`
    - **Validates: Requirements 11.1, 11.3**

  - [x]* 7.4 Write property test for backend Dockerfile — Property 3: File ownership via --chown
    - **Property 3: File Ownership via --chown**
    - Same assertion as 6.4 applied to the backend Dockerfile
    - Tag: `Feature: docker-containerization, Property 3: File ownership via --chown`
    - **Validates: Requirements 11.2**

  - [x]* 7.5 Write property test for backend Dockerfile — Property 5: Exec-form CMD
    - **Property 5: Exec-Form CMD for Exit Code Propagation**
    - Same assertion as 6.5 applied to the backend Dockerfile
    - Tag: `Feature: docker-containerization, Property 5: Exec-form CMD for exit code propagation`
    - **Validates: Requirements 13.5**

- [x] 8. Create apps/worker/Dockerfile
  - [x] 8.1 Implement the worker Dockerfile with three named stages: base, builder, runner
    - `base`: `FROM node:20-alpine`, `RUN apk add --no-cache libc6-compat`
    - `builder`: enable corepack, install `pnpm@9.0.0`, install `turbo@2.9.6` globally, copy `out/json/` + `out/pnpm-lock.yaml`, run `pnpm install --frozen-lockfile`, copy `out/full/`, run `pnpm exec prisma generate --schema=packages/store/prisma/schema.prisma`, run `turbo run build --filter=worker`
    - `runner`: create `nodejs` group/user (GID/UID 1001), set `NODE_ENV=production`, copy `apps/worker/dist`, `packages/store/dist`, `packages/store/generated`, `packages/redisstream/dist`, `node_modules` with `--chown=nodejs:nodejs`, no `EXPOSE`, `USER nodejs`, `CMD ["node", "dist/index.js"]`
    - _Requirements: 2.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.5, 9.1, 9.2, 9.3, 9.5, 11.1, 11.2, 11.3, 12.1, 12.2, 12.3, 13.1_

  - [x]* 8.2 Write property test for worker Dockerfile — Property 1: Layer cache ordering
    - **Property 1: Layer Cache Ordering**
    - Same assertion as 6.2 applied to the worker Dockerfile
    - Tag: `Feature: docker-containerization, Property 1: Layer cache ordering`
    - **Validates: Requirements 4.4, 12.1, 12.2, 12.3**

  - [x]* 8.3 Write property test for worker Dockerfile — Property 2: Non-root user in runner stage
    - **Property 2: Non-Root User in Every Runner Stage**
    - Same assertion as 6.3 applied to the worker Dockerfile
    - Tag: `Feature: docker-containerization, Property 2: Non-root user in every runner stage`
    - **Validates: Requirements 11.1, 11.3**

  - [x]* 8.4 Write property test for worker Dockerfile — Property 3: File ownership via --chown
    - **Property 3: File Ownership via --chown**
    - Same assertion as 6.4 applied to the worker Dockerfile
    - Tag: `Feature: docker-containerization, Property 3: File ownership via --chown`
    - **Validates: Requirements 11.2**

  - [x]* 8.5 Write property test for worker Dockerfile — Property 5: Exec-form CMD
    - **Property 5: Exec-Form CMD for Exit Code Propagation**
    - Same assertion as 6.5 applied to the worker Dockerfile
    - Tag: `Feature: docker-containerization, Property 5: Exec-form CMD for exit code propagation`
    - **Validates: Requirements 13.5**

- [x] 9. Create apps/pusher/Dockerfile
  - [x] 9.1 Implement the pusher Dockerfile with three named stages: base, builder, runner
    - `base`: `FROM node:20-alpine`, `RUN apk add --no-cache libc6-compat`
    - `builder`: enable corepack, install `pnpm@9.0.0`, install `turbo@2.9.6` globally, copy `out/json/` + `out/pnpm-lock.yaml`, run `pnpm install --frozen-lockfile`, copy `out/full/`, run `pnpm exec prisma generate --schema=packages/store/prisma/schema.prisma`, run `turbo run build --filter=pusher`
    - `runner`: create `nodejs` group/user (GID/UID 1001), set `NODE_ENV=production`, copy `apps/pusher/dist`, `packages/store/dist`, `packages/store/generated`, `packages/redisstream/dist`, `node_modules` with `--chown=nodejs:nodejs`, no `EXPOSE`, `USER nodejs`, `CMD ["node", "dist/index.js"]`
    - _Requirements: 2.1, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.5, 10.1, 10.2, 10.3, 11.1, 11.2, 11.3, 12.1, 12.2, 12.3, 13.1_

  - [x]* 9.2 Write property test for pusher Dockerfile — Property 1: Layer cache ordering
    - **Property 1: Layer Cache Ordering**
    - Same assertion as 6.2 applied to the pusher Dockerfile
    - Tag: `Feature: docker-containerization, Property 1: Layer cache ordering`
    - **Validates: Requirements 4.4, 12.1, 12.2, 12.3**

  - [x]* 9.3 Write property test for pusher Dockerfile — Property 2: Non-root user in runner stage
    - **Property 2: Non-Root User in Every Runner Stage**
    - Same assertion as 6.3 applied to the pusher Dockerfile
    - Tag: `Feature: docker-containerization, Property 2: Non-root user in every runner stage`
    - **Validates: Requirements 11.1, 11.3**

  - [x]* 9.4 Write property test for pusher Dockerfile — Property 3: File ownership via --chown
    - **Property 3: File Ownership via --chown**
    - Same assertion as 6.4 applied to the pusher Dockerfile
    - Tag: `Feature: docker-containerization, Property 3: File ownership via --chown`
    - **Validates: Requirements 11.2**

  - [x]* 9.5 Write property test for pusher Dockerfile — Property 5: Exec-form CMD
    - **Property 5: Exec-Form CMD for Exit Code Propagation**
    - Same assertion as 6.5 applied to the pusher Dockerfile
    - Tag: `Feature: docker-containerization, Property 5: Exec-form CMD for exit code propagation`
    - **Validates: Requirements 13.5**

- [~] 10. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Write cross-cutting property-based tests (Properties 4 and 6)
  - [-] 11.1 Write property test — Property 4: Required env-var enforcement (static analysis)
    - **Property 4: Required Environment Variable Enforcement**
    - Use `fast-check` to generate arbitrary `(app, required_env_var)` pairs from the declared required variables table in the design
    - For each pair, parse the entrypoint source file and assert it contains a guard that checks for the variable and calls `process.exit(1)` with a message naming the variable
    - Apps and their required vars: `backend` → `DATABASE_URL`, `JWT_SECRET`; `worker` → `DATABASE_URL`, `REDIS_URL`, `REGION_ID`, `WORKER_ID`; `pusher` → `DATABASE_URL`, `REDIS_URL`
    - Tag: `Feature: docker-containerization, Property 4: Required environment variable enforcement`
    - **Validates: Requirements 5.4, 8.3, 9.4, 10.4, 13.6**

  - [x]* 11.2 Write property test — Property 6: Prisma-dependent apps declare db:generate in turbo.json
    - **Property 6: Prisma-Dependent Apps Declare db:generate**
    - Use `fast-check` to generate arbitrary app names from `{backend, worker, pusher}`
    - For each app, parse `turbo.json` and assert `<app>#build.dependsOn` contains `"db:generate"`
    - Also assert `turbo.json` contains a top-level `db:generate` task with `cache: false`
    - Tag: `Feature: docker-containerization, Property 6: Prisma-dependent apps declare db:generate`
    - **Validates: Requirements 5.1, 15.3**

- [ ] 12. Write unit tests for static file artifacts
  - [-] 12.1 Write unit tests for .dockerignore patterns
    - Assert `.dockerignore` contains each required exclusion pattern: `node_modules`, `.git`, `.turbo`, `dist`, `.next`, `*.log`, `.env*`, `*.pid`, `.codex-runtime`
    - One assertion per pattern
    - _Requirements: 1.1, 1.3_

  - [x]* 12.2 Write unit tests for next.config.js
    - Assert `next.config.js` contains `output: 'standalone'`
    - Assert `next.config.js` contains `transpilePackages` array including `'@repo/ui'`
    - _Requirements: 6.2, 7.3_

  - [x]* 12.3 Write unit tests for turbo.json structure
    - Assert `turbo.json` contains `backend#build`, `worker#build`, `pusher#build` each with `"dist/**"` in outputs
    - Assert `turbo.json` contains `db:generate` task with `cache: false`
    - Assert each of `backend#build`, `worker#build`, `pusher#build` has `db:generate` in `dependsOn`
    - _Requirements: 15.1, 15.2, 15.3_

- [~] 13. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests (Properties 1–6) validate universal correctness properties across all Dockerfiles
- Unit tests validate specific structural assertions on config files
- The `turbo prune --filter=<app> --docker` command is run on the host before `docker build`; it is not a task in this list because it is a build-time prerequisite, not a coding task
- Property 4 is implemented as static source analysis (parsing entrypoint files) rather than a live `docker run` test, keeping it runnable without built images
- Image tag conventions: `<app>:latest` for local dev, `<app>:$(git rev-parse --short HEAD)` for CI/CD

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1", "2", "3"] },
    { "id": 1, "tasks": ["4.1", "4.2", "4.3"] },
    { "id": 2, "tasks": ["5", "6.1", "7.1", "8.1", "9.1"] },
    { "id": 3, "tasks": ["6.2", "6.3", "6.4", "6.5", "7.2", "7.3", "7.4", "7.5", "8.2", "8.3", "8.4", "8.5", "9.2", "9.3", "9.4", "9.5"] },
    { "id": 4, "tasks": ["11.1", "11.2", "12.1", "12.2", "12.3"] }
  ]
}
```
