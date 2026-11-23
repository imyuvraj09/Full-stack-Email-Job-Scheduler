# Full-stack Email Job Scheduler

Schedule, queue, and deliver batched plain-text email campaigns from a React dashboard with strict rate limiting, persistence across restarts, and zero cron jobs. 

---

## 1. Quick Start & How to Run

### A. Run Natively (No Docker required)

#### Prerequisites
- Node.js 22.18+ or 24
- PostgreSQL (e.g. Neon Cloud or local instance)
- Redis (e.g. Upstash Redis or local instance)
- Elasticsearch 8.17+ (Local standalone zip or cloud instance)

#### 1. Setup Environment
```bash
cp .env.example .env
# Fill in your database and Redis details in .env
```

#### 2. Install & Build
```bash
npm ci
npm run build
```

#### 3. Run Backend & Worker
In separate terminal windows:
```bash
# Terminal 1: Start Express API (serves API and built React frontend on port 3000)
node --env-file=.env --import tsx backend/src/api.ts

# Terminal 2: Start BullMQ Background Worker
node --env-file=.env --import tsx backend/src/worker.ts
```

#### 4. Run Frontend in Development (Optional)
If you want hot-reloading for the React UI:
```bash
npm run web
# Runs Vite dev server on http://localhost:5173 proxying to API on port 3000
```
Otherwise, open **`http://localhost:3000`** directly (Express serves the production React build).

---

### B. Run with Docker Compose
```bash
cp .env.example .env
docker compose up --build -d
docker compose logs -f api worker
```
Open **`http://localhost:3000`**.

---

## 2. Ethereal Email & Environment Setup

### Setting up Ethereal SMTP
1. Navigate to **https://ethereal.email/create** to generate test credentials.
2. In your `.env`, populate `SMTP_SENDERS` as a single-line JSON array:
   ```env
   SMTP_SENDERS=[{"id":"research","user":"your_user@ethereal.email","pass":"your_password"}]
   ```
3. Outgoing messages will generate live, clickable preview URLs viewable in the **Sent emails** tab.

### Environment Variables Reference
| Variable | Description |
| :--- | :--- |
| `APP_URL` | Application root URL (e.g. `http://localhost:3000` or production URL) |
| `APP_KEY` | 32-byte key encoded as 64 hex characters (encrypts OAuth and webhooks) |
| `POSTGRES_PASSWORD` | PostgreSQL user password |
| `PGHOST` / `PGPORT` / `PGUSER` / `PGDATABASE` | PostgreSQL connection parameters |
| `PGSSLMODE` | Set to `require` for SSL/TLS connections (e.g. Neon) |
| `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` | Redis connection parameters |
| `REDIS_TLS` | Set to `true` for TLS-enabled Redis (e.g. Upstash) |
| `ES_URL` | Elasticsearch endpoint (default `http://localhost:9200`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth 2.0 Web Application credentials |
| `MIN_DELAY_MS` | Minimum delay enforced per sender between deliveries (default `2000`) |
| `MAX_EMAILS_PER_HOUR` | Maximum allowed deliveries per sender per UTC hour (default `200`) |
| `WORKER_CONCURRENCY` | Concurrent BullMQ jobs processed per worker process (default `8`) |

---

## 3. Architecture Overview

### 1. Zero Cron Jobs: How Scheduling Works
- **No OS cron, no node-cron, no agenda**.
- When a campaign is submitted, the API atomically writes campaign and recipient records to PostgreSQL in one transaction and enqueues an outbox event.
- The worker's outbox relay picks up committed events and enqueues **BullMQ delayed jobs** into Redis.
- The initial delay is computed as `start + (recipient_index × delay) - now`. BullMQ stores delayed jobs in Redis sorted sets (`zset`) with execution timestamps as scores.

### 2. Persistence & Restart Scenario
- **Crash/Restart Safety**: All job state resides in PostgreSQL and Redis.
- If the server or worker restarts while jobs are scheduled:
  - Jobs retain their original scheduled epoch timestamps in Redis and PostgreSQL.
  - Future emails still send at their exact intended time; they do **not** restart from Day 1.
  - Completed emails (`status = 'sent'`) are never re-sent.
- If a worker crashes mid-transmission: BullMQ stall detection reclaims the job. The worker checks PostgreSQL row state under the sender advisory lock, safely detects uncertainty, and prevents duplicate sends.

### 3. Rate Limiting, Throttling & Concurrency
- **Sender Locks**: When an email is ready to send, the worker acquires a PostgreSQL session-level advisory lock (`pg_advisory_xact_lock`) for that sender ID. Multiple workers can send simultaneously from different senders, but a single sender is serialized.
- **Sliding Delay & Hourly Caps**: Under the lock, the worker evaluates:
  1. Minimum cooldown (`MIN_DELAY_MS`, default 2,000 ms) from the last finished send.
  2. Fixed UTC hourly quota (`MAX_EMAILS_PER_HOUR`, default 200).
- If the quota is exceeded or cooldown has not elapsed, the job is not dropped; instead, it is postponed via `job.moveToDelayed(next_available_time)` back into BullMQ and releases the worker concurrency slot.

---

## 4. Features Implemented

| Area | Feature | Implementation Details |
| :--- | :--- | :--- |
| **Backend** | **Scheduler** | BullMQ delayed jobs with Redis sorted sets. Zero cron dependencies. |
| **Backend** | **Persistence** | PostgreSQL transactional outbox pattern + Redis persistent queue state. Survives server restarts. |
| **Backend** | **Rate Limiting** | Dual-bucket throttle (per-sender delay + per-sender hourly quota) with auto-rescheduling. |
| **Backend** | **Concurrency** | PostgreSQL session advisory locks prevent concurrent collision on shared mailboxes across multiple worker instances. |
| **Backend** | **Idempotency** | UUID `Idempotency-Key` validation on campaign intake with SHA-256 payload digest. Deduplicated recipient addresses. |
| **Backend** | **Search** | Elasticsearch bulk-indexed full-text search with `version_type=external_gte` revision locking. |
| **Frontend** | **Authentication** | Google OAuth authorization-code flow with session cookies, plus verified demo login fallback. |
| **Frontend** | **Dashboard** | Dual-tab view for **Scheduled** and **Sent** deliveries with live 5-second polling. |
| **Frontend** | **Composer** | Rich composer supporting CSV lead upload, deduplication count, sender selection, start time, delay, and hourly cap controls. |
| **Frontend** | **Delivery Previews**| One-click Ethereal preview links directly in the Sent emails table. |
| **Frontend** | **Queue Ops** | BullMQ operator dashboard integrated at `/ops/queues`. |

---

## 5. Assumptions, Shortcuts & Trade-offs

1. **SMTP Transport Scope**: Ethereal is used as the reference SMTP transport for safe test delivery. Production configurations would swap nodemailer transport credentials for SendGrid, AWS SES, or custom SMTP without changing the queue or lock architecture.
2. **Fixed Hourly Buckets**: Hourly quotas reset on UTC hour boundaries. A campaign scheduled across an hour boundary can send quota on both sides, provided the inter-email minimum delay (`MIN_DELAY_MS`) is respected.
3. **At-Least-Once Delivery vs. Non-Duplication**: When worker loss occurs during SMTP socket transmission before acknowledgement, the system favors non-duplication and marks the state as `uncertain` rather than issuing a duplicate send.
4. **Elasticsearch Fallback**: Full search queries require Elasticsearch. If the search cluster is degraded, browsing scheduled/sent records without query filters continues uninterrupted directly via PostgreSQL.

---

## 6. Project Structure

```text
├── backend/
│   ├── src/
│   │   ├── api.ts              # Express API server & routes
│   │   ├── auth.ts             # Google & Slack OAuth flows
│   │   ├── core.ts             # DB pool, Redis connection, BullMQ queue & crypto
│   │   ├── policy.ts           # Sliding rate limit & throttle algorithms
│   │   ├── relay.ts            # Outbox pattern consumers
│   │   ├── schema.sql          # PostgreSQL relational schema
│   │   └── worker.ts           # BullMQ worker & SMTP delivery pipeline
│   ├── routes/                 # Campaign intake & email retrieval
│   └── services/               # Elasticsearch indexer & Slack notifier
├── frontend/
│   ├── src/
│   │   ├── components/         # Compose modal, EmailTable, Brand UI
│   │   ├── api.ts              # Typed API client
│   │   └── leads.ts            # CSV parser & lead deduplicator
│   └── dist/                   # Production React build bundle
├── demo/
│   └── Scheduler-Demo.mp4      # Reference demonstration video
├── Dockerfile                  # Application container definition
├── compose.yaml                # Production Docker stack
└── leads.demo.csv              # Sample CSV leads for testing
```

