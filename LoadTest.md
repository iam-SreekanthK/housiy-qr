# Housiy Load Testing — Real Docker Containers Only

## Safety and execution model

All HTTP/WebSocket load tests must target the already-running **real DEV Compose stack** through the published port of its `app` Nginx container. k6 runs directly on the operator's host. This workflow does not build, start, stop, recreate or use any test containers, test-only proxy, PHP built-in server, temporary Redis server, or temporary MySQL database. It never runs against production and the provided runner rejects non-local targets.

The regular stack services are `app` (Nginx), `php` (PHP-FPM), `worker`, `realtime`, `redis`, and `db`. The load runner checks that these real containers exist and are running before sending traffic. Start DEV separately using the application guide in the root `README.md`.

## Prerequisites

- Docker Engine + Compose v2, with the `housiy-dev` project already healthy.
- `deployment/docker/.env.dev` configured with `APP_ENV=dev` and DEV-only DB/Redis credentials.
- k6 installed on the host (`k6 version`). Do not run k6 in a Docker container for this workflow.
- For persistent WebSocket tests, prepare DEV lobby rooms with free seats. Each room has 100 seats including its host, so it has at most 99 free player seats.
- Adequate CPU, RAM and DB capacity. High-load scenarios create real room/player/game records in the DEV database; use only disposable DEV data.

## Recommended staged run

Run from the repository root (Linux/macOS shell or Git Bash):

```bash
# 1. Quick functional check against the real app container.
SCENARIOS=smoke bash tests/load/run-load-tests.sh

# 2. Focus on results endpoint latency.
SCENARIOS=results bash tests/load/run-load-tests.sh

# 3. Progressive workload, stress, multi-room and soak scenarios.
SCENARIOS="load load30 stress fullgame_smoke multiroom normal players100 stress25x100 soak" \
  bash tests/load/run-load-tests.sh

# 4. Rate-limit assertions. Use a clean DEV rate-limit namespace/data set.
SCENARIOS=ratelimit bash tests/load/run-load-tests.sh

# 5. Optional highest-cost scenario: 100 rooms × 100 simulated players.
INCLUDE_CAPACITY=YES SCENARIOS=smoke bash tests/load/run-load-tests.sh
```

The last example runs the normal scenarios plus `capacity`; it can generate significant traffic. Use it only on a dedicated DEV machine/stack after smaller scenarios pass. If you want only capacity, use `SCENARIOS=capacity` (no `INCLUDE_CAPACITY` flag is needed).

The runner never starts or stops containers. It checks the six real service containers and uses `APP_PORT` from `deployment/docker/.env.dev` to set `BASE_URL`. It runs the k6 binary on the host and stops at the first failed scenario. Per-scenario reports are stored under `tests/load/results/<timestamp>/<scenario>/`: `summary.json`, `summary.html`, `junit.xml` and `metrics.json`. The overall run status is stored at `tests/load/results/<timestamp>/status.txt`.

## Available scenarios

| Scenario | Purpose | Relative load |
|---|---|---|
| `smoke` | Small end-to-end game flow to validate setup | Very low |
| `results` | Repeated results endpoint measurements | Low |
| `load` | Steady baseline workload | Low/moderate |
| `load30` | Ramp to 30 VUs | Moderate |
| `stress` | Ramp to 60 VUs | High |
| `ratelimit` | Rate-limit correctness, status codes and headers | Burst traffic |
| `fullgame_smoke` | One room with a few players | Very low |
| `multiroom` | 5 concurrent rooms × 10 players | Moderate |
| `normal` | 10 concurrent rooms × 25 players | High |
| `players100` | 10 rooms × 100 players | Very high |
| `stress25x100` | 25 rooms × 100 players | Extreme |
| `soak` | Sustained 15-VU run for about 22 minutes | Sustained |
| `capacity` | 100 rooms × 100 players | Maximum/opt-in |

The `rooms100players100` alias is available directly in `main.js`, but `capacity` is the recommended name. The default runner sequence excludes capacity unless `INCLUDE_CAPACITY=YES` is set.

## Run a single scenario directly

The wrapper is recommended because it validates the actual DEV Compose services and records results. If running k6 directly, first verify that the real DEV stack is healthy, create the report directory, then set the published app URL explicitly:

```bash
mkdir -p tests/load/results
BASE_URL=http://127.0.0.1:8081 TARGET_ENV=dev SCENARIO=smoke \
  k6 run tests/load/main.js
```

Replace port `8081` with `APP_PORT` from `.env.dev` if you customized the DEV port. The k6 script independently probes `/api/env.php`, verifies the environment, and refuses production. Direct runs should still be restricted to localhost DEV.

Useful per-run variables:

- `MAX_REACTIONS_PER_ROOM` — maximum total reaction POST attempts per simulated room across **both** room-wide (`everyone`) and private (`player`) reactions; defaults to `100`, split up to 50 per audience. The cap counts attempts, not only successful sends, and each simulated user sends at most one reaction per audience to avoid hitting the per-user cooldown repeatedly. Set to `0` to disable reaction traffic. This only tunes load-test traffic; it does not change the production/API reaction policy.
- `BASE_URL` — local published app URL; runner sets it from `.env.dev`.
- `TARGET_ENV=dev` — required by the wrapper.
- `SCENARIOS` — whitespace-separated scenario list to run.
- `INCLUDE_CAPACITY=YES` — append the 100 × 100 capacity test.
- `PLAYERS_PER_ROOM`, `ROOMS`, `ITERATIONS`, `MAX_DURATION` — tune a preset/scenario where supported.
- `RESULTS_VUS`, `RESULTS_ITERATIONS`, `RESULTS_P95_MS` — results-specific load and latency budget.
- `THRESH_P95_MS` — p95 budget for full-game preset scenarios (default 300 ms).
- `THRESH_P99_MS` — p99 budget for full-game preset scenarios (default 500 ms).
- `PLAYER_POLL_EVERY_N_CALLS=0` — disable the synthetic player HTTP polling wave to isolate gameplay endpoint load; the default `5` keeps the polling workload in the normal HTTP stress profile.

## What each full-game iteration exercises

The k6 flow uses real HTTP requests and separate cookies per simulated actor. It creates a room, joins players, starts the game, calls numbers, marks numbers, attempts a claim, ends the game, and fetches results. Emoji traffic is capped at 100 total reaction POST attempts per room by default across room-wide and private audiences combined (up to 50 each). To avoid artificial 429 bursts, each scheduled reaction wave sends at most one POST, with randomized pacing across concurrently running rooms; unique actors are used per audience to avoid repeat sends from the same simulated user triggering the per-user 429 cooldown. Any reaction 429 remains a test failure and must be diagnosed, not ignored. It checks business failures, unexpected 4xx/5xx, transport errors, duplicate winners and endpoint latency. The results scenario repeats `GET /api/results.php` against a real room created by that run.

## Metrics and reports

Each scenario produces `summary.json` (machine-readable metrics and thresholds), `summary.html` (human-readable report), `junit.xml` (CI threshold results) and `metrics.json` (raw k6 time-series output). The wrapper writes `status.txt` at the timestamped run directory with each scenario pass/fail result.

Compare p50/median, p90, p95, p99, max, request rate, failed requests, and scenario-specific counters. Do not call performance fixed based only on a passing syntax check or one successful smoke run. Compare equivalent workloads before and after a change and record CPU/memory, PHP-FPM queue/max-children, MySQL active connections/slow queries/locks, Redis latency/command counts, worker heartbeat/queue depth, and Nginx upstream timings during the same interval.

## Monitoring while a run is active

In another terminal:

```bash
# Application and infrastructure logs
bash deployment/docker/envctl.sh dev logs app
bash deployment/docker/envctl.sh dev logs php
bash deployment/docker/envctl.sh dev logs worker
bash deployment/docker/envctl.sh dev logs realtime
bash deployment/docker/envctl.sh dev logs db
bash deployment/docker/envctl.sh dev logs redis

# Worker persistence/heartbeat state
DC='docker compose --project-name housiy-dev --env-file deployment/docker/.env.dev -f deployment/docker/docker-compose.yml'
docker compose --project-name housiy-dev --env-file deployment/docker/.env.dev \
  -f deployment/docker/docker-compose.yml exec -T worker php /var/www/bin/status.php --json

# Resource snapshot for the real containers
docker stats --no-stream $(docker compose --project-name housiy-dev \
  --env-file deployment/docker/.env.dev -f deployment/docker/docker-compose.yml ps -q)
```

For timing instrumentation, set `PERF_LOG_ENABLED=1` and `PERF_SLOW_MS=100` in the DEV environment file and recreate the DEV app services using the documented env controller. Keep `PERF_SERVER_TIMING=0` unless the test environment is trusted. Full request logging adds overhead, so perform a final benchmark with normal logging disabled after diagnosis.


## Persistent WebSocket connection-capacity test

The HTTP full-game scenarios do not prove persistent WebSocket capacity. Use `tests/load/websocket.js` separately against the same real DEV Compose stack. It joins each simulated player to a pre-created lobby room, authenticates through the real session cookie and holds the WebSocket open for the configured duration. It performs one canonical ticket snapshot reconciliation after HELLO and another only when a sequence gap is detected. Ordinary pushed events (including reactions) are consumed over WebSocket and do not trigger ticket/results HTTP requests. WebSocket ping/pong maintains transport liveness.

Prepare enough DEV lobby rooms with free seats and collect their room codes. A room has 100 seats including its host, so the test can add at most 99 player connections per room. The script requires `ceil(WS_CONNECTIONS / WS_ROOM_CAPACITY)` room codes.

```bash
# Example: 500 persistent player WebSockets, 6 lobby rooms, 5-minute hold.
BASE_URL=http://127.0.0.1:8081 TARGET_ENV=dev \
ROOM_CODES=ROOMCODE1,ROOMCODE2,ROOMCODE3,ROOMCODE4,ROOMCODE5,ROOMCODE6 \
WS_CONNECTIONS=500 WS_ROOM_CAPACITY=99 WS_DURATION=5m \
WS_START_STAGGER_MS=5000 \
REPORT_DIR=tests/load/results/ws-500 \
k6 run --out json=tests/load/results/ws-500/metrics.json tests/load/websocket.js

# Or use the guarded runner (DEV only; validates existing Compose services):
ROOM_CODES=ROOMCODE1,ROOMCODE2,ROOMCODE3 WS_CONNECTIONS=500 \
  WS_DURATION=5m bash tests/load/run-websocket-load.sh
```

Create the report directory before running (`mkdir -p tests/load/results/ws-500`). Increase gradually using a fresh set of lobby room codes for each run (each run joins new test users):

```bash
BASE_URL=http://127.0.0.1:8081 TARGET_ENV=dev WS_DURATION=5m \
ROOM_CODES="$ROOM_CODES_100" WS_CONNECTIONS=100 \
k6 run tests/load/websocket.js

BASE_URL=http://127.0.0.1:8081 TARGET_ENV=dev WS_DURATION=5m \
ROOM_CODES="$ROOM_CODES_1000" WS_CONNECTIONS=1000 \
k6 run tests/load/websocket.js

BASE_URL=http://127.0.0.1:8081 TARGET_ENV=dev WS_DURATION=5m \
ROOM_CODES="$ROOM_CODES_5000" WS_CONNECTIONS=5000 \
k6 run tests/load/websocket.js

BASE_URL=http://127.0.0.1:8081 TARGET_ENV=dev WS_DURATION=5m \
ROOM_CODES="$ROOM_CODES_9900" WS_CONNECTIONS=9900 \
k6 run tests/load/websocket.js
```

Increase gradually: 500, 1,000, 2,500, 5,000, then 9,900 player sockets (100 rooms × 99 player seats). At every step, check successful handshakes, connection latency, event snapshot failures, gateway CPU/memory, Redis Pub/Sub, PHP-FPM queue and MySQL load. There should be no periodic ticket snapshot traffic while sockets remain healthy. For an exact 10,000-socket target across 100 full rooms, include the 100 host WebSocket sessions as well; this script currently simulates player sockets and does not connect the pre-existing room hosts. The script validates persistent connections, a single HELLO snapshot, and gap-triggered recovery; it does not by itself measure event fan-out latency under a simultaneous event producer workload.

The test has its own `summary.json`, `summary.html` and `junit.xml` output via `REPORT_DIR`. Never run it against production. The load generator itself must have enough CPU, RAM and file descriptors; a generator bottleneck invalidates the capacity result.

## Review of uploaded 2026-10-31 results

The following is an analysis of the supplied reports and logs, not a new load test executed in this environment. The newest K6 run started at `2026-10-31T09:48:43Z`, lasted about 134.6 seconds and used scenario `stress25x100`.

| Metric | Latest run |
|---|---:|
| Logical player journeys | 2,500 |
| Rooms completed | 25 |
| HTTP requests | 66,453 (~494 requests/sec) |
| HTTP request P95 / P99 | 180.24 ms / 262.97 ms |
| HTTP failures / 429 / 5xx / unexpected 4xx | 0 / 0 / 0 / 0 |
| Business failures / duplicate winners | 0 / 0 |
| Marks accepted | 28,169 |
| Valid claims / expected rejected claims | 125 / 345 |
| Reaction failures | 0 |

Endpoint P95 latency in the latest run: claim 256.98 ms; `game_next` 243.65 ms; reaction send 242.03 ms; ticket 183.92 ms; mark 170.05 ms; results 110.87 ms; room create 88.93 ms; room join 92.64 ms. All 14 JUnit thresholds in the uploaded report passed, but the full-game preset was using a default P95 threshold of 1,500 ms. That budget was too permissive for these endpoints. The source has now been tightened to default P95 300 ms and P99 500 ms for full-game preset runs; the recorded P95/P99 values for the endpoints present in this report are below those budgets. The uploaded JUnit file still reflects the old 1,500 ms thresholds, so rerun the scenario to produce a report that validates the new assertions. Override with `THRESH_P95_MS` / `THRESH_P99_MS` only when the test plan justifies it.

### Infrastructure evidence, Run B (same window, 15:18:21–15:21:07 IST)

- Docker stats: PHP peaked at 421.74% CPU (~4.2 cores), MySQL at 128.12%, Redis at 78.34%, Nginx at 57.15%; peak observed memory was approximately 74 MiB PHP, 479 MiB MySQL and 12 MiB Redis.
- PHP-FPM full status: 72 snapshots; all 40 workers existed; active workers reached 40 in 21/72 snapshots; listen queue was nonzero in 29/72 snapshots; average sampled current queue was 6.79 and maximum current queue was 50; historical `max listen queue` reached 74.
- `slow requests=0` does not contradict queueing: the FPM slowlog threshold is 3 seconds, while the measured API requests were mostly below that threshold.
- Memory was not the observed constraint. The direct evidence points to PHP-FPM worker saturation and CPU/DB/Redis contention during the burst. Do not raise `pm.max_children` blindly; first correlate PHP `[perf]` spans, Nginx upstream timings, MySQL query/lock timings and Redis timings.
- The uploaded Docker/FPM logs do not include the matching PHP application `[perf]` log stream or Nginx access log stream. The exact SQL/Redis sub-operation responsible for the slowest requests therefore cannot be identified from these files alone.

### Comparison of Run A (2026-10-31T08:53:12Z) and Run B (2026-10-31T09:48:43Z)

Both runs are scenario `stress25x100` against the same DEV stack (`http://127.0.0.1:8081`, 25 VUs, 25 rooms, 2,500 player journeys, 2,475 joins + 25 hosts). Run A: 131.7 s, 64,887 requests (492.5/s), 1,651 numbers called, 27,465 marks, 340 reactions, 125 valid and 330 expected-rejected claims, 99.4 MB received / 17.6 MB sent. Run B: 134.6 s, 66,453 requests (493.8/s), 1,688 numbers called, 28,169 marks, 350 reactions, 125 valid and 345 expected-rejected claims, 101.9 MB received / 18.0 MB sent. Both: 0 HTTP failures, 0 × 429, 0 × 5xx, 0 unexpected 4xx, 0 transport failures, 0 business failures, 0 duplicate winners, 0 reaction failures. All times in ms.

| Endpoint | A P50 | B P50 | A P95 | B P95 | Δ P95 (ms / %) | A P99 | B P99 | Δ P99 (ms / %) | A max | B max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Overall HTTP (`http_req_duration`) | 68.9 | 67.2 | 165.5 | 180.2 | +14.7 / +8.9% | 213.5 | 263.0 | +49.5 / +23.2% | 419.8 | 573.0 |
| ticket | 77.3 | 72.1 | 172.6 | 183.9 | +11.3 / +6.5% | 219.3 | 266.4 | +47.1 / +21.5% | 419.8 | 489.3 |
| results | 37.9 | 27.6 | 155.2 | 110.9 | -44.3 / -28.6% | 181.7 | 144.9 | -36.7 / -20.2% | 195.3 | 163.2 |
| mark | 57.7 | 59.3 | 149.5 | 170.1 | +20.6 / +13.8% | 191.9 | 249.1 | +57.3 / +29.8% | 351.5 | 429.4 |
| claim | 120.0 | 115.8 | 224.7 | 257.0 | +32.3 / +14.4% | 270.0 | 316.0 | +46.0 / +17.0% | 419.1 | 573.0 |
| game_next | 101.3 | 104.7 | 214.8 | 243.7 | +28.9 / +13.4% | 266.2 | 324.2 | +58.0 / +21.8% | 336.4 | 438.6 |
| reaction send | 92.4 | 104.3 | 215.1 | 242.0 | +26.9 / +12.5% | 267.9 | 338.7 | +70.8 / +26.4% | 386.7 | 406.6 |
| room create | 63.9 | 64.7 | 97.1 | 88.9 | -8.2 / -8.4% | 116.4 | 95.5 | -20.8 / -17.9% | 121.6 | 97.3 |
| room join | 68.3 | 66.2 | 102.4 | 92.6 | -9.8 / -9.6% | 137.2 | 104.8 | -32.4 / -23.6% | 194.0 | 142.6 |
| game start | 34.6 | 39.8 | 57.9 | 51.7 | -6.3 / -10.8% | 61.3 | 55.5 | -5.8 / -9.4% | 61.4 | 56.7 |

Reading the table honestly:

- **Medians are essentially unchanged (±1–12 ms); the movement is in the tails** (P95 +6 % to +14 %, P99 +17 % to +30 % for ticket/mark/claim/game_next/reaction). Run B did ~2.4 % more total work and ran 2.8 s longer, so part of the shift is workload. Two runs are not enough to separate a regression from run-to-run variance; repeat each configuration at least three times before attributing a difference to code.
- Results, room create/join and game start were *faster* in Run B (−8 % to −29 % P95). A change that helped some endpoints and hurt others within one hour points to environmental variance (host CPU contention, container warm state) rather than one code change.
- Run A's FPM counters were **not reset**: its first snapshot already shows `max listen queue = 66`, which cannot be attributed to Run A (it stays 66 through the run). Run B started from a freshly restarted pool (`max listen queue 0`, `max active 1`) and finished at `max listen queue 74`, `max active 40`, so Run B's historical counters *are* attributable to Run B.

### Infrastructure evidence, Run A (same window, 14:22:58–14:25:42 IST)

- Docker CPU (21 samples, ~8 s apart so true peaks may be higher): PHP peak 409.7 % / avg 197.2 %, MySQL peak 134.3 % / avg 66.3 %, Redis peak 74.9 % / avg 40.2 %, Nginx (`app`) peak 55.8 % / avg 27.7 %, realtime peak 11.1 %, worker peak 11.6 %. Peak memory ≈ 80 MiB PHP, 507 MiB MySQL, 15 MiB Redis.
- FPM (70 snapshots, ~2 s apart): all 40 workers busy in 19/70 snapshots; current listen queue > 0 in 29/70 (average 6.31, maximum 46); 0 slow requests (slowlog threshold 3 s, so this says nothing about sub-3 s queueing).
- Run B (37 Docker samples, 72 FPM snapshots): PHP avg 212.6 % / peak 421.7 %, MySQL avg 64.4 % / peak 128.1 %, Redis avg 40.4 % / peak 78.3 %; 40 busy in 21/72, queue > 0 in 29/72 (average 6.79, maximum sampled 50).
- Network/block deltas over each run (start→end of the Docker log): PHP container received ≈ 711 MB (A) / 717 MB (B); Redis sent ≈ 537 / 544 MB and received ≈ 195 / 201 MB; MySQL sent ≈ 110 / 109 MB. These are aggregate container-interface counters, not per-process or per-peer measurements. **They do not establish how many bytes PHP-FPM received from Redis**: the PHP container also exchanges traffic with MySQL and other services, and Redis serves PHP-FPM, the worker and the realtime gateway. Dividing Redis's aggregate TX by HTTP request count would therefore be an unsupported attribution. The shared room-state cache entry (`rs3:*`, which includes the full player list with e-mail addresses) is ≈ 11 KB at 100 players and is fetched and `json_decode`d on ticket/results paths according to the code inspection and local micro-benchmark (11.2 KB / 61 µs decode vs 1.0 KB / 7 µs without the player list). This suggests a candidate optimization, not a measured per-request network cost; `ticket.php` does not use the player list. MySQL block writes ≈ 203 MB (A) / 190 MB (B) and Redis block writes ≈ 48 MB (AOF) are *deltas*, but they were not correlated with latency (no I/O wait data was captured). To attribute Redis traffic, collect per-client Redis command/byte telemetry or application spans tagged by Redis operation and endpoint.
- Interpretation supported by the data: the PHP container averaged ≈ 2.0–2.1 cores and touched ≈ 4.2 cores while FPM sat at 40/40 busy with a non-zero listen queue for ~40 % of samples. At ≈ 493 req/s that is ≈ 4.1 ms (A) – 4.3 ms (B) of PHP-container CPU per request on average. **PHP CPU/worker saturation is the observed limiter in this workload;** memory, MySQL (≈ 0.6–1.3 cores), and Redis (≈ 0.4–0.8 cores) were not saturated in the sampled data. What is *not* known: which PHP/SQL/Redis span inside each endpoint costs the most (no `[perf]` log stream was captured) and whether MySQL had row-lock or buffer-pool pressure (no MySQL status for either run).

### Caveats that affect how far these results can be trusted

- **Rate limiting.** `deployment/docker/.env.dev` currently sets `RATE_LIMIT_ENABLED=0` (allowed in DEV; UAT/PROD are `1`). An older worker-status snapshot reported rate limiting *enabled*, so the setting at the time of Run A/B is unconfirmed. If it was off, `housiy_http_429 == 0` is trivially true and the measured latency excludes the rate limiter's Redis work. Confirm with `docker compose exec php php /var/www/bin/status.php` (or `GET /api/env.php`) before each run and record it in the manifest.
- **Thresholds in the uploaded JUnit are the old budgets.** The 14 uploaded JUnit cases check only P95 < 1,500 ms for seven endpoints and omit `ticket`, `results`, `game_start`, `http_req_duration` and every P99. The current source asserts P95 < 300 ms and P99 < 500 ms (overridable with `THRESH_P95_MS`/`THRESH_P99_MS`) for the full-game preset endpoints. Against the two uploaded runs the tightest margin is claim P95 at 257 ms (86 % of the 300 ms budget) in Run B and the highest P99 is reaction send at 339 ms (68 % of 500 ms), so the recorded summaries appear consistent with those budgets. The uploaded JUnit files still contain the old 1,500 ms thresholds; the tightened thresholds have *not* been executed and reported by K6 in this review.
- **Sampling resolution.** Docker stats were 4–8 s apart; a 1-second CPU spike can be missed. FPM `request duration` in a full-status snapshot is the age of whatever request is in flight, not an endpoint latency.
- **Concurrency.** 25 VUs ran 25 rooms; the 2,500 "players" are logical player journeys executed by those VUs, not 2,500 simultaneously active clients. The K6 scripts use `http.batch()` for some joins, marks, claims, polls and reactions, so one VU can have multiple HTTP requests in flight. VU count is not a hard cap on concurrent HTTP requests; actual in-flight concurrency depends on batch sizes, `batchPerHost`, request timing and the scenario. PHP-FPM's 40 workers and listen queue describe server-side request handling/queueing, not additional K6 client concurrency. These runs did not open persistent WebSocket sessions.

### Changes made in this review

1. `src/includes/RedisConn.php` — under PHP-FPM, Redis now uses a persistent socket (`pconnect`, id derived from host/port/db and a hash of the password) and the AUTH/SELECT/PING handshake is pipelined into one round trip with every reply still checked explicitly (a failed AUTH, bad DB index or dead server still yields `null`, i.e. the existing MySQL-only fallback). CLI processes (worker, tests) keep a normal connection; `REDIS_PERSISTENT=0` restores the old per-request connection, `REDIS_PERSISTENT=1` forces persistence. The accompanying Claude review notes report local tests against Redis (no password, password, wrong password, empty password, invalid DB, server down) and a two-worker PHP-FPM test: 200 requests reportedly opened **201 Redis connections before and 3 after**, with all 200 `INCR`s succeeding. These measurements are author-reported in the supplied review notes; they were not independently reproduced in this review environment (no Redis server or PHP Redis extension was available). The updated `tests/ops/redis-conn-check.php` covers normal connection/round-trip, reset/reconnect, wrong-password and invalid-DB paths. Its `REDIS_TEST_EXPECT_UNAVAILABLE=1` mode explicitly tests endpoints that must reject the connection, including empty-password against an auth-required server and a stopped/unreachable Redis; see `tests/ops/REDIS-CONNECTION-TESTING.md` for exact commands. These integration checks still need to be run on a disposable Redis with ext-redis available. Commands per request were reported as 3 → 4 because phpredis sends one `ECHO` liveness probe when it reuses a pooled socket, while pipelining reduces sequential waits. The effect on K6 latency has **not been measured** (no isolated stack/k6 here); expected benefit is small CPU/Redis-accept savings, not a step change. Repeat the identical `stress25x100` profile at least 3× before and after to see if it moves outside noise.
2. `.gitignore` — `.env.dev`, `.env.uat`, `.env.prod` (and `.env.production`, `.env.loadtest`) are ignored at any depth; `.env.example` stays tracked. The release ZIP contains only `.env.example`; create private environment-specific files locally and inject unique secrets through a secure deployment process before use.
3. `tests/ops/redis-conn-check.php` — new standalone check for the connection factory (run it against a disposable Redis).

Candidate changes **not** applied because the measured gain is too small or cannot be validated without a live stack: (a) a "lite" room-state cache entry without the player list for `ticket.php` (≈ 10 KB less Redis traffic and ≈ 54 µs less decode per ticket request, ≈ 1 % of per-request CPU); (b) caching the e-mail-masked public player list per room version for `results.php`; (c) raising `pm.max_children` above 40 (CPU, not worker count, is the constraint: the PHP container already touches ~4.2 cores, so more workers would add contention and MySQL connections rather than throughput).

### Next diagnostic run

1. Keep the workload identical and run with `PERF_LOG_ENABLED=1`, `PERF_SLOW_MS=100`, `PERF_SERVER_TIMING=0` in DEV. Collect `docker compose logs --since=10m php app db redis worker realtime` while K6 is running.
2. Save a time-aligned FPM `?full` sample every 2 seconds and Docker stats every 2–5 seconds. Capture MySQL `SHOW GLOBAL STATUS`, slow-query log / Performance Schema digest data, and Redis `INFO stats`, `INFO commandstats`, `LATENCY LATEST` before and after the same run.
3. Compare per-endpoint PHP total time with `sql.*`, `redis_*`, auth, room-state and response spans. Do not use FPM `request duration` as completed endpoint latency; use the Nginx/PHP access log or K6 trends for completed requests.
4. Repeat the exact same HTTP profile after any code/config change, then run persistent WebSocket tests independently at staged connection counts. The supplied HTTP test is 25 VUs running 25 room journeys, not 2,500 concurrent browsers or 2,500 persistent sockets.

The evidence supports: **functional HTTP flow passed at the tested load; PHP-FPM queueing and tail latency remain the main observed concerns; 10,000 simultaneous WebSocket capacity is not yet proven.**

## Pass/fail and cleanup

- Start with `smoke`; do not progress if it fails.
- Keep the workload identical when comparing code/config changes.
- A k6 threshold failure is a failed test even if the process completed.
- Review winner correctness, mark persistence, and DB records after concurrent tests; latency alone is not enough.
- The runner stops on the first failure and never automatically clears game data or volumes. Clean only the disposable DEV test data using a reviewed, explicit cleanup procedure.
- Never run the stress, soak, rate-limit burst or capacity scenarios against production.
