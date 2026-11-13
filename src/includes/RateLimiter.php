<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/env.php';
require_once __DIR__ . '/RedisConn.php';
require_once __DIR__ . '/ClientIp.php';

/**
 * Redis-backed, atomic, per-operation rate limiter.
 *
 * Algorithm: fixed window counter. One Lua script does INCRBY and makes sure
 * the key has a TTL in the same atomic step, so (a) concurrent PHP workers /
 * app instances can never over-admit, and (b) a key can never be left
 * without an expiry (it is re-armed if the TTL is ever missing). Window
 * boundary semantics: a client can spend `limit` requests at the very end
 * of one window and `limit` more at the start of the next, i.e. at most
 * 2 x limit in any interval of one window length. Limits are sized with that
 * in mind; edge/proxy limits provide the smooth shaping.
 *
 * Keys:  {REDIS_PREFIX}:rl:{env}:{policy}:{HMAC(subject)[0..32]}
 * The subject (IP / e-mail / user id) is HMAC-hashed so no personal data is
 * stored in key names; every key carries a TTL equal to its window.
 *
 * Redis outage policy (per policy, see DEFAULTS):
 *   closed   -> reject with HTTP 503 + Retry-After. Used for admin login,
 *               WebSocket handshakes and expensive endpoints, where
 *               losing protection is worse than losing availability.
 *   degraded -> enforce the SAME limit with a per-instance APCu counter
 *               (shared by all PHP-FPM workers of one instance, bounded:
 *               limit x instances). If APCu is not available this degrades
 *               to "closed". It NEVER degrades to "unlimited" and it never
 *               writes to MySQL.
 * Reconnection is delegated to RedisConn (2 s back-off, 250 ms connect
 * timeout), so an outage costs at most one short connect attempt per 2 s
 * per process instead of a retry storm, and recovery is automatic.
 *
 * RATE_LIMIT_ENABLED=0 is honoured ONLY when the canonical environment is
 * "dev". In UAT/PROD it is ignored (and logged once).
 *
 * Tuning: RATE_LIMIT_OVERRIDES="mark=300:60,claim=40:60" (limit:windowSeconds).
 * Malformed entries are ignored and the default stays in force.
 */
final class RateLimiter
{
    /** policy => [limit, windowSeconds, onRedisFailure] */
    public const DEFAULTS = [
        // Identity / session establishment (charged inside Auth::identify)
        'room_create_ip'   => [60,  600, 'degraded'],
        'room_create_user' => [10,  600, 'degraded'],
        'room_join_ip'     => [600, 600, 'degraded'],
        'room_join_user'   => [30,  600, 'degraded'],
        // Gameplay (authenticated, keyed by user id)
        'game_control'     => [30,  60,  'degraded'],
        'game_next'        => [120, 60,  'degraded'],
        'mark'             => [240, 60,  'degraded'],
        'claim'            => [30,  60,  'degraded'],
        'state_read'       => [300, 60,  'degraded'],
        // Emoji reactions: sending is capped well above the 1-per-800ms cooldown;
        // reads (poll/history/players) have their own bucket so they can never
        // starve the game's own state polling.
        'reaction_send'    => [90,  60,  'degraded'],
        'reaction_read'    => [300, 60,  'degraded'],
        // Real-time connection establishment (browsers fall back to polling)
        'ws_connect_user'  => [30,  60,  'closed'],
        'ws_connect_ip'    => [300, 60,  'closed'],
        // Administration
        'admin_login_ip'   => [8,   900, 'closed'],
        'admin_login_user' => [20,  900, 'closed'],
        'expensive'        => [10,  60,  'closed'],
    ];

    private const LUA = <<<'LUA'
local c = redis.call('INCRBY', KEYS[1], ARGV[2])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {c, ttl}
LUA;

    /** @var array<string,array{0:int,1:int,2:string}>|null */
    private static ?array $policies = null;
    private static bool $warnedDisable = false;
    private static bool $warnedRedis = false;

    // ------------------------------------------------------------ policies

    /** @return array{0:int,1:int,2:string} */
    public static function policy(string $name): array
    {
        if (self::$policies === null) {
            self::$policies = self::DEFAULTS;
            $raw = (string)getenv('RATE_LIMIT_OVERRIDES');
            foreach (explode(',', $raw) as $pair) {
                $pair = trim($pair);
                if ($pair === '') {
                    continue;
                }
                if (!preg_match('/^([a-z_]+)=(\d{1,7}):(\d{1,5})$/', $pair, $m)
                    || !isset(self::DEFAULTS[$m[1]])
                    || (int)$m[2] < 1 || (int)$m[3] < 1 || (int)$m[3] > 86400) {
                    error_log('[ratelimit] ignoring malformed RATE_LIMIT_OVERRIDES entry');
                    continue;
                }
                self::$policies[$m[1]] = [(int)$m[2], (int)$m[3], self::DEFAULTS[$m[1]][2]];
            }
        }
        if (!isset(self::$policies[$name])) {
            throw new LogicException("Unknown rate-limit policy: $name");
        }
        return self::$policies[$name];
    }

    public static function enabled(): bool
    {
        $v = strtolower(trim((string)getenv('RATE_LIMIT_ENABLED')));
        $off = in_array($v, ['0', 'false', 'off', 'no'], true);

        // Unless explicitly disabled, enforce rate limiting in every environment.
        if (!$off) {
            return true;
        }

        // RATE_LIMIT_ENABLED=off is allowed only in DEV and UAT.
        // Production and any other environment always keep rate limiting enabled.
        $environment = AppEnv::name();
        $canDisable = AppEnv::isDev() || $environment === 'uat';

        if ($canDisable) {
            return false;
        }

        if (!self::$warnedDisable) {
            self::$warnedDisable = true;
            error_log(
                '[ratelimit] RATE_LIMIT_ENABLED=off ignored: '
                . 'rate limiting can only be disabled in DEV or UAT'
            );
        }

        return true;
    }

    // --------------------------------------------------------------- core

    public static function key(string $policy, string $subject): string
    {
        $salt = (string)(getenv('RATE_LIMIT_HASH_SALT') ?: 'housiy-rl');
        static $saltWarned = false;
        if (!$saltWarned && !AppEnv::isDev() && ($salt === 'housiy-rl' || str_contains($salt, 'CHANGE_ME'))) {
            // Behaviour is unchanged (keys still work); make the misconfiguration visible.
            $saltWarned = true;
            error_log('[rate-limit] RATE_LIMIT_HASH_SALT is unset or still a CHANGE_ME placeholder outside dev; set a random value.');
        }
        $h = substr(hash_hmac('sha256', $subject, $salt), 0, 32);
        return RedisConn::prefix() . ':rl:' . AppEnv::name() . ':' . $policy . ':' . $h;
    }

    /**
     * Charge $cost against ($policy, $subject).
     *
     * @return array{allowed:bool,limit:int,remaining:int,retry_after:int,unavailable:bool,backend:string}
     */
    public static function hit(string $policy, string $subject, int $cost = 1): array
    {
        [$limit, $window, $fail] = self::policy($policy);
        if (!self::enabled()) {
            return ['allowed' => true, 'limit' => $limit, 'remaining' => $limit, 'retry_after' => 0, 'unavailable' => false, 'backend' => 'disabled'];
        }
        $key = self::key($policy, $subject);

        $r = RedisConn::conn();
        if ($r) {
            try {
                $res = $r->eval(self::LUA, [$key, (string)($window * 1000), (string)$cost], 1);
                if (is_array($res) && count($res) === 2) {
                    $count = (int)$res[0];
                    $ttlMs = max(1, (int)$res[1]);
                    $allowed = $count <= $limit;
                    if (!$allowed) {
                        self::stat($r, $policy, 'blocked');
                    }
                    return [
                        'allowed' => $allowed, 'limit' => $limit,
                        'remaining' => max(0, $limit - $count),
                        'retry_after' => $allowed ? 0 : (int)ceil($ttlMs / 1000),
                        'unavailable' => false, 'backend' => 'redis',
                    ];
                }
                throw new RuntimeException('unexpected script result');
            } catch (Throwable $e) {
                RedisConn::reset();
                if (!self::$warnedRedis) {
                    self::$warnedRedis = true;
                    error_log('[ratelimit] redis error, applying outage policy: ' . $e->getMessage());
                }
            }
        }

        // ---- Redis unavailable: apply the documented outage policy ----
        if ($fail === 'degraded' && function_exists('apcu_enabled') && apcu_enabled()) {
            $k = 'rl:' . substr($key, strlen(RedisConn::prefix()) + 4);
            apcu_add($k, 0, $window);
            $count = apcu_inc($k, $cost);
            if ($count === false) {            // evicted between add and inc: re-arm
                apcu_store($k, $cost, $window);
                $count = $cost;
            }
            $allowed = (int)$count <= $limit;
            return [
                'allowed' => $allowed, 'limit' => $limit,
                'remaining' => max(0, $limit - (int)$count),
                'retry_after' => $allowed ? 0 : $window,
                'unavailable' => false, 'backend' => 'apcu',
            ];
        }
        return ['allowed' => false, 'limit' => $limit, 'remaining' => 0, 'retry_after' => 5, 'unavailable' => true, 'backend' => 'none'];
    }

    /** Charge and, on refusal, terminate the request (429, or 503 when closed during an outage). */
    public static function enforce(string $policy, string $subject, int $cost = 1): void
    {
        $rateSpan = class_exists('EndpointProfiler') ? EndpointProfiler::start('rate_limit.' . $policy) : null;
        $res = self::hit($policy, $subject, $cost);
        if ($rateSpan !== null) EndpointProfiler::stop($rateSpan);
        if ($res['allowed']) {
            return;
        }
        if ($res['unavailable']) {
            json_unavailable(max(1, $res['retry_after']));
        }
        json_too_many(max(1, $res['retry_after']));
    }

    /** Forget a counter (e.g. after a successful admin login). */
    public static function reset(string $policy, string $subject): void
    {
        $key = self::key($policy, $subject);
        $r = RedisConn::conn();
        if ($r) {
            try {
                $r->del($key);
            } catch (Throwable $e) {
                RedisConn::reset();
            }
        }
        if (function_exists('apcu_delete')) {
            apcu_delete('rl:' . substr($key, strlen(RedisConn::prefix()) + 4));
        }
    }

    /** Best-effort client IP (trusted-proxy aware). See ClientIp. */
    public static function clientIp(): string
    {
        return ClientIp::resolve();
    }

    /** Counters of intentionally rejected requests, for bin/status.php. @return array<string,int> */
    public static function stats(): array
    {
        $r = RedisConn::conn();
        if (!$r) {
            return [];
        }
        try {
            $all = $r->hGetAll(RedisConn::prefix() . ':rlstats:' . AppEnv::name());
            return is_array($all) ? array_map('intval', $all) : [];
        } catch (Throwable $e) {
            RedisConn::reset();
            return [];
        }
    }

    public static function resetForTests(): void
    {
        self::$policies = null;
        self::$warnedDisable = false;
        self::$warnedRedis = false;
    }

    private static function stat(Redis $r, string $policy, string $what): void
    {
        try {
            $r->hIncrBy(RedisConn::prefix() . ':rlstats:' . AppEnv::name(), $policy . ':' . $what, 1);
        } catch (Throwable $e) {
            // statistics are best-effort
        }
    }
}
