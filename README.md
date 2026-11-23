# Full-stack Email Job Scheduler

Schedule a batch of plain-text emails from a React dashboard. One upload becomes one campaign and one delivery record per unique address. PostgreSQL owns the delivery record. BullMQ runs the delayed jobs. The application only configures Ethereal as its SMTP host.

## Project structure

| Directory | Contents |
| --- | --- |
| `backend/src/` | TypeScript Express API, Google and Slack OAuth, BullMQ worker, database schema and shared configuration |
| `backend/src/routes/` | Campaign intake, idempotency and paginated user-scoped email queries |
| `backend/src/services/` | Elasticsearch mapping and bulk indexing, Slack notification delivery |
| `frontend/src/` | React dashboard, typed API client, lead parser and Tailwind styles |
| `frontend/src/components/` | Compose form, searchable email table and shared brand component |
| `tests/` | Unit tests for rate windows, cooldowns and lead parsing |
| `tests/integration/` | Two-worker end-to-end regression suite and isolated external provider fixtures |
| `demo/` | Short video of the application running |

The root contains the shared npm lockfile, Dockerfile, application Compose stack, isolated test Compose stack, environment template and sample CSV.

## Run locally

Install Docker with Compose v2 and allocate at least 4 GB to Docker. Copy the example environment and fill in the values below.

```sh
cp .env.example .env
openssl rand -hex 32   # paste the output into APP_KEY in .env
docker compose up --build -d
docker compose logs -f api worker
```

On Windows PowerShell, use `Copy-Item .env.example .env`. Generate APP_KEY with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` if OpenSSL is unavailable.

Open http://localhost:3000. Express serves the production React build on the same origin. Redis, PostgreSQL and Elasticsearch are internal services. The containers use named volumes. To stop while retaining data, use `docker compose down`. To run two workers, use `docker compose up -d --scale worker=2`. Both must use identical sender and limit settings.

| Setting | Configuration |
| --- | --- |
| APP_URL | Browser-facing origin, e.g. http://localhost:3000. Use HTTPS when hosting externally. |
| APP_KEY | Random 32-byte key encoded as 64 hex characters. Keep stable across restarts. Used for OAuth state cookies and AES-GCM encryption of Slack webhook URLs. |
| GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET | Create a Google Cloud OAuth client of type **Web application**. Configure consent, add your account as a test user if applicable, and register the exact redirect URI `http://localhost:3000/auth/google/callback`. |
| SLACK_CLIENT_ID / SLACK_CLIENT_SECRET | Create a Slack app, enable Incoming Webhooks, add the `incoming-webhook` bot scope and configure the redirect URL `<APP_URL>/auth/slack/callback`. For Slack's HTTPS redirect requirement, use a tunnel or an HTTPS deployment. Set APP_URL to that origin and register its Google callback too. |
| SMTP_SENDERS | JSON array of distinct sender IDs, addresses and passwords. At https://ethereal.email/create create two test accounts and copy each SMTP username and password. Keep the JSON on one line as shown in .env.example. SMTP uses smtp.ethereal.email:587 with STARTTLS. |
| POSTGRES_PASSWORD | Local database password. Compose sets the host, user and database. |
| MIN_DELAY_MS | Minimum cooldown after an SMTP attempt finishes **per sender**. Default 2,000 ms. Different senders may work in parallel. |
| MAX_EMAILS_PER_HOUR | Maximum attempts per sender per fixed UTC hour, default 200. A campaign may request a lower cap. |
| WORKER_CONCURRENCY | Jobs active per worker process, default 8, maximum 24. The database pool reserves capacity for relay transactions. |
| QUEUE_ADMIN_EMAIL | Verified Google account allowed to inspect the cross-user BullMQ dashboard at `/ops/queues`. |

To see Slack notifications, sign in, choose **Connect Slack**, authorize the app and select the target channel. Set a campaign limit of 2 and schedule three leads. The second reserved attempt creates an alert. The third waits for the next window. Disconnect removes the encrypted webhook locally. Reconnect opens a new authorization flow.

### Development

Use Node 22.18+ or 24. Run `npm ci`, `npm test` and `npm run build` in the project root. For a separate Vite development server, start the Compose stack and run `npm run web` on the host. Set APP_URL to http://localhost:5173 for that mode and update the provider redirect URIs. Vite proxies /auth, /api and /ops to Express. Alternatively, open the Compose-built UI directly. The backend and worker entry points are `npm run api` and `npm run worker`; running them outside Compose requires reachable infrastructure, loaded environment variables, and PGHOST, PGUSER, PGDATABASE, REDIS_HOST and ES_URL set for your hosts. Compose reads .env automatically.

## Features

| Area | Implementation |
| --- | --- |
| Identity | Google authorization-code login, verified Google email, profile and avatar, opaque seven-day session, logout. User identity comes only from the session. |
| Compose | Sender selector, subject and plain-text message, CSV/text upload, unique address count, local start time, adjustable spacing and hourly cap. |
| Dashboard | Scheduled and sent tabs, pagination, Elasticsearch-backed search, loading and empty states, errors, five-second refresh, and Ethereal preview links for successful sends where available. |
| Queue operations | Admin-only, read-only Bull Board using live Redis data. Jobs contain delivery IDs only. |
| Notifications | Slack OAuth, user-specific encrypted incoming webhook, disconnect/reconnect, and a retried outbound HTTPS POST on limit hits. |
| Delivery | Transactional intake and outbox, persistent delayed jobs, stable delivery IDs, concurrency controls and cross-worker sender throttles. |

## Request and delivery lifecycle

1. **Accept.** POST /api/campaigns requires a session cookie and a UUID Idempotency-Key. One SQL transaction writes the campaign, recipient rows, and enqueue/index events. The unique user/key constraint makes concurrent retries return the same campaign. Reusing the key with a different body returns 409. Input is limited to 10,000 addresses; addresses are deduplicated case-insensitively.
2. **Dispatch.** Each worker has independent outbox consumers for Redis publication, Elasticsearch updates and Slack notifications. They claim committed events with FOR UPDATE SKIP LOCKED. The enqueue consumer submits batches of up to 100 delayed jobs with the email UUID as the BullMQ job ID. The original due time is start + recipient index × campaign gap. An idle consumer backs off for 350 ms. This loop delivers committed events. BullMQ owns email timing. No cron or interval scan of all scheduled emails is involved.
3. **Throttle.** A worker acquires a PostgreSQL session advisory lock for the sender. Under that lock it reads the email, sender and campaign buckets using database time. It takes the latest of the email due time, both cooldowns, and the next UTC hour for any full bucket. A job that must wait moves into BullMQ's delayed set and releases its worker slot. On lock contention it retries after a short jitter. The database stores both counters and the SMTP intent in one transaction. Failed or uncertain attempts still consume quota. A completed attempt extends both cooldowns from its finish time. The lock is held through SMTP so two workers cannot send concurrently from one sender.
4. **Send.** SMTP runs outside the database transaction. A success stores the finish time and preview URL. An explicit SMTP rejection is failed. A transport outcome that cannot establish acceptance is uncertain. The sent tab includes all completed outcomes and shows the diagnostic. A deterministic Message-ID allows manual reconciliation.
5. **Search.** PostgreSQL changes enqueue search events. The index consumer uses bulk indexing with an external row revision, so late older updates cannot overwrite newer state. Searches include mandatory owner and status filters, then recheck ownership in PostgreSQL. Indexing is eventually consistent. Browsing without a search term works during a search outage.
6. **Notify.** Reserving the last allowed slot writes a Slack outbox event for the campaign owner if connected. When campaign and sender limits coincide, the attempt creates one event. The notifier checks that the same Slack connection is still active at delivery time and retries a failed call with backoff. Disconnected users are skipped. Slack posts follow at-least-once semantics if a response is lost.

### Restart and SMTP ambiguity

Redis AOF and named volumes retain due jobs. PostgreSQL retains campaign state, counters and unpublished events. A crash after the database commit but before queue publication leaves a replayable event. A crash after publication but before acknowledging an event uses the same queue ID on replay. The delivery record is checked again under the sender lock before SMTP.

SMTP and PostgreSQL cannot commit atomically. If a worker dies after recording its sending intent, BullMQ stall recovery reclaims the job. The replacement worker marks it **uncertain** and avoids issuing another SMTP request. This favors duplicate prevention and can leave an email undelivered if the worker died before transmission. Inspect the Ethereal mailbox and Message-ID before a manual resend. Normal future jobs continue independently.

### Load and trade-offs

A 1,000-recipient submission uses a set-based SQL insert and chunked queue publication. No in-process timer is allocated per recipient. Independent senders run concurrently. One sender is serialized, and sender and campaign caps apply across processes. The original stagger preserves typical order. Contention and hour-boundary retries make strict FIFO across simultaneous jobs best effort. Fixed windows can allow traffic on both sides of an hour boundary, subject to the minimum gap. Due times are earliest eligible times; provider latency or downtime can delay delivery.

Configured mailboxes form a shared operator-managed sender pool. Each user sees only their campaigns. For a shared mailbox, its full-sender alert goes to the owner of the campaign that consumed the last slot. The compose cap is an additional per-campaign limit. CSV/text input extracts email addresses from all fields and supports ordinary ASCII addresses. The message is shared across the campaign. Protect these internal services with network isolation and provision backup/restore before deployment. The reference stack targets persistent volumes and process restarts; catastrophic loss of both storage and backups is outside its recovery model.

## API

| Method and path | Purpose |
| --- | --- |
| GET /auth/google, /auth/slack | Start a real provider OAuth flow |
| POST /auth/logout, DELETE /auth/slack | End session or remove Slack connection |
| GET /api/me | Signed-in profile, sender choices, limits, queue-admin flag |
| POST /api/campaigns | Create campaign; returns ID and deduplicated count |
| GET /api/emails?tab=scheduled&q=maya&page=1 | List/filter up to 25 records; use tab=sent for completed attempts |
| GET /ops/queues | Live operator dashboard |

Example POST body (start is UTC, delay is milliseconds).

```json
{"sender":"research","subject":"Research update","body":"Here is the update.","leads":["maya@example.org","leo@example.org"],"start":"2026-12-01T10:00:00.000Z","delay":2000,"hourly":2}
```

## Verification

[Watch the local demo](demo/Scheduler-Demo.mp4). A browser schedules three addresses. The API and both workers stop before delivery and restart against the same PostgreSQL and Redis data. A local SMTP capture server records two distinct messages. The third stays scheduled for the next UTC hour. The recording also shows a recipient search and the live BullMQ dashboard.

Run the unit tests and TypeScript production build with `npm ci && npm test && npm run build`. Run the integration suite with Docker Compose from the project root:

```sh
docker compose -f compose.test.yaml up --build --abort-on-container-exit --exit-code-from integration
docker compose -f compose.test.yaml down
```

The test stack uses its own Compose project, ephemeral database, queue and index. It exercises Express with two worker processes, PostgreSQL, Redis, Elasticsearch and an SMTP capture server. Google and Slack provider responses and the Slack webhook destination are local fixtures. Production entry points have no fixture login route or SMTP override. The suite checks concurrent idempotency, search visibility across tenants, restart recovery, hourly rollover, SMTP spacing, queue-dashboard access, Slack disconnect/reconnect, 1,000 delayed jobs, and worker interruption during SMTP.

The integration suite also kills both workers after the SMTP capture server receives the message body and before acknowledgement. BullMQ reclaims the stalled job. The dashboard records the outcome as uncertain, and the receiver observes exactly one copy.

## Reproduce the live demo in under five minutes

1. Sign in with Google and connect a Slack test channel. Open the Ethereal mailbox and the admin queue dashboard in separate tabs.
2. Select **Compose new email**, upload `leads.demo.csv`, set the start one minute ahead, a two-second delay and an hourly cap of two. Schedule the campaign. Show all three rows and delayed jobs.
3. Run `docker compose stop api worker`, then `docker compose up -d --scale worker=2 api worker` before the due time. Refresh the dashboard to show the same three records.
4. Show the two sent rows and their distinct Ethereal previews, then open the live Slack alert. Show the remaining scheduled row's next-hour due time. Search for the subject in each tab and open the queue dashboard.

The included recording is a local integration demonstration using a seeded test session and a local SMTP capture service. The application source uses Google OAuth and Ethereal. The UI follows the public Figma board’s centered login, compact sidebar, white inbox, green controls and full-page composer. It retains Google-only sign-in and exposes the assignment’s additional Slack, scheduling and queue controls. Live Google consent, Ethereal acceptance and a real Slack workspace notification require configured provider accounts.
