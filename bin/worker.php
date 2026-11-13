<?php
declare(strict_types=1);

/**
 * Auto-call worker (CLI). Drives GameEngine::autoCallIfDue() on a timer so
 * numbers are called on schedule without any client having to poll.
 * Same time-gated, row-locked logic as before - only the trigger moved.
 *
 *   php bin/worker.php
 */
// APP_ROOT is the web root holding config/ and includes/ (the repo's src/
// directory, or /var/www/html inside the image). This script itself is kept
// outside the web root so it can never be requested over HTTP.
$root = rtrim((string)(getenv('APP_ROOT') ?: __DIR__ . '/../src'), '/');
require_once $root . '/config/app.php';
require_once $root . '/config/db.php';
require_once $root . '/includes/GameEngine.php';
require_once $root . '/includes/MarkBuffer.php';
require_once $root . '/includes/ReactionBuffer.php';
require_once $root . '/includes/Reactions.php';

$startupPdo = DB::conn(); // validates DB credentials once at startup (exits if unset)

// Fail fast on an incomplete database schema instead of running forever while
// every mark-flush tick fails with a missing-table error. The live marks tests
// deliberately rename this table after startup to simulate MySQL failure; in
// that case the normal retry path below remains active and queued marks stay
// in Redis until the table is restored.
try {
    $startupPdo->query('SELECT ticket_id, number FROM marked_numbers LIMIT 0');
    // Idempotent compatibility migration for existing databases: ensure the
    // reaction table and durable outbox exist before the worker loop begins.
    Reactions::ensureTable($startupPdo);
} catch (Throwable $e) {
    fwrite(STDERR, "[worker] fatal: required schema is missing or incompatible; apply sql/schema.sql before starting the worker\n");
    exit(1);
}
unset($startupPdo);

$running = true;
// Outbox retry scans back off while idle; direct API publication handles the
// low-latency path, so an idle worker need not query MySQL every second.
$nextOutboxScanAt = 0.0;
$outboxIdleBackoff = 1.0;
if (function_exists('pcntl_signal')) {
    pcntl_async_signals(true);
    foreach ([SIGTERM, SIGINT] as $sig) {
        pcntl_signal($sig, function () use (&$running) { $running = false; });
    }
}

$sql = 'SELECT r.* FROM rooms r JOIN games g ON g.room_id = r.id
        WHERE r.auto_call_enabled = 1 AND r.auto_call_interval_seconds > 0
          AND g.status = "RUNNING" AND g.numbers_called_count < 90';

fwrite(STDOUT, "[worker] started\n");
while ($running) {
    $t0 = microtime(true);
    $workStarted = $t0;
    $phaseMs = [];

    // Heartbeat: while present, results.php skips poll-driven auto-call and
    // mark.php buffers marks for us to flush. Only advertised when Redis is
    // reachable. A Redis error here must never stall the DB work below.
    $phaseStarted = microtime(true);
    try {
        $redis = RedisConn::conn();
        if ($redis) {
            $redis->setex(Realtime::workerKey(), 5, '1');
        }
    } catch (Throwable $e) {
        RedisConn::reset();
    }
    $phaseMs['heartbeat_ms'] = round((microtime(true) - $phaseStarted) * 1000, 2);

    $phaseStarted = microtime(true);
    $pdo = DB::tryConn();
    $phaseMs['db_connect_ms'] = round((microtime(true) - $phaseStarted) * 1000, 2);
    if (!$pdo) {
        sleep(2);
        continue;
    }

    $phaseStarted = microtime(true);
    $roomsScanned = 0;
    try {
        foreach ($pdo->query($sql)->fetchAll() as $room) {
            $roomsScanned++;
            GameEngine::autoCallIfDue($pdo, $room);
            Realtime::flush();
        }
    } catch (Throwable $e) {
        DB::reset();
        error_log('[worker] auto-call: ' . $e->getMessage());
    }
    $phaseMs['auto_call_scan_ms'] = round((microtime(true) - $phaseStarted) * 1000, 2);

    // Write buffered ticket marks to MySQL (one multi-row INSERT for all
    // players). Failures leave the marks pending in Redis; next tick retries.
    $phaseStarted = microtime(true);
    try {
        MarkBuffer::flush(DB::tryConn() ?? $pdo);
    } catch (Throwable $e) {
        DB::reset();
        error_log('[worker] mark flush: ' . $e->getMessage());
    }
    $phaseMs['mark_flush_ms'] = round((microtime(true) - $phaseStarted) * 1000, 2);

    // Write buffered emoji reactions to MySQL (one multi-row INSERT for all
    // rooms) and run the occasional retention clean-up. Failures leave the
    // reactions queued in Redis; next tick retries.
    $phaseStarted = microtime(true);
    try {
        $rxPdo = DB::tryConn() ?? $pdo;
        ReactionBuffer::flush($rxPdo);
        ReactionBuffer::maintain($rxPdo);
    } catch (Throwable $e) {
        DB::reset();
        error_log('[worker] reaction flush: ' . $e->getMessage());
    }
    $phaseMs['reaction_flush_maintain_ms'] = round((microtime(true) - $phaseStarted) * 1000, 2);

    // Retry durable reaction outbox events in indexed batches. Back off idle
    // scans (1s, 2s, 4s, up to 5s); any active send attempts publication itself.
    $phaseStarted = microtime(true);
    if (microtime(true) >= $nextOutboxScanAt) {
        try {
            $outboxPublished = Reactions::publishOutbox(DB::tryConn() ?? $pdo, 100);
            if ($outboxPublished > 0) {
                $outboxIdleBackoff = 1.0;
                $nextOutboxScanAt = microtime(true) + 0.25;
            } else {
                $nextOutboxScanAt = microtime(true) + $outboxIdleBackoff;
                $outboxIdleBackoff = min(2.0, $outboxIdleBackoff * 2.0);
            }
        } catch (Throwable $e) {
            DB::reset();
            error_log('[worker] reaction outbox publish: ' . $e->getMessage());
            $nextOutboxScanAt = microtime(true) + $outboxIdleBackoff;
            $outboxIdleBackoff = min(2.0, $outboxIdleBackoff * 2.0);
        }
    }
    $phaseMs['reaction_outbox_publish_ms'] = round((microtime(true) - $phaseStarted) * 1000, 2);

    $workMs = (microtime(true) - $workStarted) * 1000;
    $slowMs = max(1.0, (float)(getenv('PERF_SLOW_MS') ?: 200));
    if ((string)getenv('PERF_LOG_ENABLED') === '1' || $workMs >= $slowMs) {
        $workerRecord = [
            'work_ms' => round($workMs, 2),
            'phases_ms' => $phaseMs,
            'rooms_scanned' => $roomsScanned,
            'memory_kb' => (int)round(memory_get_peak_usage(true) / 1024),
        ];
        try { $workerRecord['mark_persistence'] = MarkBuffer::metrics(); } catch (Throwable $e) { /* diagnostic only */ }
        error_log('[perf-worker] ' . json_encode($workerRecord, JSON_UNESCAPED_SLASHES));
    }

    $sleep = 1.0 - (microtime(true) - $t0);
    if ($sleep > 0) {
        usleep((int)($sleep * 1_000_000));
    }
}

// Graceful stop: persist anything still buffered.
try {
    $pdo = DB::tryConn();
    if ($pdo) {
        MarkBuffer::flush($pdo);
        ReactionBuffer::flush($pdo);
    }
} catch (Throwable $e) {
    error_log('[worker] final flush: ' . $e->getMessage());
}
fwrite(STDOUT, "[worker] stopped\n");
