# Redis connection integration tests

Run these only against a disposable Redis instance, never against production.
The PHP runtime must have the `redis` (phpredis) extension enabled.

## 1. Successful connection and persistent-socket checks

```bash
REDIS_HOST=127.0.0.1 REDIS_PORT=6379 REDIS_PASSWORD='test-password' REDIS_DB=0 \
  php tests/ops/redis-conn-check.php
```

The script exercises both `connect()` and `pconnect()`, command round-trips,
explicit reset/reconnect, wrong-password rejection and invalid database
selection. Repeat with `REDIS_PASSWORD` omitted/empty against an intentionally
unauthenticated disposable Redis to verify the no-password success path.

## 2. Empty password against an authentication-required Redis

Start a disposable Redis configured with `requirepass test-password`, then run
with the password intentionally empty:

```bash
REDIS_HOST=127.0.0.1 REDIS_PORT=6379 REDIS_PASSWORD= \
  REDIS_TEST_EXPECT_UNAVAILABLE=1 php tests/ops/redis-conn-check.php
```

Expected: `conn()` returns `null`; it must not return a half-authenticated
socket. The test fails if the endpoint accepts the connection without AUTH.

## 3. Redis unavailable / connection refused

Stop the disposable Redis (or use a closed test port), then run:

```bash
REDIS_HOST=127.0.0.1 REDIS_PORT=6399 REDIS_PASSWORD= \
  REDIS_TEST_EXPECT_UNAVAILABLE=1 php tests/ops/redis-conn-check.php
```

Expected: `conn()` returns `null` and the application can take its existing
MySQL-only fallback path.

## 4. PHP-FPM multi-worker persistent connection check

With the disposable Redis and application stack running:

1. Set `REDIS_PERSISTENT=1` on the PHP service and recreate that service.
2. Ensure the FPM pool has at least two workers.
3. Send concurrent requests that each perform a Redis operation (for example,
   a controlled test endpoint in a non-production build).
4. Compare Redis `INFO clients` / `INFO stats` and `CLIENT LIST` before and
   after; verify requests from multiple workers succeed and each worker reuses
   its own persistent socket.
5. Repeat with `REDIS_PERSISTENT=0` under the same workload.

Do not infer connection reuse from a single sequential request. Record the
worker count, request count, concurrency, Redis connection counters and errors.
The repository does not claim a measured latency improvement until this A/B
run has been performed on the target stack.
