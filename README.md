# Housiy — Application, Architecture and Operations

## 1. Purpose

Housiy is a multiplayer housie/tambola game. Players join rooms, receive tickets, mark called numbers, claim prizes, and see game/results updates in real time. This repository contains the PHP API/UI, Redis-backed coordination and caching, MySQL persistence, PHP-FPM runtime, Node.js WebSocket gateway, background worker, Docker Compose deployment, Kubernetes templates, and test suites.

## 2. Runtime architecture

- **`app` — Nginx:** publishes the HTTP port from `APP_PORT`, serves static UI files from `src/`, forwards only named `/api/*.php` endpoints to PHP-FPM, and proxies `/ws` to the realtime gateway.
- **`php` — PHP-FPM:** runs API code. It is private on the Compose network and is not published directly to the host.
- **`worker` — PHP CLI worker:** handles scheduled auto-calls, batched mark persistence, legacy reaction-queue draining, and retrying durable reaction-outbox events. It uses the same app image as PHP-FPM.
- **`realtime` — Node.js/WebSocket:** distributes versioned room events and committed event payloads received through Redis Pub/Sub. MySQL remains the durable source of truth.
- **`redis`:** room-state/cache and low-latency event pub/sub. Redis is not the durable store for accepted emoji reactions; MySQL stores each reaction and its transactional outbox event before the API acknowledges it.
- **`db` — MySQL 8:** durable game, player, ticket, called-number, marked-number and winner data.
- **`phpmyadmin`:** optional debug-profile service only; it is not started by the normal stack.

The regular Compose stack intentionally has no `test-runner`, no test-only Nginx proxy, and no load-generator container. Load generation is performed by `k6` on the operator's host and targets the published port of the real `app` container.

## 3. Important directories

- `src/api/` — API endpoints, including room, game, mark, claim, ticket, results and WebSocket auth.
- `src/includes/` — game rules, auth, rate limiter, Redis cache, room state, mark/reaction buffers, realtime publishing and endpoint profiler.
- `src/config/` — application and database configuration.
- `sql/schema.sql` — MySQL schema.
- `bin/worker.php`, `bin/status.php` — background worker and health/status checks.
- `realtime/server.js` — WebSocket gateway.
- `tests/load/` — k6 HTTP and persistent-WebSocket scenarios, helpers and generated reports; see the root `LoadTest.md` for the complete load-test guide.
- `tests/unit/`, `tests/api/`, `tests/e2e/`, `tests/frontend/`, `tests/ui/`, `tests/ops/` — targeted tests and correctness checks.
- `deployment/docker/` — Compose definition, Nginx/PHP-FPM configuration, environment template and environment controller.
- `deployment/k8s/` — Kubernetes manifests/templates.
- `performance-data/` — baseline, pre-test and collected run-specific diagnostic snapshots/reports; see `LoadTest.md` for interpretation and timestamp alignment.

## 4. Prerequisites

- Docker Engine and Docker Compose v2.
- Docker Engine and Docker Compose v2. Environment-specific DEV/UAT/PROD starter files are included for this handoff. They contain `CHANGE_ME` placeholders for all secrets; generate unique credentials before running `envctl.sh validate` or starting any stack.
- For host-side load testing: k6 installed on the host. The app's real containers must already be running and healthy.
- For standalone test suites: PHP 8.1+ with PDO MySQL and Redis extension, Node.js 18+, npm, and the relevant test dependencies.

The handoff ZIP includes `.env.dev`, `.env.uat` and `.env.prod` as environment-specific starter files, but all secret values are redacted to unique `CHANGE_ME` placeholders. Generate independent high-entropy credentials for each environment and store them in a secret manager or protected deployment file; do not commit them or place real secrets in a release ZIP. `.gitignore` excludes all three. For local HTTP, DEV uses `COOKIE_SECURE=0`; set it to 1 when the browser-facing DEV URL is HTTPS. Use separate database names, Redis prefixes, ports and credentials for each environment. Do not load-test production.

## 5. Start and operate DEV

From the repository root:

```bash
# The included environment file is a starter template with CHANGE_ME secrets.
# Edit it first; envctl validate intentionally rejects unfilled placeholders.
# For a fresh copy only (do not overwrite an existing file):
cp deployment/docker/.env.example deployment/docker/.env.dev
# Edit deployment/docker/.env.dev: set APP_ENV=dev, APP_PORT, DB_EXPOSED_PORT,
# MYSQL_ROOT_PASSWORD, MYSQL_DATABASE=housiy_dev, MYSQL_APP_USER,
# MYSQL_APP_PASSWORD, REDIS_PREFIX=housiy-dev and other required values.
bash deployment/docker/envctl.sh dev validate
bash deployment/docker/envctl.sh dev up
bash deployment/docker/envctl.sh dev status
bash deployment/docker/envctl.sh dev health
```

The environment controller uses the Compose project `housiy-dev`. It never deletes named database/Redis volumes when bringing a stack down. Do not use `docker compose down -v` on a stack with data you need.

Useful operations:

```bash
bash deployment/docker/envctl.sh dev logs
bash deployment/docker/envctl.sh dev logs php
bash deployment/docker/envctl.sh dev logs worker
bash deployment/docker/envctl.sh dev logs realtime
bash deployment/docker/envctl.sh dev status
```

`APP_PORT` is the host port for the real Nginx app container. The load runner reads this value from `.env.dev` and targets `http://127.0.0.1:APP_PORT`.

## 6. Performance timing and observability

The API profiler emits structured `[perf]` JSON records for instrumented request spans and slow requests. Worker diagnostics use the worker's own log prefix/metrics. In the DEV environment file, enable timing when diagnosing a bottleneck:

```dotenv
PERF_LOG_ENABLED=1
PERF_SERVER_TIMING=0
PERF_SLOW_MS=100
```

Apply environment changes by recreating the relevant DEV services with the environment controller (`bash deployment/docker/envctl.sh dev up`). `PERF_SERVER_TIMING=1` adds response timing headers; keep it disabled unless the test environment is trusted. Logging every request adds overhead, so use it for diagnosis, then repeat a benchmark with normal logging settings.

Read logs while load is running:

```bash
docker compose --project-name housiy-dev --env-file deployment/docker/.env.dev \
  -f deployment/docker/docker-compose.yml logs -f --tail=200 app php worker realtime db redis
```

Interpret the layers together: Nginx `request_time` and `upstream_response_time`, PHP `[perf]` span timings, PHP-FPM active/idle/queue/max-children metrics if status is enabled, MySQL slow queries/locks/connections, Redis latency/command statistics, worker queue depth and heartbeat, and k6 endpoint p50/p95/p99/error rates. Avoid diagnosing from a single aggregate latency number.

## 7. Number-marking hot path

Player and host tickets use optimistic UI: a called number turns green immediately, while the API validates and records the mark asynchronously from the user's point of view. On the healthy Redis/worker path, `mark.php` performs no MySQL read to rebuild the ticket's marked-number list. Redis Lua atomically records the pending mark and persistence queue entry, and the endpoint returns a lightweight acknowledgement. The worker batch-persists marks to MySQL with `INSERT IGNORE`.

Ticket snapshots reconcile MySQL rows with Redis pending marks. Their short-lived `mkc2:` read cache is only an optimization; `claim.php` does not trust it and continues to validate using authoritative MySQL data plus the pending-mark consistency barrier. The request lifecycle and failure behavior are detailed below. Run syntax and functional checks from the root using the commands in `LoadTest.md` and the test package scripts.


### 7.1 Mark request lifecycle

1. The browser validates that the number is on the player's ticket and has been called, then paints it optimistically.
2. PHP authenticates the player and validates room, ticket and called-number state.
3. Redis Lua atomically adds the mark to the ticket's pending set and registers the ticket for worker persistence.
4. PHP returns a lightweight acknowledgement; on the healthy Redis/worker path it does not wait for a MySQL write.
5. The worker batch-inserts pending marks into MySQL with `INSERT IGNORE`, then acknowledges Redis entries only after the SQL write succeeds.
6. Prize claims retain a consistency barrier and independently validate against authoritative called numbers and marked numbers.

### 7.2 Mark failure behavior

- If Redis is unavailable or the worker is not alive, `mark.php` falls back to `INSERT IGNORE` in MySQL, invalidates the read cache when Redis is reachable, and drains pending marks for that ticket.
- If a transient network error occurs after a request may have reached the server, the browser keeps the optimistic mark pending. Retrying is safe because Redis `SADD` and MySQL `INSERT IGNORE` are idempotent.
- A definitive validation rejection rolls back only that number.
- If a worker/database write fails, pending Redis entries are not acknowledged; the worker retries them.

The `mkc2:` cache is disposable and never used by `claim.php`. Its fixed two-second TTL bounds stale-read exposure if a MySQL fallback happens during a Redis outage.

## 8. Performance and correctness principles

- Redis is a performance/co-ordination layer; MySQL is the durable source of truth for game state and final prize decisions.
- Prize claims must remain atomic under concurrent claims; do not trade correctness for speed.
- Marks accepted into Redis must be flushed/persisted reliably and checked at claim time. `MarkBuffer` uses a Redis pending set plus a dirty-ticket index; the worker inserts batches into MySQL with `INSERT IGNORE` and acknowledges only after the write succeeds. A claim flushes its own ticket as a consistency barrier and unions any still-pending marks into validation.
- Each committed manual or automatic number call is added to the per-game Redis `called:<game_id>` set. Mark requests can validate called numbers with `SISMEMBER` instead of a MySQL query per tap. This set is monotonic for a game and is only a cache: a miss falls back to MySQL, and cache-write failures never roll back a committed number call.
- Final prize decisions remain serialized in a MySQL transaction and protected by the unique `(room_id, prize_type)` winner constraint. Redis is not allowed to award a prize, and mark write-behind must never be used to bypass claim validation.
- Reactions are validated and committed to `room_emoji_reactions` with a `room_reaction_outbox` row in one MySQL transaction. The API then attempts immediate Redis Pub/Sub delivery; if Redis is unavailable, the worker retries the outbox with backoff. Delivery is at-least-once, so clients deduplicate by reaction ID. Missed events are recovered through MySQL-backed poll/history reads. Existing databases create the outbox table idempotently when the worker starts; `sql/schema.sql` includes it for fresh installs.
- Room-wide realtime events carry a monotonic room version; a detected Pub/Sub version gap triggers a canonical snapshot refresh. WebSocket slow-consumer queues are bounded (`WS_MAX_BUFFERED_BYTES`, default 65,536 bytes); clients above the limit are disconnected and recover through the same snapshot API. Cache invalidation/versioning must prevent stale room, ticket, winner or called-number data.
- Tune PHP-FPM workers only after comparing worker memory, MySQL connection limits, queue depth and measured endpoint timings. More workers can worsen database contention.
- Run capacity tests only on a dedicated DEV stack with adequate CPU/RAM and test data. The `capacity` scenario models 100 rooms × 100 players and is intentionally opt-in.

### 8.1 Redis connection reuse (PHP-FPM)

Under PHP-FPM, `RedisConn` keeps one persistent Redis socket per worker (instead of connecting, authenticating and pinging on every request) and sends AUTH/SELECT/PING as a single pipelined round trip. Every reply is still validated, and any failure falls back to the MySQL-only path exactly as before. The worker and CLI tools use a normal connection. Set `REDIS_PERSISTENT=0` on the `php` service to revert, `1` to force it. Check it against a disposable Redis using the positive and negative test procedures in `tests/ops/REDIS-CONNECTION-TESTING.md` (including empty-password/auth-required and server-unavailable cases). Measured K6 impact has not been established; see `LoadTest.md` for the evidence and the A/B procedure.

## 9. Security notes

- Keep DB/Redis private to the Compose network; the DB host port binds to loopback.
- Use unique passwords and Redis prefixes per environment.
- Keep rate limiting enabled outside DEV, use a random `RATE_LIMIT_HASH_SALT`, and set `TRUSTED_PROXIES` narrowly when behind a reverse proxy.
- Never expose profiler/status endpoints publicly. Keep WebSocket origins restricted to the intended site.
- Never run destructive tests or load tests against UAT/production without a specifically approved isolated test plan; this repository's provided runner permits DEV only.

### 9.1 Production deployment gate

The Compose PROD file is a deployment starter, not a certification that a particular host/domain is production-ready. Before enabling real users:

1. Replace every `CHANGE_ME` value in `deployment/docker/.env.prod` with independently generated secrets. Example generation (run separately for each key; never reuse a value):
   ```bash
   openssl rand -hex 32  # MYSQL_ROOT_PASSWORD
   openssl rand -hex 32  # MYSQL_APP_PASSWORD
   openssl rand -hex 32  # REDIS_PASSWORD
   openssl rand -hex 32  # RATE_LIMIT_HASH_SALT
   ```
2. Store the resulting file outside source control with owner-only permissions (`chmod 600 deployment/docker/.env.prod`) or inject secrets from your secret manager. Do not paste real values into tickets, chat, logs or ZIP files.
3. Set `WS_ALLOWED_ORIGINS` to the exact browser origin(s), and set `TRUSTED_PROXIES` only to the actual reverse-proxy/ingress addresses or narrow CIDRs. Keep `APP_BIND=127.0.0.1` when a host reverse proxy or tunnel is the public entrypoint.
4. Terminate TLS at a managed load balancer/reverse proxy, enforce HTTPS/HSTS there, and verify secure session cookies end-to-end. The Compose Nginx service is an HTTP application entrypoint; it does not provision a public certificate.
5. Configure automated encrypted MySQL backups and perform a restore drill. Redis AOF is a recovery aid for buffered work, not a replacement for MySQL backups. Monitor backup age, restore success, disk capacity and Redis persistence health.
6. Set host/container CPU and memory capacity from measured load; configure log retention, metrics/alerts, firewall rules, patching and an incident/rollback plan. Keep DB/Redis/WebSocket gateway ports private.
7. Run `bash deployment/docker/envctl.sh prod validate`, inspect `docker compose config` with secrets redacted, then deploy only after a reviewed change window. Do not use the supplied DEV K6 load runner against PROD.

The supplied logs and static checks do not constitute production acceptance. Docker integration, database migration/restore, TLS/reverse-proxy behavior, failover, security scanning and 10,000 persistent WebSocket connections still require verification in the target infrastructure.

## 10. Kubernetes

`deployment/k8s/` contains parameterized manifests for the application service/deployment, database stateful set/service and storage class. Review resource requests/limits, secrets, storage, probes, ingress/TLS, network policies and persistent storage for the target cluster before applying. Do not apply raw template manifests with unresolved `${...}` placeholders.

## 11. Documentation

This file is the single application/operations reference. `LoadTest.md` is the separate load-test guide. Keep application architecture and operating instructions here.

## 12. AWS deployment helpers

The `aws/` directory intentionally contains only two operator scripts:

- `aws/install-docker-compose-run.sh .env.dev` installs Docker Engine and the Compose v2 plugin on Ubuntu/Debian when missing, validates the selected environment file, and starts the complete application stack. It also accepts `.env.uat` or `.env.prod`. Put the selected file at `deployment/docker/.env.<env>` or pass a file path; an external file is copied only if the destination does not already exist. For production, the script enforces `RATE_LIMIT_ENABLED=1` and requires Redis password, rate-limit hash salt, and secure cookies.
- `aws/cloudflare-tunnel.sh .env.dev` installs `cloudflared` when missing, checks that the selected app port is responding, starts a temporary Cloudflare Quick Tunnel, and prints the public `https://*.trycloudflare.com` URL once. Keep the script running while the tunnel is needed; Ctrl+C stops it. Quick Tunnel URLs are temporary and are not a replacement for a named Cloudflare Tunnel/domain in a long-lived production deployment.

Recommended non-conflicting host ports when environments share one host:

| Environment | Housiy HTTP | MySQL (loopback only) |
|---|---:|---:|
| DEV | `8081` | `3307` |
| UAT | `8082` | `3308` |
| PROD | `80` | `3309` |

Only Nginx publishes the application port. PHP-FPM (`9000`), realtime (`8090`), Redis (`6379`) and MySQL's container port (`3306`) remain private to the Compose network; the optional phpMyAdmin port (`8089`) binds to loopback and is available only under the `debug` profile. Never expose the database port publicly. Cloudflare should target the selected local application port.

## Realtime troubleshooting (WebSocket failures)

The browser connects to the same-origin endpoint `/ws?room=ROOMCODE`; Nginx proxies it to the `realtime` service on port 8090. The browser console logs the WebSocket close code/reason. The gateway logs rejected upgrades with an HTTP status and reason, which is more useful than the browser's generic `WebSocket connection failed` message.

On the deployment host, from `deployment/docker`, inspect:

```sh
docker compose --env-file .env.dev ps
docker compose --env-file .env.dev logs --tail=150 realtime app
```

Check that `realtime` reports `redis ready, subscribed to housiy:events`, that `/ws` is routed through the Nginx `app.conf`, and that the gateway's `WS_AUTH_URL` points to `http://app:8080/api/ws_auth.php`. A 401 indicates session/room membership authorization, 403 indicates an Origin mismatch, 429 indicates WebSocket rate limiting, and 503 usually means Redis/gateway availability or the per-room socket limit. Do not expose port 8090 directly; access it through Nginx and the existing tunnel.


## 10. WebSocket + Redis event-driven operation (current implementation)

### 10.1 Connection model

The supplied archive's existing frontend is static HTML with shared vanilla JavaScript (it is not a React application). To preserve the current UI and avoid a rewrite, the centralized socket manager is implemented in `src/assets/js/common.js` and consumed by the existing host/player/reaction scripts. A React conversion is intentionally not introduced as part of this migration.

- The player and host pages share `startRealtime()` in `src/assets/js/common.js`; it creates one same-origin `/ws?room=ROOMCODE` connection for that page session. Feature components subscribe to the shared `housiy:realtime` browser event and do not create their own sockets.
- The gateway authenticates the browser's session cookie through the private PHP `ws_auth.php` endpoint. The PHP response supplies the authenticated user ID and room ID. Client-supplied identity, ticket ID, role, or winner fields are not accepted as authority.
- A gateway has one Redis Pub/Sub subscription to `{REDIS_PREFIX}:events`, not one Redis subscription per player. Room membership is maintained in a local connection registry; room broadcasts are fanned out only to the relevant local sockets.
- The gateway pings clients every 25 seconds and terminates clients that miss a pong cycle. Slow consumers are disconnected at `WS_MAX_BUFFERED_BYTES`; clients reconnect with exponential backoff and jitter.
- The browser is WebSocket-first, not WebSocket-only. If the socket errors, closes, fails its upgrade, or does not deliver the authenticated `HELLO` within 8 seconds, the shared manager enters HTTP fallback and immediately refreshes the canonical room snapshot, then polls the page's existing snapshot callback every 1.5 seconds. The retrying WebSocket continues in parallel. On `HELLO`, fallback timers stop and one canonical snapshot reconciles state. While connected, called-number and ticket-mark events update the existing DOM locally; they do not trigger ticket/results HTTP requests. Canonical snapshots are limited to initial load/reconnect, explicit room sync, lifecycle/roster/winner changes, and detected sequence gaps. Polling pauses while the tab is hidden and resumes on visibility if the socket is still down.
- Number marks, prize claims and emoji sends use the WebSocket while connected and their existing authenticated REST endpoints when disconnected. Server-side validation remains authoritative in either path. A command whose socket response is lost during a network break can be retried through REST; endpoints must remain idempotent/transactionally guarded to avoid duplicate effects.
- Emoji cursor polling (2 seconds) and expanded-history refresh (15 seconds) are enabled only while the shared room socket is disconnected; both stop on successful `HELLO`. Incoming reactions are delivered over the shared socket; the history card remains user-expanded and only refreshes after a received reaction while expanded or an explicit user expansion.
- A per-gateway Redis sorted-set presence key is maintained at `{prefix}:room:{room_code}:presence:{gateway_instance}`. The key expires after 60 seconds if a gateway crashes. Members represent socket sessions, not durable room membership. MySQL remains authoritative for actual participants.
- On gateway shutdown, connected clients receive close code 1012 and reconnect to another healthy gateway. The client fetches a canonical snapshot after the next successful handshake.

### 10.2 Event envelope and commands

Server events use `{event,event_id,room_id,room_code,sequence,data}`. PHP assigns a unique 128-bit event ID and occurrence timestamp; the gateway resolves the authenticated room ID from the handshake. During rollout, legacy `t/e/v/r` fields are also sent for compatibility. Room-wide event versions are monotonic Redis `INCR` values and remain persistent; reactions and user-targeted ticket marks do not increment the room-wide version. A detected version gap triggers a canonical REST snapshot.

Supported WebSocket commands:

- `MARK_NUMBER` -> existing `mark.php` business logic; a rejected mark is returned as `MARK_REJECTED` to the requesting socket.
- `CLAIM_PRIZE` -> existing `claim.php` business logic and its MySQL transaction.
- `SEND_EMOJI_REACTION` -> existing `reactions.php` transactional/outbox logic. If the socket is not connected, the explicit user action still uses the same REST endpoint.
- `JOIN_ROOM`, `LEAVE_ROOM`, `REQUEST_ROOM_SYNC`, and `ACK_EVENT` are protocol controls. The handshake itself is the authenticated room subscription; `JOIN_ROOM` does not create a second membership or ticket.

The gateway forwards only a strict endpoint whitelist to PHP and forwards the browser's session cookie. PHP repeats authentication, room membership, rate-limit, ticket ownership, called-number, reaction-target and winner validation. The WebSocket payload never supplies a trusted user identity.

### 10.2.1 Event coverage

The current source emits `NUMBER_CALLED`, `NUMBER_MARKED`, `TICKET_UPDATED`, `PLAYER_JOINED`, `EMOJI_REACTION`, `PRIZE_CLAIMED`, `WINNER_DECLARED`, `GAME_STARTED`, `GAME_PAUSED`, `GAME_RESUMED`, `GAME_FINISHED`, and `ROOM_STATE_SYNC`. `MARK_REJECTED` is a direct command response to the requesting socket. `PLAYER_LEFT` is intentionally not emitted: disconnecting a browser does not remove a player from the durable room roster, and this application version has no explicit leave-room business operation. `ACK_EVENT` is accepted as a client receipt but is not a durable event acknowledgement because Redis Pub/Sub is not a replayable queue.

### 10.3 Number marking atomicity

`mark.php` still loads ticket ownership and ticket grid from trusted server-side cache/MySQL. It warms `{prefix}:ticket:{ticket_id}:numbers` from that trusted grid and uses the monotonic `{prefix}:called:{game_id}` set. `MarkBuffer::buffer()` now runs one Lua script which checks both Redis sets and enqueues the mark into the pending/dirty structures atomically. An uncalled number or a number absent from the trusted ticket set is rejected. The browser's optimistic green cell remains only a presentation state; server acceptance is authoritative.

If Redis or the persistence worker is unavailable, the existing safe synchronous MySQL fallback remains in place: MySQL validates the called number and `INSERT IGNORE` persists the mark. The system does not silently accept a mark based only on browser state. The write-behind worker remains idempotent and acknowledges pending marks only after MySQL commit.

### 10.4 Winner and reaction authority

- `claim.php` is still the only winner authority. It locks the room row, validates called and marked numbers, enforces Full House prerequisites, and inserts the winner inside a MySQL transaction. The unique room/prize constraint prevents two simultaneous winners for the same exclusive prize.
- Emoji writes still use the existing MySQL transaction and durable reaction outbox; Redis Pub/Sub is delivery only, never the durable queue. Room-wide and private audiences are enforced by the PHP reaction service and the gateway's user filter.

### 10.5 Polling migration report

| Existing behavior | Previous cadence / trigger | New behavior | API disposition |
|---|---|---|---|
| Player ticket (`ticket.php`) | 1.5s only while WebSocket is unavailable | Pushed room event while connected; 1.5s snapshot fallback while disconnected; immediate reconnect snapshot | Retain for fallback/recovery |
| Player results (`results.php`) | Included in initial/fallback snapshots | Refresh on lifecycle, roster/winner changes, explicit sync, reconnect or sequence gap; not every number/mark | Retain for fallback/recovery |
| Host room/results (`results.php`) | 1.5s only while WebSocket is unavailable | Pushed room event while connected; 1.5s snapshot fallback while disconnected | Retain for fallback/recovery |
| Host play-along ticket (`ticket.php`) | Initial/fallback snapshot | Local updates for called numbers and own-ticket marks; canonical refresh on reconnect/gap | Retain for fallback/recovery |
| Emoji live cursor (`reactions.php?action=poll`) | 2s only while WebSocket is unavailable | Reaction payload pushed through shared socket; 2s cursor fallback during outage | Retain for fallback/recovery |
| Emoji history (`reactions.php?action=history`) | 15s while expanded and WebSocket is unavailable | Load on explicit expand; refresh after received reaction while expanded; 15s outage fallback | Retain for user-driven/fallback snapshot |
| Emoji participants (`reactions.php?action=players`) | Initial load / opening target picker | Initial load and `PLAYER_JOINED` update | Retain for participant snapshot |
| Admin dashboard (`admin_dashboard.php`) | 30s | Unchanged; admin dashboard is outside the player/host game socket session | Retain |

UI countdown intervals (game timer and auto-call countdown) are local presentation timers; they do not issue HTTP requests. In healthy WebSocket mode there are no recurring ticket/results/reaction polling requests, and high-frequency number/mark events do not trigger snapshot reads. During an outage, HTTP fallback deliberately restores those reads so gameplay continues. Authentication, room creation/join, game controls, exports, admin actions, explicit history reads and initial page snapshots remain REST operations.

### 10.6 Redis key strategy

All keys below are prefixed by `REDIS_PREFIX`:

| Key | Type | Purpose / expiry |
|---|---|---|
| `events` | Pub/Sub channel | Room event distribution; non-durable |
| `room:{code}:v` | String counter | Monotonic room event sequence; persistent (no TTL) |
| `room:{code}:presence:{gateway_instance}` | ZSET | Gateway-local socket presence; 60s TTL refreshed every heartbeat batch |
| `rs3:{room_code}:{version}` | String/JSON | Versioned room read-model snapshot shared by `ticket.php` and `results.php`; 30s TTL |
| `mem:{room_id}:{user_id}` | String | Cached immutable room membership fact; 300s TTL |
| `called:{game_id}` | SET | Monotonic called numbers; currently 6h cache TTL and rebuilt from MySQL on miss |
| `ticket:{ticket_id}:numbers` | SET | Trusted immutable ticket-number membership; persistent while retained, hydrated from ticket grid |
| `mkp:{ticket_id}` | SET | Accepted pending marks; no TTL; removed only after MySQL commit |
| `mkdirty` | SET | Tickets awaiting persistence; no TTL |
| `mkdirtyts` | ZSET | Oldest pending timestamp per ticket; removed after commit |
| `mkv:{ticket_id}` | String | Mark generation for cache-hydration race protection; short recovery TTL |
| `mkc2:{ticket_id}` | SET | Disposable marked-number read cache; 2s TTL |
| `tk:{room_id}:{user_id}` | String/JSON | Trusted ticket ID/grid cache; 300s TTL |
| `rc:{room_code}` / `gid:{room_id}` | String | Room/game ID caches; 300s TTL |
| `room:{room_id}:called` / `room:{room_id}:state` | — | Reserved target names; not yet the authoritative storage path in this version |
| `room:{room_id}:players` | — | Participant roster remains MySQL-backed; no Redis participant roster is used as authority |

Active accepted mark queues and the dirty-ticket index do not expire. Redis Pub/Sub is explicitly non-durable. MySQL reaction outbox and Redis AOF-backed mark buffer are the recovery mechanisms already present in this codebase.

### 10.7 Metrics and limits

The gateway exposes internal-only `GET /metrics` counters: active connections, active rooms, Redis readiness, cumulative accepted connections, received messages, broadcast deliveries/bytes, command count and command failures. Presence heartbeats are batched once per room/gateway every 25 seconds, rather than issuing one Redis round trip per player. `/healthz` reports readiness and current connection/room counts. Compose exposes no public gateway port; Nginx proxies `/ws` internally.

`WS_MAX_PER_ROOM` defaults to 110 (100 players plus host/operator), `WS_MAX_CONNECTIONS` defaults to 12,000, `WS_MAX_BUFFERED_BYTES` defaults to 65,536, and `WS_COMMAND_TIMEOUT_MS` defaults to 10,000. These are guardrails, not proof of capacity. Validate the actual target on the deployment host with persistent WebSocket tests and OS file-descriptor/memory limits.

### 10.8.1 Build and deploy the WebSocket migration

No database migration or schema change is required for this implementation. Keep the existing MySQL volume and existing `sql/schema.sql`; do not run `down -v`. From the repository root in Git Bash, rebuild the PHP and gateway images and recreate the application services:

```bash
MSYS_NO_PATHCONV=1 docker compose \
  --project-directory deployment/docker \
  --env-file deployment/docker/.env.dev \
  -f deployment/docker/docker-compose.yml \
  up -d --build --force-recreate php realtime worker app

MSYS_NO_PATHCONV=1 docker compose \
  --project-directory deployment/docker \
  --env-file deployment/docker/.env.dev \
  -f deployment/docker/docker-compose.yml ps

MSYS_NO_PATHCONV=1 docker compose \
  --project-directory deployment/docker \
  --env-file deployment/docker/.env.dev \
  -f deployment/docker/docker-compose.yml logs --tail=100 php realtime worker
```

Verify the gateway from inside its container (the gateway port is not published publicly):

```bash
docker compose --project-directory deployment/docker --env-file deployment/docker/.env.dev -f deployment/docker/docker-compose.yml exec realtime wget -qO- http://127.0.0.1:8090/healthz
docker compose --project-directory deployment/docker --env-file deployment/docker/.env.dev -f deployment/docker/docker-compose.yml exec realtime wget -qO- http://127.0.0.1:8090/metrics
```

Run the browser contract test with `node realtime/test/client.test.js`. Run the persistent socket test only against a prepared DEV environment; the script requires free seats and room codes as documented in `LoadTest.md`.

### 10.8.2 Failure and recovery boundaries

- Redis unavailable: the gateway refuses new upgrades and closes existing sockets; clients reconnect with jitter. Number marking uses the existing synchronous MySQL validation/insert fallback. Real-time delivery is unavailable until Redis recovers; clients refresh a snapshot after reconnect.
- Gateway restart: clients receive close code 1012 (or detect a lost TCP connection), reconnect, authenticate again, and fetch the canonical snapshot. Redis Pub/Sub events published while a gateway is down are not replayed.
- Redis state loss: room/game/ticket/winner data is rebuilt from MySQL snapshots. The called-number set is rehydrated from MySQL on cache miss. Pending marks rely on Redis AOF (`appendfsync everysec`) plus the worker; a hard crash can still lose the most recent fsync interval (roughly up to one second). This is not a zero-loss durable queue.
- MySQL unavailable: authoritative claim and persistence operations fail; claims are never awarded from Redis alone. The worker retains pending Redis marks and retries when MySQL returns.
- Pub/Sub duplicate/out-of-order/missed events: clients deduplicate by `event_id`, track room sequence numbers, ACK receipt, and request a canonical snapshot on a gap or out-of-order event. ACKs are informational only; there is no durable replay log.
- Concurrent claims: the existing MySQL room lock and unique room/prize key serialize the winner decision.

### 10.8 Verification status and capacity claims

The source includes existing API, UI, E2E, race and k6 suites. The updated browser contract test is `node realtime/test/client.test.js`. Run PHP syntax checks and all suites before deployment. No 10,000-connection capacity claim is made by this source handoff: it requires a dedicated run with 10,000 simultaneous open sockets, per-room fan-out, reconnect storms, Redis restart, gateway restart and concurrent winner claims, with p50/p95/p99 and dropped/duplicate event measurements recorded.


### 10.9 Modified-file inventory

**Modified:**

- `Dockerfile` — PECL Redis source-tarball install to avoid the previously observed PECL channel release lookup failure.
- `README.md`, `LoadTest.md` — architecture, key strategy, polling report, deployment and test documentation.
- `deployment/docker/docker-compose.yml`, `deployment/docker/.env.example`, `.env.dev`, `.env.uat`, `.env.prod` — gateway limits, command timeout and process/FD settings.
- `realtime/server.js`, `realtime/test/client.test.js` — event envelope, authenticated command bridge, presence, deduplication/metrics and contract tests.
- `src/includes/Realtime.php`, `src/includes/MarkBuffer.php`, `src/includes/GameEngine.php` — event IDs/payloads and atomic Redis mark validation.
- `src/api/ws_auth.php`, `mark.php`, `claim.php`, `room_join.php` — room identity, marking, claim and join event payloads.
- `src/assets/js/common.js`, `page-player.js`, `page-host.js`, `emoji-reactions.js`, `style.css` — shared socket manager, commands, event subscriptions, polling removal and preservation of the latest ticket CSS adjustments.
- `tests/load/websocket.js` — persistent connection test without periodic HTTP heartbeat snapshots.

**Added:** no new source files. **Removed:** the standalone `sql/migrations/20261101_user_blocks.sql`; the complete `user_blocks` definition is kept in the single fresh-install `sql/schema.sql`. **Database:** use `sql/schema.sql` for a fresh database; there is no separate migration file in this ZIP.


### Emoji reaction reliability and live history count

- Each browser reaction send creates one 128-bit idempotency key and reuses it if the same action is retried over HTTP after a WebSocket interruption.
- PHP persists `(room_id, sender_user_id, idempotency_key) -> reaction_id` in `room_reaction_idempotency` in the same MySQL transaction as the reaction and outbox row. Replays return the original reaction ID and do not insert or publish a second reaction.
- The idempotency record is retained for the same 24-hour window as reactions.
- The reaction-history badge is initialized from the server-side count visible to the current user, incremented once for each newly observed visible reaction (WebSocket or HTTP fallback), and reconciled to the exact count whenever history is expanded/refreshed.
- Expanded history refreshes after incoming reactions. Private reactions remain visible only to their sender and recipient, and the badge count follows the same visibility rules.
- Fresh installs create `room_reaction_idempotency` from `sql/schema.sql`; existing installs create it lazily through the Reactions table guard on first use.


## Super-admin controls and report privacy
- Super-admin reports support PDF and Excel only; CSV export is not included.
- Every report export opens an email-privacy prompt with masking enabled by default. Uncheck it to export full email addresses.
- Hosts, players, and users can be blocked/unblocked from the admin dashboard. Blocking revokes active session tokens and prevents the normalized email/name from authenticating again.
- Host room deletion is available for Lobby and Completed rooms. Live/Paused rooms must be ended first. Room deletion broadcasts `ROOM_DELETED`; connected clients return to the home page. A host whose room is missing/deleted is also redirected home.
- The `user_blocks` table is defined in the single consolidated `sql/schema.sql`; no separate SQL migration file is included. For an existing database, check whether `user_blocks` already exists before applying the table definition from the main schema.


### Admin improvements included in this handoff

- Global and room report exports show the email privacy dialog first. The checkbox defaults to checked; masked output is the default. Unchecking it includes full email addresses. This applies to PDF and Excel exports; CSV export is intentionally not included.
- PDF global reports now respect the selected Rooms, Hosts, Players, or Users view. Room PDF reports mask host, player, and winner email addresses consistently.
- Block/unblock status is calculated from the normalized blocked identity as well as the user ID, so duplicate/legacy identity rows display the correct access state. Blocking revokes matching sessions; unblocking removes matching identity-level block records.
- Host deletion of an existing room returns to `index.html`; if the room was already deleted or cannot be found, the host dashboard also redirects home.
- The admin changes do not modify the WebSocket, room snapshot fallback, or reaction realtime code paths.
- All required table definitions remain in `sql/schema.sql`; there is no standalone migration file.


### Fresh database schema

The `room_rematch_declines` table is included in `sql/schema.sql` for fresh installations; no separate rematch migration is needed. Import the complete `sql/schema.sql` into a newly created database.
