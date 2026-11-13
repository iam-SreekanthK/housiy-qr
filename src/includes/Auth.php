<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/env.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/RateLimiter.php';
require_once __DIR__ . '/RedisCache.php';

/**
 * Handles player/host identity. There is no password for regular users:
 * identity = name + email, persisted via a signed, httpOnly session cookie
 * holding an opaque session_token that maps to a users row.
 *
 * Super Admin auth is handled separately in AdminAuth.php.
 */
final class Auth
{
    private const COOKIE_TTL = 60 * 60 * 24 * SESSION_TTL_DAYS;

    // identify() runs on every room create/join, including for groups of
    // legitimate players sharing one office/classroom/venue (NAT) address.
    // It is therefore throttled in two independent layers, per operation
    // (see RateLimiter::DEFAULTS): a generous per-client-IP limit that only
    // blunts scripted user-minting/enumeration, and a tighter per-e-mail
    // limit so one identity cannot be hammered from many addresses. Create
    // and join have their own counters so one never starves the other.
    // The previous single shared MySQL bucket (60 per 10 min per IP, one
    // check-then-insert round trip each) is gone.
    public const OP_CREATE = 'room_create';
    public const OP_JOIN   = 'room_join';

    /**
     * Find or create a user by (name, email) and issue/refresh the cookie.
     * Returns the full user row.
     *
     * @param string $operation OP_CREATE | OP_JOIN - selects the rate-limit policies.
     */
    public static function identify(string $name, string $email, string $operation = self::OP_JOIN): array
    {
        $name  = trim($name);
        $email = strtolower(trim($email));

        if ($name === '' || mb_strlen($name) > 120) {
            throw new InvalidArgumentException('Please enter a valid name.');
        }
        if (!filter_var($email, FILTER_VALIDATE_EMAIL) || mb_strlen($email) > 190) {
            throw new InvalidArgumentException('Please enter a valid email address.');
        }

        $pdo = DB::conn();

        // Throttle BEFORE any user lookup/insert, so a rejected request has
        // no database side effects at all.
        if ($operation !== self::OP_CREATE && $operation !== self::OP_JOIN) {
            throw new LogicException('Unknown identify operation');
        }
        RateLimiter::enforce($operation . '_ip', RateLimiter::clientIp());
        RateLimiter::enforce($operation . '_user', $email);

        // Enforce the super-admin block list before creating a user or refreshing a session.
        $blocked = $pdo->prepare(
            'SELECT id FROM user_blocks
             WHERE (email_normalized IS NOT NULL AND email_normalized = ?)
                OR (name_normalized IS NOT NULL AND name_normalized = ?)
             LIMIT 1'
        );
        $blocked->execute([$email, mb_strtolower($name, 'UTF-8')]);
        if ($blocked->fetch()) {
            throw new InvalidArgumentException('This account is blocked. Please contact the Housiy administrator.');
        }
        $stmt = $pdo->prepare('SELECT id, name, email, session_token FROM users WHERE email = ? LIMIT 1');
        $stmt->execute([$email]);
        $user = $stmt->fetch();

        // Reuse the caller's current session token if it already resolves to
        // this same user - this keeps other open tabs/devices for the same
        // person logged in. Only issue a brand-new token for a genuinely new
        // session (no cookie, invalid cookie, or a different user's cookie).
        $existingToken = $_COOKIE[SESSION_COOKIE_NAME] ?? null;
        $reuseToken = null;
        if ($user && $existingToken && hash_equals((string)$user['session_token'], (string)$existingToken)) {
            $reuseToken = $existingToken;
        }
        $token = $reuseToken ?? bin2hex(random_bytes(32));

        $oldToken = $user ? (string)$user['session_token'] : '';
        if ($user) {
            // Existing user: refresh name (in case they typed it slightly
            // differently); only rotate the token when this is a new session.
            $upd = $pdo->prepare('UPDATE users SET name = ?, session_token = ?, last_seen_at = NOW() WHERE id = ?');
            $upd->execute([$name, $token, $user['id']]);
            $user['name'] = $name;
            $user['session_token'] = $token;
            // Evict cached lookups for the old and (possibly reused) token.
            if ($oldToken !== '') {
                RedisCache::del('u:' . hash('sha256', $oldToken));
            }
            RedisCache::del('u:' . hash('sha256', $token));
        } else {
            $uuid = self::uuid4();
            $ins = $pdo->prepare(
                'INSERT INTO users (uuid, name, email, session_token, last_seen_at) VALUES (?, ?, ?, ?, NOW())'
            );
            $ins->execute([$uuid, $name, $email, $token]);
            $user = [
                'id' => (int)$pdo->lastInsertId(),
                'uuid' => $uuid,
                'name' => $name,
                'email' => $email,
                'session_token' => $token,
            ];
        }

        setcookie(SESSION_COOKIE_NAME, $token, [
            'expires'  => time() + self::COOKIE_TTL,
            'path'     => '/',
            'secure'   => AppEnv::cookieSecure(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);

        return $user;
    }

    /** Resolve the current user from their session cookie, or null. */
    public static function currentUser(): ?array
    {
        $token = $_COOKIE[SESSION_COOKIE_NAME] ?? null;
        if (!$token || !preg_match('/^[a-f0-9]{64}$/', $token)) {
            return null;
        }
        // Short-lived Redis cache of the token lookup (identify() evicts it
        // the moment a token is rotated, so a replaced session stops working
        // immediately, same as with the plain MySQL lookup).
        $cacheKey = 'u:' . hash('sha256', $token);
        $authCacheSpan = class_exists('EndpointProfiler') ? EndpointProfiler::start('auth.redis_user_lookup') : null;
        $hit = RedisCache::get($cacheKey);
        if ($authCacheSpan !== null) EndpointProfiler::stop($authCacheSpan);
        if ($hit !== null) {
            $cached = json_decode($hit, true);
            if (is_array($cached) && isset($cached['id'])) {
                return $cached;
            }
        }
        $authDbSpan = class_exists('EndpointProfiler') ? EndpointProfiler::start('auth.mysql_user_lookup') : null;
        $pdo = DB::conn();
        $stmt = $pdo->prepare('SELECT id, name, email, session_token FROM users WHERE session_token = ? LIMIT 1');
        $stmt->execute([$token]);
        $user = $stmt->fetch();
        if ($authDbSpan !== null) EndpointProfiler::stop($authDbSpan);
        if ($user) {
            RedisCache::set($cacheKey, json_encode($user), 60);
        }
        return $user ?: null;
    }

    /** Require a logged-in user or terminate the request with 401. */
    public static function requireUser(): array
    {
        $user = self::currentUser();
        if (!$user) {
            json_error('Not authenticated. Please enter your name and email.', 401);
        }
        return $user;
    }

    private static function uuid4(): string
    {
        $data = random_bytes(16);
        $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
        $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
    }
}
