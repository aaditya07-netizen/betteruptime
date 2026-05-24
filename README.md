# BetterStack1 — Distributed Website Uptime Monitor

A production-grade, distributed website uptime monitoring system inspired by BetterStack and UptimeRobot. Built as a TypeScript monorepo using pnpm workspaces and Turborepo, it continuously pings registered URLs from multiple geographic regions, records response times and up/down status, and exposes that data via a REST API.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [How It Works — End to End](#how-it-works--end-to-end)
- [Monorepo Structure](#monorepo-structure)
- [Apps](#apps)
  - [Backend](#backend--rest-api)
  - [Pusher](#pusher--scheduler--dispatcher)
  - [Worker](#worker--uptime-checker)
  - [Web](#web--frontend)
  - [Tests](#tests--integration-test-suite)
- [Packages](#packages)
  - [store](#store--database-layer)
  - [redisstream](#redisstream--redis-stream-abstraction)
  - [ui](#ui--shared-react-components)
  - [typescript-config](#typescript-config)
  - [eslint-config](#eslint-config)
- [Database Schema](#database-schema)
- [Concurrency Model](#concurrency-model)
- [Multi-Region Design](#multi-region-design)
- [Getting Started](#getting-started)
- [Environment Variables](#environment-variables)
- [Running Tests](#running-tests)
- [Known Issues & Gaps](#known-issues--gaps)
- [Future Implementations](#future-implementations)
  - [Kubernetes & Autoscaling](#1-kubernetes--autoscaling)
  - [Password Security](#2-password-security)
  - [Real-time Frontend Dashboard](#3-real-time-frontend-dashboard)
  - [Alerting System](#4-alerting-system)
  - [Multi-region Deployment](#5-multi-region-deployment)
  - [Observability & Metrics](#6-observability--metrics)
  - [Rate Limiting & API Security](#7-rate-limiting--api-security)
  - [SLA & Incident Reporting](#8-sla--incident-reporting)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        User / Browser                           │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTP
                            ▼
                   ┌─────────────────┐
                   │    Backend      │  Express REST API
                   │   port 3001     │  JWT Auth
                   └────────┬────────┘
                            │ read/write
                            ▼
                   ┌─────────────────┐
                   │   PostgreSQL    │  Prisma ORM
                   │   (Database)    │
                   └────────▲────────┘
                            │ write ticks        read websites
              ┌─────────────┘                        │
              │                                      ▼
     ┌────────┴────────┐                   ┌─────────────────┐
     │     Worker      │  ◄── Redis ──────  │     Pusher      │
     │  (per region)   │     Stream         │  (scheduler)    │
     │  no HTTP port   │                   │  no HTTP port   │
     └─────────────────┘                   └─────────────────┘
```

- **Backend** is the only service that exposes an HTTP port
- **Pusher** and **Worker** are background processes with no HTTP server
- **Redis Streams** is the message bus between Pusher and Worker
- **PostgreSQL** is the single source of truth for all persistent data

---

## How It Works — End to End

### Step 1 — User registers a website
A user signs up, signs in to get a JWT, then calls `POST /website` with a URL. The backend stores it in PostgreSQL.

### Step 2 — Pusher dispatches check jobs (every 3 minutes)
The Pusher process runs on a `setInterval` of 3 minutes. On each tick:
1. Fetches all registered websites from PostgreSQL
2. Pushes every `{ url, id }` pair into the Redis Stream `betteruptime:website`

### Step 3 — Worker picks up jobs and checks websites
The Worker runs an infinite `while(1)` loop:
1. Reads up to **5 messages** at a time from the Redis Stream using a **consumer group** (identified by `REGION_ID`)
2. Fires all 5 HTTP GET requests **concurrently** using `Promise.all()`
3. Records a `website_tick` row in PostgreSQL for each URL — either `Up` or `Down` — along with the response time in milliseconds
4. Acknowledges the messages back to Redis so they aren't re-delivered

### Step 4 — User queries status
The user calls `GET /status/:websiteId`. The backend fetches the website and its most recent tick from PostgreSQL and returns the result.

---

## Monorepo Structure

```
betterstack1/
├── apps/
│   ├── backend/        # Express REST API
│   ├── pusher/         # Scheduler — pushes URLs to Redis every 3 min
│   ├── worker/         # Uptime checker — reads Redis, pings URLs, writes DB
│   ├── web/            # Next.js frontend (scaffold, not yet built)
│   └── tests/          # Vitest integration tests
├── packages/
│   ├── store/          # Prisma client + PostgreSQL schema
│   ├── redisstream/    # Redis Stream abstraction (xAdd, xReadGroup, xAck)
│   ├── ui/             # Shared React components
│   ├── typescript-config/  # Shared tsconfig presets
│   └── eslint-config/  # Shared ESLint rules
├── package.json        # Root — pnpm workspaces + Turborepo
├── turbo.json          # Turborepo pipeline config
└── pnpm-workspace.yaml
```

**Tech stack:**
- Language: TypeScript (all services)
- Package manager: pnpm 9 with workspaces
- Build orchestration: Turborepo
- Runtime: Node.js ≥ 18
- Database: PostgreSQL via Prisma ORM
- Message bus: Redis Streams
- HTTP framework: Express 5
- Auth: JWT (jsonwebtoken)
- Validation: Zod
- HTTP client: Axios
- Testing: Vitest

---

## Apps

### Backend — REST API

**Location:** `apps/backend`  
**Port:** `3001` (or `process.env.PORT`)  
**Framework:** Express 5 + JWT authentication

#### Endpoints

| Method | Path | Auth Required | Description |
|--------|------|:---:|-------------|
| `POST` | `/user/signup` | ❌ | Create a new account. Body: `{ username, password }` |
| `POST` | `/user/signin` | ❌ | Sign in and receive a JWT. Body: `{ username, password }` |
| `POST` | `/website` | ✅ | Register a URL to monitor. Body: `{ url }` |
| `GET` | `/status/:websiteId` | ✅ | Fetch website info and latest uptime tick |

#### Authentication Flow
- `POST /user/signin` returns a `{ jwt }` token
- All protected routes require the token in the `Authorization` header (no `Bearer` prefix currently)
- `authMiddleware` verifies the JWT using `JWT_SECRET` and attaches `userId` to the request

#### Input Validation
Signup and signin bodies are validated with Zod:
```typescript
const AuthInput = z.object({
    username: z.string(),
    password: z.string()
})
```

---

### Pusher — Scheduler / Dispatcher

**Location:** `apps/pusher`  
**Port:** None — background process only  
**Trigger:** `setInterval` every 3 minutes + immediate run on startup

Fetches all websites from PostgreSQL and bulk-pushes them into the Redis Stream. This is the heartbeat that drives the entire monitoring loop. Every 3 minutes, every registered website gets a check job queued.

```typescript
setInterval(() => { main() }, 3 * 60 * 1000)
main() // also runs immediately on startup
```

---

### Worker — Uptime Checker

**Location:** `apps/worker`  
**Port:** None — background process only  
**Identity:** Configured via `REGION_ID` and `WORKER_ID` environment variables

The core monitoring engine. Runs an infinite loop:

```typescript
while(1) {
    // 1. Read up to 5 jobs from Redis Stream
    const response = await xReadGroup(REGION_ID, WORKER_ID);

    // 2. Fire all HTTP checks concurrently (not sequentially)
    let promises = response.map(({message}) => fetchWebsite(message.url, message.id))
    await Promise.all(promises);

    // 3. Acknowledge processed messages
    xAckBulk(REGION_ID, response.map(({id}) => id));
}
```

#### Concurrency Model — Why `Promise.all` Works in Single-Threaded JS

JavaScript is single-threaded, but `Promise.all` achieves **concurrent I/O** — not parallel CPU execution. When `axios.get()` is called, the JS thread hands the network request off to the OS (via Node's libuv) and immediately moves on. The thread is free while waiting for responses.

```
Sequential (bad):
  URL1: fire → wait 200ms → done
  URL2: fire → wait 150ms → done     Total: 650ms
  URL3: fire → wait 300ms → done

Concurrent with Promise.all (actual behavior):
  URL1: fire ──────────── 200ms ──► done
  URL2: fire ───── 150ms ─────────► done    Total: ~300ms (slowest one)
  URL3: fire ──────────────── 300ms ──────► done
```

All 5 requests are fired almost simultaneously. The JS thread is idle during network round-trips. Total time equals the slowest single request, not the sum.

#### Per-Region Isolation
Each worker instance uses its `REGION_ID` as the Redis consumer group name. This means:
- Workers in `us-east` and `eu-west` each get their own independent stream of jobs
- The same URL gets checked from every region independently
- Results are tagged with `region_id` in the database, enabling per-region uptime analysis

---

### Web — Frontend

**Location:** `apps/web`  
**Framework:** Next.js 15 (App Router)

Currently a **default Turborepo scaffold**. No monitoring UI has been built yet. This is a placeholder for the dashboard described in [Future Implementations](#3-real-time-frontend-dashboard).

---

### Tests — Integration Test Suite

**Location:** `apps/tests`  
**Framework:** Vitest  
**Target:** Live backend at `http://localhost:3001`

Tests cover:

**User endpoints:**
- Rejects signup with incorrect body shape (e.g., `email` instead of `username`)
- Accepts valid signup and returns `{ id }`
- Rejects signin with incorrect body shape
- Accepts valid signin and returns `{ jwt }`

**Website endpoints:**
- Rejects website creation without auth header
- Rejects website creation without a URL in the body
- Creates website successfully with valid auth + URL
- User can fetch their own website by ID
- User cannot access a website created by a different user

---

## Packages

### store — Database Layer

**Location:** `packages/store`  
**Export:** `prismaClient` — a singleton Prisma client instance

Used by backend, pusher, and worker. All three services import the same client:
```typescript
import { prismaClient } from "@repo/store/client";
```

Database migrations live in `packages/store/prisma/migrations/`.

---

### redisstream — Redis Stream Abstraction

**Location:** `packages/redisstream`  
**Stream name:** `betteruptime:website`

Exports three functions:

| Function | Description |
|----------|-------------|
| `xAddBulk(websites[])` | Batch-push `{ url, id }` pairs into the stream |
| `xReadGroup(consumerGroup, workerId)` | Pull up to 5 unprocessed messages for a consumer group |
| `xAckBulk(consumerGroup, eventIds[])` | Acknowledge processed messages so they aren't re-delivered |

> **Note:** The package export path has a typo — it's exported as `./componets` (missing an 'n') instead of `./components`. This is a known issue.

---

### ui — Shared React Components

**Location:** `packages/ui`

Shared component library used by the Next.js frontend: `Button`, `Card`, `Code`.

---

### typescript-config

**Location:** `packages/typescript-config`

Shared `tsconfig` presets: `base.json`, `nextjs.json`, `react-library.json`. All apps and packages extend from these.

---

### eslint-config

**Location:** `packages/eslint-config`

Shared ESLint rule sets for Next.js, React, and base Node environments.

---

## Database Schema

```prisma
model user {
  id        String    @id @default(uuid())
  username  String    @unique
  password  String
  websites  website[]
}

model website {
  id         String         @id @default(uuid())
  url        String
  user_id    String
  time_added DateTime
  ticks      website_tick[]
  user       user           @relation(fields: [user_id], references: [id])
}

model region {
  id    String         @id @default(uuid())
  name  String
  ticks website_tick[]
}

model website_tick {
  id               String         @id @default(uuid())
  response_time_ms Int
  status           website_status  // Up | Down | Unknown
  region_id        String
  website_id       String
  createdAt        DateTime       @default(now())
}

enum website_status {
  Up
  Down
  Unknown
}
```

**Relationships:**
- A `user` owns many `website`s
- A `website` has many `website_tick`s (one per check, per region)
- A `region` has many `website_tick`s
- Each `website_tick` belongs to one `website` and one `region`

---

## Concurrency Model

```
Pusher (single process)
  └─► every 3 min: fetch all websites → push N jobs to Redis Stream

Redis Stream: betteruptime:website
  └─► consumer group per region (e.g., "us-east", "eu-west")
  └─► each group gets ALL jobs independently

Worker (one or more per region)
  └─► reads 5 jobs at a time from its region's consumer group
  └─► checks all 5 URLs concurrently via Promise.all
  └─► writes results to PostgreSQL
  └─► acks Redis → loops immediately
```

Multiple worker instances in the same region share the same consumer group — Redis distributes jobs between them automatically. Adding more workers in a region increases throughput linearly.

---

## Multi-Region Design

The system is designed for multi-region from the ground up:

1. Each worker is assigned a `REGION_ID` via environment variable
2. The `REGION_ID` is used as the Redis consumer group name — so each region gets its own independent queue of jobs
3. Every `website_tick` is tagged with `region_id` — so you can query uptime per region
4. The `region` table in PostgreSQL stores region metadata

To add a new region, you simply deploy a new worker process with a different `REGION_ID`. No code changes required.

### Why Every Region Checks Every Website

This is the core value of multi-region monitoring. A website hosted in India still needs to be reachable by users in England, USA, New Zealand, and West Indies. A single-region check only tells you if the site is up from one location — it misses partial outages, regional routing failures, and CDN edge problems.

**Example — same website, 5 regions, one check cycle:**

```
User registers: https://myshop.in  (hosted in India)

Every 3 minutes, ALL regions check it independently:

🇺🇸 USA Worker        → GET https://myshop.in → 850ms   ✅ Up
🇮🇳 India Worker      → GET https://myshop.in → 45ms    ✅ Up
🏴󠁧󠁢󠁥󠁮󠁧󠁿 England Worker    → GET https://myshop.in → 620ms   ✅ Up
🇳🇿 NZ Worker         → GET https://myshop.in → 1200ms  ✅ Up
🌴 West Indies Worker → GET https://myshop.in → timeout ❌ Down
```

All 5 results are stored in `website_tick` tagged with their `region_id`. The dashboard can show:

```
myshop.in — Last check (3 min ago)
┌──────────────┬─────────┬──────────────┐
│ Region       │ Status  │ Response Time│
├──────────────┼─────────┼──────────────┤
│ USA          │ ✅ Up    │ 850ms        │
│ India        │ ✅ Up    │ 45ms         │
│ England      │ ✅ Up    │ 620ms        │
│ New Zealand  │ ✅ Up    │ 1200ms       │
│ West Indies  │ ❌ Down  │ timeout      │
└──────────────┴─────────┴──────────────┘
```

This tells you the site is up globally but unreachable from West Indies specifically — something a single-region monitor would completely miss.

**Real-world scenarios this catches:**

- **Partial outage** — CDN edge node fails in one region. India worker says "up", England worker says "down". Without multi-region you'd never know England users are affected.
- **Latency degradation** — Site is technically "up" everywhere but England users are getting 4000ms response times. Not a binary up/down — only visible from that region.
- **DNS propagation** — You deployed a DNS change. It propagated in India but not yet in England. Multi-region shows exactly which regions have picked it up.
- **Geo-blocking** — Site accidentally blocks a country's IP range. Only that region's worker detects it.

**How Redis consumer groups make this work:**

Each region has its own consumer group on the same Redis Stream. Unlike a regular queue where one consumer steals a message, Redis Streams deliver every message to every consumer group independently. So when Pusher pushes `myshop.in` into the stream, all 5 regional consumer groups each get their own copy of that job — guaranteeing every region checks every website.

```
Pusher pushes: { url: "myshop.in", id: "abc" }
                          │
                          ▼
              Redis Stream: betteruptime:website
                          │
        ┌─────────────────┼──────────────────┐
        │                 │                  │
        ▼                 ▼                  ▼
  Consumer Group    Consumer Group    Consumer Group
    "usa"             "india"          "england"
  gets the job      gets the job      gets the job
        │                 │                  │
        ▼                 ▼                  ▼
  USA Worker        India Worker      England Worker
  checks it         checks it         checks it
```

**Per-region uptime query (already supported by the schema):**

```sql
SELECT
    region_id,
    COUNT(*) AS total_checks,
    SUM(CASE WHEN status = 'Up' THEN 1 ELSE 0 END) AS up_count,
    ROUND(100.0 * SUM(CASE WHEN status = 'Up' THEN 1 ELSE 0 END) / COUNT(*), 2) AS uptime_pct,
    AVG(response_time_ms) AS avg_response_ms
FROM website_tick
WHERE website_id = 'your-website-id'
  AND "createdAt" > NOW() - INTERVAL '24 hours'
GROUP BY region_id;
```

---

## Getting Started

### Prerequisites
- Node.js ≥ 18
- pnpm 9
- Neon serverless PostgreSQL database
- Redis instance

### Install dependencies
```bash
pnpm install
```

### Set up environment variables
```bash
# packages/store/.env
DATABASE_URL="postgresql://<user>:<password>@<project>-pooler.<region>.aws.neon.tech/<database>?sslmode=require&channel_binding=require"

# Prisma 5.10+ works with the pooled Neon URL above. If you ever downgrade
# Prisma below 5.10, add DATABASE_URL_UNPOOLED with Neon's direct host URL.

# apps/backend — set in your shell or .env
JWT_SECRET="your-secret-key"
PORT=3001

# apps/worker — set in your shell or .env
REGION_ID="us-east"
WORKER_ID="worker-1"
```

### Run database migrations
```bash
cd packages/store
pnpm prisma migrate deploy
```

### Seed a region (required for worker to write ticks)
The `region` table must have at least one row matching your `REGION_ID`. Run this SQL or add a seed script:
```sql
INSERT INTO region (id, name) VALUES ('us-east', 'US East');
```

### Start all services
```bash
# From root — starts all apps via Turborepo
pnpm dev

# Or individually:
cd apps/backend  && node dist/index.js
cd apps/pusher   && node dist/index.js
cd apps/worker   && node dist/index.js
```

---

## Environment Variables

| Variable | Service | Description |
|----------|---------|-------------|
| `DATABASE_URL` | store (all services) | Neon pooled PostgreSQL connection string |
| `JWT_SECRET` | backend | Secret key for signing/verifying JWTs |
| `PORT` | backend | HTTP port (default: 3001) |
| `REGION_ID` | worker | Region identifier, used as Redis consumer group name |
| `WORKER_ID` | worker | Unique worker identifier within a region |

---

## Running Tests

Tests require the backend to be running on `http://localhost:3001` and a live PostgreSQL connection.

```bash
cd apps/tests
pnpm vitest --run
```

---

## Known Issues & Gaps

| Issue | Location | Impact |
|-------|----------|--------|
| Passwords stored in plaintext | `backend/src/index.ts` | Security — critical |
| `authMiddleware` crashes if `Authorization` header is missing | `backend/src/middleware.ts` | Runtime crash on unauthenticated requests |
| `/status/:websiteId` fetches tick data but doesn't return it in the response | `backend/src/index.ts` | API returns incomplete data |
| `xAckBulk` called without `await` | `worker/index.ts` | Potential duplicate ticks on process crash |
| `./componets` typo in redisstream export | `packages/redisstream/package.json` | Must match exactly in all imports |
| No region seed script | `packages/store` | Worker silently fails to write ticks if region row doesn't exist |
| Frontend has no UI | `apps/web` | No user-facing dashboard |

---

## Future Implementations

### 1. Kubernetes & Autoscaling

**Goal:** Automatically scale worker pods based on Redis Stream queue length, and deploy workers to regional node pools.

#### What needs to be built

**Dockerfiles** — one per service. The monorepo structure requires copying the full workspace context since workers depend on shared packages:

```dockerfile
# apps/worker/Dockerfile
FROM node:20-alpine AS base
RUN npm install -g pnpm

WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/ ./packages/
COPY apps/worker/ ./apps/worker/

RUN pnpm install --frozen-lockfile
RUN pnpm --filter worker build

CMD ["node", "apps/worker/dist/index.js"]
```

**Kubernetes Deployments** — one Deployment per region:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker-us-east
spec:
  replicas: 2
  template:
    spec:
      nodeSelector:
        topology.kubernetes.io/region: us-east
      containers:
      - name: worker
        image: your-registry/worker:latest
        env:
        - name: REGION_ID
          value: "us-east"
        - name: WORKER_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.name  # pod name as unique worker ID
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: db-secret
              key: url
```

**KEDA (Kubernetes Event Driven Autoscaler)** — scales worker pods based on Redis Stream pending message count:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: worker-us-east-scaler
spec:
  scaleTargetRef:
    name: worker-us-east
  minReplicaCount: 1
  maxReplicaCount: 50
  triggers:
  - type: redis-streams
    metadata:
      address: redis:6379
      stream: betteruptime:website
      consumerGroup: us-east
      pendingEntriesCount: "10"  # add a pod for every 10 pending messages
```

#### Implementation order
1. Write Dockerfiles for backend, pusher, worker
2. Test locally with `docker-compose`
3. Push images to a container registry (ECR, GCR, Docker Hub)
4. Write K8s manifests (Deployments, Services, ConfigMaps, Secrets)
5. Install KEDA on the cluster
6. Apply ScaledObject manifests per region
7. Set up regional node pools in your cloud provider (AWS EKS node groups with region labels, GKE node pools, etc.)

#### Difficulty: Medium
The hardest part is the monorepo Docker build — you need the full workspace in the build context. Everything else maps cleanly to the existing architecture.

---

### 2. Password Security

**Goal:** Hash passwords before storing them. Never store plaintext.

**Implementation:** Replace plaintext storage with `bcrypt`:

```typescript
import bcrypt from "bcrypt";

// Signup
const hashed = await bcrypt.hash(data.data.password, 10);
await prismaClient.user.create({
    data: { username: data.data.username, password: hashed }
})

// Signin
const match = await bcrypt.compare(data.data.password, user.password);
if (!match) { res.status(403).send(""); return; }
```

Also add `Authorization: Bearer <token>` header parsing in `authMiddleware` to follow the standard convention.

#### Difficulty: Easy — ~20 lines of changes

---

### 3. Real-time Frontend Dashboard

**Goal:** Build the `apps/web` Next.js frontend into a full monitoring dashboard.

**Features to build:**
- Auth pages (signup, signin) with JWT stored in `httpOnly` cookies
- Dashboard listing all registered websites with current status (Up/Down)
- Per-website detail page showing uptime history, response time graph, per-region breakdown
- Real-time status updates via WebSockets or Server-Sent Events (SSE)

**Suggested stack additions:**
- `recharts` or `tremor` for response time graphs
- `socket.io` or native SSE for real-time push from backend
- `react-query` or `swr` for data fetching and caching

**Backend changes needed:**
- `GET /websites` — list all websites for the authenticated user
- `GET /status/:websiteId/history` — return paginated tick history
- WebSocket or SSE endpoint to push status change events

#### Difficulty: Medium-High — largest missing piece of the project

---

### 4. Alerting System

**Goal:** Notify users when a website goes down or comes back up.

**Design:**
- Add a `notification_channel` table (email, Slack webhook, PagerDuty, etc.)
- Worker detects status transitions (was `Up`, now `Down`) by comparing the latest two ticks
- On transition, publish an alert event to a separate Redis Stream or queue
- A new `alerter` service consumes alert events and sends notifications

**Notification channels to support:**
- Email (via SendGrid, SES, or Resend)
- Slack webhooks
- PagerDuty
- SMS (via Twilio)

**Schema additions:**
```prisma
model notification_channel {
  id         String  @id @default(uuid())
  user_id    String
  type       String  // "email" | "slack" | "pagerduty"
  config     Json    // channel-specific config
  website_id String
}

model alert {
  id         String   @id @default(uuid())
  website_id String
  status     String   // "down" | "recovered"
  triggered_at DateTime @default(now())
  resolved_at  DateTime?
}
```

#### Difficulty: Medium

---

### 5. Multi-region Deployment

**Goal:** Deploy worker instances in multiple geographic regions (US East, EU West, Asia Pacific, etc.) so websites are checked from multiple locations simultaneously.

**What's already done:**
- `REGION_ID` env var support in worker
- `region_id` column on `website_tick`
- Redis consumer groups per region

**What needs to be added:**
- Seed the `region` table with all active regions
- Deploy worker Deployments to regional K8s node pools (one Deployment per region)
- Update the `/status` API to return per-region tick data
- Frontend to show a world map or region breakdown of uptime

**Cloud provider setup:**
- AWS: EKS node groups in multiple availability zones / regions
- GCP: GKE node pools with `topology.kubernetes.io/region` labels
- Use a globally distributed Redis (Redis Cloud, Upstash) accessible from all regions

#### Difficulty: Medium — architecture already supports it, mostly infrastructure work

---

### 6. Observability & Metrics

**Goal:** Add structured logging, distributed tracing, and metrics dashboards.

**Tools:**
- **Logging:** Replace `console.log` with `pino` (structured JSON logs) → ship to Loki or CloudWatch
- **Metrics:** Expose Prometheus metrics from each service (queue depth, check latency, error rate)
- **Tracing:** Add OpenTelemetry instrumentation → ship to Jaeger or Tempo
- **Dashboards:** Grafana dashboards for queue depth, worker throughput, per-region uptime rates

**Key metrics to track:**
- Redis Stream pending message count per region (drives autoscaling)
- Worker check latency (p50, p95, p99)
- Website check success/failure rate
- Backend API latency and error rate
- Database query latency

#### Difficulty: Medium

---

### 7. Rate Limiting & API Security

**Goal:** Protect the backend API from abuse.

**Implementations:**
- Rate limiting on signup/signin endpoints (prevent brute force) — use `express-rate-limit`
- Rate limiting on `POST /website` (prevent users from registering thousands of URLs)
- Input sanitization on URL field (validate it's a real URL, not an internal IP — SSRF protection)
- `Authorization: Bearer <token>` standard header parsing
- HTTPS enforcement
- CORS configuration

```typescript
import rateLimit from "express-rate-limit";

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per window
    message: "Too many attempts"
});

app.post("/user/signin", authLimiter, async (req, res) => { ... });
```

#### Difficulty: Easy

---

### 8. SLA & Incident Reporting

**Goal:** Calculate and expose uptime percentages, incident history, and SLA reports.

**Features:**
- Uptime percentage over last 24h / 7d / 30d / 90d per website per region
- Incident timeline (when did it go down, how long was it down, when did it recover)
- Public status page (shareable URL showing uptime history for a website)
- CSV/PDF export of uptime reports

**Implementation approach:**
- Add a materialized view or scheduled job that aggregates `website_tick` data into uptime summaries
- Add an `incident` table that groups consecutive `Down` ticks into a single incident record
- Expose `GET /websites/:id/report?period=30d` endpoint

#### Difficulty: Medium

---

## Contributing

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/your-feature`
3. Make changes and run tests: `cd apps/tests && pnpm vitest --run`
4. Submit a pull request

## License

ISC
