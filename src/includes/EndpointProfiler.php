<?php
declare(strict_types=1);

/**
 * Opt-in, low-overhead endpoint profiling. Never records request bodies,
 * credentials, room codes, user IDs, or SQL parameter values.
 *
 * Enable PERF_LOG_ENABLED=1 for structured error-log records. Enable
 * PERF_SERVER_TIMING=1 to expose Server-Timing headers to authorized testers.
 * Slow requests are logged at PERF_SLOW_MS (default 200ms) even when the
 * explicit log flag is off, so tail latency can be investigated safely.
 */
final class EndpointProfiler
{
    private static float $startedAt = 0.0;
    /** @var array<string,float> */
    private static array $spans = [];
    /** @var array<string,int> */
    private static array $counts = [];

    public static function begin(string $endpoint): void
    {
        self::$startedAt = microtime(true);
        self::$spans = [];
        self::$counts = [];
        self::record('endpoint', 0.0);
        self::$counts['_endpoint'] = 0;
        self::$spans['_name:' . preg_replace('/[^a-z0-9_.-]/i', '', $endpoint)] = 0.0;
    }

    public static function record(string $name, float $milliseconds, int $count = 1): void
    {
        $name = preg_replace('/[^a-z0-9_.-]/i', '', $name) ?: 'other';
        self::$spans[$name] = (self::$spans[$name] ?? 0.0) + max(0.0, $milliseconds);
        self::$counts[$name] = (self::$counts[$name] ?? 0) + $count;
    }

    public static function start(string $name): string
    {
        return $name . ':' . sprintf('%.6f', microtime(true));
    }

    public static function stop(string $token): void
    {
        $parts = explode(':', $token, 2);
        if (count($parts) !== 2) return;
        self::record($parts[0], (microtime(true) - (float)$parts[1]) * 1000.0);
    }

    public static function query(PDO $pdo, string $name, string $sql, array $params = []): PDOStatement
    {
        $start = microtime(true);
        try {
            $stmt = $pdo->prepare($sql);
            $stmt->execute($params);
            return $stmt;
        } finally {
            self::record('sql.' . $name, (microtime(true) - $start) * 1000.0);
        }
    }

    public static function finish(): void
    {
        if (self::$startedAt <= 0.0) return;
        $total = (microtime(true) - self::$startedAt) * 1000.0;
        $name = 'unknown';
        foreach (array_keys(self::$spans) as $key) {
            if (str_starts_with($key, '_name:')) { $name = substr($key, 6); break; }
        }
        $slowMs = max(1.0, (float)(getenv('PERF_SLOW_MS') ?: 200));
        $logEnabled = (string)getenv('PERF_LOG_ENABLED') === '1' || $total >= $slowMs;
        if ((string)getenv('PERF_SERVER_TIMING') === '1') {
            $timings = ['app;dur=' . number_format($total, 2, '.', '')];
            foreach (self::$spans as $span => $ms) {
                if (!str_starts_with($span, '_name:')) {
                    $timings[] = $span . ';dur=' . number_format($ms, 2, '.', '');
                }
            }
            header('Server-Timing: ' . implode(', ', array_slice($timings, 0, 20)));
        }
        if ($logEnabled) {
            $spans = self::$spans;
            unset($spans['endpoint']);
            foreach (array_keys($spans) as $key) if (str_starts_with($key, '_name:')) unset($spans[$key]);
            $record = [
                'endpoint' => $name,
                'total_ms' => round($total, 2),
                'spans_ms' => array_map(static fn($v) => round($v, 2), $spans),
                'counts' => self::$counts,
                'memory_kb' => (int)round(memory_get_peak_usage(true) / 1024),
            ];
            // On slow requests only, correlate endpoint/SQL spans with the
            // write-behind worker's pending queue and recent batch metrics.
            if ($total >= $slowMs && class_exists('MarkBuffer') && method_exists('MarkBuffer', 'metrics')) {
                try { $record['persistence'] = MarkBuffer::metrics(); } catch (Throwable $e) { /* diagnostic only */ }
            }
            error_log('[perf] ' . json_encode($record, JSON_UNESCAPED_SLASHES));
        }
        self::$startedAt = 0.0;
    }
}
