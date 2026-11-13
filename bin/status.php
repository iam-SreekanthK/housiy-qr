<?php
declare(strict_types=1);

/**
 * Health + persistence metrics (CLI only; nothing is exposed over HTTP).
 *
 *   php bin/status.php            human-readable metrics
 *   php bin/status.php --json     machine-readable
 *   php bin/status.php --check    exit 0 healthy / 1 unhealthy (used by Docker/K8s)
 *
 * --check is unhealthy when MySQL is unreachable, or when Redis is configured
 * but the worker heartbeat is missing, or the oldest un-persisted mark is
 * older than PERSIST_MAX_LAG_SECONDS (default 30).
 */
$root = rtrim((string)(getenv('APP_ROOT') ?: __DIR__ . '/../src'), '/');
require_once $root . '/config/app.php';
require_once $root . '/config/db.php';
require_once $root . '/includes/MarkBuffer.php';
require_once $root . '/includes/ReactionBuffer.php';
require_once $root . '/includes/RateLimiter.php';

$mysqlOk = DB::tryConn() !== null;
$redisConfigured = RedisConn::enabled();
$redisOk = $redisConfigured && RedisConn::conn() !== null;
$workerAlive = $redisOk && Realtime::workerAlive();
$m = $redisOk ? MarkBuffer::metrics() : [];
$maxLag = (int)(getenv('PERSIST_MAX_LAG_SECONDS') ?: 30);
$lag = (int)($m['oldest_pending_age_s'] ?? 0);

$status = [
    'env' => AppEnv::name(),
    'rate_limit' => [
        'enabled' => RateLimiter::enabled(),
        'blocked_total_by_policy' => $redisOk ? RateLimiter::stats() : [],
    ],
    'mysql' => $mysqlOk ? 'up' : 'down',
    'redis' => !$redisConfigured ? 'not_configured' : ($redisOk ? 'up' : 'down'),
    'worker_heartbeat' => $workerAlive ? 'up' : 'down',
    'persistence' => [
        'queue_depth' => (int)($m['queue_depth'] ?? 0),
        'oldest_pending_age_s' => $lag,
        'marks_persisted_total' => (int)($m['marks_persisted_total'] ?? 0),
        'batches_total' => (int)($m['batches_total'] ?? 0),
        'failures_total' => (int)($m['failures_total'] ?? 0),
        'last_batch_size' => (int)($m['last_batch_size'] ?? 0),
        'last_batch_ms' => (int)($m['last_batch_ms'] ?? 0),
        'last_error' => $m['last_error'] ?? null,
        'max_lag_seconds' => $maxLag,
        'reaction_queue_depth' => $redisOk ? ReactionBuffer::depth() : 0,
    ],
];
$healthy = $mysqlOk && (!$redisConfigured || ($redisOk && $workerAlive && $lag <= $maxLag));

if (in_array('--check', $argv, true)) {
    exit($healthy ? 0 : 1);
}
$status['healthy'] = $healthy;
echo in_array('--json', $argv, true)
    ? json_encode($status, JSON_PRETTY_PRINT) . "\n"
    : print_r($status, true);
exit($healthy ? 0 : 1);
