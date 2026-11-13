<?php
declare(strict_types=1);

/**
 * Fail-safe Redis connection factory (phpredis).
 *
 * Redis is an accelerator, never a dependency: when REDIS_HOST is unset,
 * the extension is missing, or Redis is unreachable, conn() returns null
 * and every caller falls back to the original MySQL-only behaviour.
 * After a failed attempt we do not retry for a couple of seconds, so a dead
 * Redis costs at most one short connect timeout per request, while the
 * long-running worker still reconnects on its own once Redis returns.
 */
final class RedisConn
{
    private static ?Redis $instance = null;
    private static float $failedAt = 0.0;
    private const RETRY_AFTER_SECONDS = 2.0;

    public static function enabled(): bool
    {
        return (string)getenv('REDIS_HOST') !== '' && extension_loaded('redis');
    }

    public static function conn(): ?Redis
    {
        if (self::$instance instanceof Redis) {
            return self::$instance;
        }
        if (!self::enabled() || (microtime(true) - self::$failedAt) < self::RETRY_AFTER_SECONDS) {
            return null;
        }
        try {
            $r = new Redis();
            $host = (string)getenv('REDIS_HOST');
            $port = (int)(getenv('REDIS_PORT') ?: 6379);
            $pass = (string)getenv('REDIS_PASSWORD');
            $db = (int)(getenv('REDIS_DB') ?: 0);
            $persist = self::persistentEnabled();
            // Under PHP-FPM a plain connect() opens, authenticates and tears
            // down a TCP session on EVERY request (~3 extra Redis commands
            // each). pconnect() lets each FPM worker keep one socket for its
            // lifetime. The persistent id embeds host/port/db and a hash of
            // the password so differently-configured pools never share a
            // socket, and the long-running worker/CLI keeps using connect().
            $ok = $persist
                ? $r->pconnect($host, $port, 0.25, self::persistentId($host, $port, $db, $pass), 0, 0.5)
                : $r->connect($host, $port, 0.25, null, 0, 0.5);
            if (!$ok) {
                throw new RuntimeException('connect failed');
            }
            $r->setOption(Redis::OPT_READ_TIMEOUT, 0.5);
            // AUTH / SELECT / PING are sent as ONE pipelined round trip and
            // each reply is checked explicitly. phpredis may return false for
            // a failed AUTH instead of throwing, and a socket is never cached
            // until authentication has explicitly succeeded; otherwise the
            // first application command fails later with NOAUTH and is
            // misreported as a rate-limiter outage. The PING also detects a
            // stale pooled socket and REDIS_PASSWORD being empty while the
            // server requires AUTH.
            $pipe = $r->multi(Redis::PIPELINE);
            if ($pass !== '') $pipe->auth($pass);
            if ($db > 0) $pipe->select($db);
            $pipe->ping();
            $replies = $pipe->exec();
            if (!is_array($replies)) {
                throw new RuntimeException('Redis handshake pipeline failed');
            }
            $i = 0;
            if ($pass !== '') {
                if (($replies[$i++] ?? false) !== true) {
                    throw new RuntimeException('Redis authentication failed; check REDIS_PASSWORD');
                }
            }
            if ($db > 0) {
                if (($replies[$i++] ?? false) !== true) {
                    throw new RuntimeException('Redis database selection failed; check REDIS_DB');
                }
            }
            if (($replies[$i] ?? false) === false) {
                throw new RuntimeException('Redis PING failed after connect/authentication');
            }
            self::$instance = $r;
            return $r;
        } catch (Throwable $e) {
            if (isset($r) && $r instanceof Redis) {
                try { $r->close(); } catch (Throwable $ignored) { /* best effort */ }
            }
            self::$instance = null;
            self::$failedAt = microtime(true);
            $msg = $e->getMessage();
            if (stripos($msg, 'NOAUTH') !== false || stripos($msg, 'WRONGPASS') !== false) {
                $msg .= ' (check REDIS_PASSWORD)';
            }
            error_log('[redis] unavailable: ' . $msg);
            return null;
        }
    }

    /**
     * Persistent sockets only make sense inside a PHP-FPM request. The CLI
     * worker/tests hold one process-lifetime connection anyway. Set
     * REDIS_PERSISTENT=0 to fall back to a per-request connection.
     */
    private static function persistentEnabled(): bool
    {
        $flag = getenv('REDIS_PERSISTENT');
        if ($flag !== false && $flag !== '') {
            return $flag !== '0' && strtolower($flag) !== 'false';
        }
        return PHP_SAPI === 'fpm-fcgi';
    }

    private static function persistentId(string $host, int $port, int $db, string $pass): string
    {
        return 'housiy:' . $host . ':' . $port . ':' . $db . ':' . substr(hash('sha256', $pass), 0, 8);
    }

    /** Drop a connection that errored mid-use so the next conn() reconnects. */
    public static function reset(): void
    {
        if (self::$instance instanceof Redis) {
            try { self::$instance->close(); } catch (Throwable $ignored) { /* best effort */ }
        }
        self::$instance = null;
        // An explicit reset is used by tests and recovery paths that require
        // the very next conn() call to retry immediately. Do not apply the
        // failure backoff after an explicit reset.
        self::$failedAt = 0.0;
    }

    /** Key prefix shared with the realtime gateway and worker. */
    public static function prefix(): string
    {
        return (string)(getenv('REDIS_PREFIX') ?: 'housiy');
    }
}
