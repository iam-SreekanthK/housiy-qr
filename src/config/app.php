<?php
declare(strict_types=1);

/**
 * Global bootstrap. Included at the top of every entrypoint.
 */

require_once __DIR__ . '/env.php';

// Canonical environment (dev|uat|prod). Refuses to start on an unknown
// APP_ENV and treats a missing one as prod (never as dev).
AppEnv::boot();

error_reporting(E_ALL);
ini_set('display_errors', AppEnv::debug() ? '1' : '0');
date_default_timezone_set('UTC');

const PRIZE_TYPES        = ['FIRST_FIVE', 'TOP_ROW', 'MIDDLE_ROW', 'BOTTOM_ROW', 'FULL_HOUSE'];
const MAX_PLAYERS_DEFAULT = 100;
const SESSION_COOKIE_NAME = 'housiy_session';
const ADMIN_COOKIE_NAME   = 'housiy_admin_session';
const SESSION_TTL_DAYS    = 30;

require_once __DIR__ . '/../includes/Realtime.php';
require_once __DIR__ . '/../includes/EndpointProfiler.php';
EndpointProfiler::begin(basename((string)($_SERVER['SCRIPT_NAME'] ?? 'cli')));

/**
 * Start the PHP session on demand. Only the Super Admin flow uses
 * $_SESSION (players authenticate via the housiy_session cookie), so the
 * session - and its lock - is no longer taken on every player poll.
 *
 * When Redis is configured, sessions are stored there so admin logins
 * survive pod restarts and work across replicas. If Redis is unreachable
 * we fall back to the default file handler instead of failing.
 */
function app_session_start(): void
{
    if (session_status() !== PHP_SESSION_NONE) {
        return;
    }
    session_name('housiy_phpsess');
    session_set_cookie_params([
        'lifetime' => 60 * 60 * 24 * SESSION_TTL_DAYS,
        'path'     => '/',
        'secure'   => AppEnv::cookieSecure(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);

    $useRedis = (getenv('SESSION_STORE') ?: 'redis') === 'redis' && RedisConn::enabled();
    if ($useRedis && RedisConn::conn() !== null) {
        $q = ['timeout=0.5', 'prefix=' . rawurlencode(RedisConn::prefix() . ':sess:')];
        if ((string)getenv('REDIS_PASSWORD') !== '') {
            $q[] = 'auth=' . rawurlencode((string)getenv('REDIS_PASSWORD'));
        }
        if ((int)getenv('REDIS_DB') > 0) {
            $q[] = 'database=' . (int)getenv('REDIS_DB');
        }
        ini_set('session.save_handler', 'redis');
        ini_set('session.save_path', 'tcp://' . getenv('REDIS_HOST') . ':' . (int)(getenv('REDIS_PORT') ?: 6379) . '?' . implode('&', $q));
    }
    if (!@session_start()) {
        // Redis session store failed mid-flight: retry with files.
        ini_set('session.save_handler', 'files');
        ini_set('session.save_path', '');
        session_start();
    }
}

/**
 * Send a JSON response and terminate.
 */
function json_response(array $payload, int $status = 200): void
{
    // Every DB commit has happened by the time a response is produced, so
    // this is the safe point to wake WebSocket clients (and bump the
    // results cache version) - before the caller can see the response.
    $flushSpan = EndpointProfiler::start('response.realtime_flush');
    Realtime::flush();
    EndpointProfiler::stop($flushSpan);

    $encodeSpan = EndpointProfiler::start('response.json_encode');
    $json = json_encode($payload, JSON_UNESCAPED_SLASHES);
    EndpointProfiler::stop($encodeSpan);
    EndpointProfiler::finish();

    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo $json;
    exit;
}

function json_error(string $message, int $status = 400, array $extra = []): void
{
    json_response(array_merge(['success' => false, 'error' => $message], $extra), $status);
}

/**
 * HTTP 429 in the app's established JSON error shape, plus a Retry-After
 * header. Terminates the request. Deliberately does not log: throttled
 * requests are expected traffic, counted in Redis (see RateLimiter::stats).
 */
function json_too_many(int $retryAfter = 1, string $message = 'Too many requests. Please slow down and try again shortly.'): void
{
    header('Retry-After: ' . max(1, $retryAfter));
    json_error($message, 429, ['retry_after_seconds' => max(1, $retryAfter)]);
}

/** HTTP 503 + Retry-After, used when a protection that must fail closed is unavailable. */
function json_unavailable(int $retryAfter = 5): void
{
    header('Retry-After: ' . max(1, $retryAfter));
    json_error('Service temporarily unavailable. Please try again shortly.', 503, ['retry_after_seconds' => max(1, $retryAfter)]);
}

function json_ok(array $data = []): void
{
    json_response(array_merge(['success' => true], $data));
}

/** Require POST method or fail with 405. */
function require_post(): void
{
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        json_error('Method not allowed', 405);
    }
}

/** Decode JSON body of the current request into an assoc array. */
function json_body(): array
{
    $raw = file_get_contents('php://input');
    if (!$raw) {
        return [];
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

function generate_room_code(): string
{
    // 8-char alphanumeric, uppercase, unambiguous charset (no 0/O/1/I)
    $charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    $code = '';
    for ($i = 0; $i < 8; $i++) {
        $code .= $charset[random_int(0, strlen($charset) - 1)];
    }
    return $code;
}
