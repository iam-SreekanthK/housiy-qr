<?php
declare(strict_types=1);

require_once __DIR__ . '/RedisConn.php';

/**
 * Tiny never-throwing cache helpers on top of RedisConn. Every method
 * degrades to "miss"/no-op when Redis is absent or errors, so callers can
 * always fall through to MySQL.
 */
final class RedisCache
{
    public static function key(string $suffix): string
    {
        return RedisConn::prefix() . ':' . $suffix;
    }

    public static function get(string $suffix): ?string
    {
        $started = microtime(true);
        try {
            $r = RedisConn::conn();
            if (!$r) return null;
            try {
                $v = $r->get(self::key($suffix));
                return is_string($v) ? $v : null;
            } catch (Throwable $e) {
                RedisConn::reset();
                return null;
            }
        } finally {
            if (class_exists('EndpointProfiler')) EndpointProfiler::record('redis_cache.get', (microtime(true) - $started) * 1000.0);
        }
    }

    public static function set(string $suffix, string $value, int $ttl): void
    {
        $started = microtime(true);
        try {
            $r = RedisConn::conn();
            if (!$r) return;
            try { $r->setex(self::key($suffix), $ttl, $value); }
            catch (Throwable $e) { RedisConn::reset(); }
        } finally {
            if (class_exists('EndpointProfiler')) EndpointProfiler::record('redis_cache.set', (microtime(true) - $started) * 1000.0);
        }
    }

    /** Like set(), but $key is already a full Redis key (from RedisCache::key()). */
    public static function setRaw(string $fullKey, string $value, int $ttl): void
    {
        $started = microtime(true);
        try {
            $r = RedisConn::conn();
            if (!$r) return;
            try { $r->setex($fullKey, $ttl, $value); }
            catch (Throwable $e) { RedisConn::reset(); }
        } finally {
            if (class_exists('EndpointProfiler')) EndpointProfiler::record('redis_cache.set_raw', (microtime(true) - $started) * 1000.0);
        }
    }

    public static function del(string $suffix): void
    {
        $started = microtime(true);
        try {
            $r = RedisConn::conn();
            if (!$r) return;
            try { $r->del(self::key($suffix)); }
            catch (Throwable $e) { RedisConn::reset(); }
        } finally {
            if (class_exists('EndpointProfiler')) EndpointProfiler::record('redis_cache.del', (microtime(true) - $started) * 1000.0);
        }
    }
}
