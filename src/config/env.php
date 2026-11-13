<?php
declare(strict_types=1);

/**
 * Canonical application environment: exactly one of "dev", "uat", "prod".
 *
 * Every deployment variant historically used a different spelling for the
 * same thing (docker-compose default "production", Jenkins "development" /
 * "testing", k8s "staging" / "production", .env "dev"). They are all mapped
 * here, once, so the rest of the code never compares raw APP_ENV strings:
 *
 *   dev  <- dev, development, local, test, testing
 *   uat  <- uat, stage, staging
 *   prod <- prod, production
 *
 * Fail-safe rules (deliberate):
 *   - APP_ENV unset/empty  -> "prod". A missing setting must never silently
 *     downgrade a deployment to development behaviour.
 *   - Unknown value        -> startup is refused (HTTP 500 / CLI exit 1).
 *   - Development-only behaviour (debug output, plain-HTTP cookies, the
 *     RATE_LIMIT_ENABLED=0 switch) is keyed ONLY off the canonical name and
 *     can never be switched on by a request header/cookie/query/body.
 */
final class AppEnv
{
    private const MAP = [
        'dev' => 'dev', 'development' => 'dev', 'local' => 'dev', 'test' => 'dev', 'testing' => 'dev',
        'uat' => 'uat', 'stage' => 'uat', 'staging' => 'uat',
        'prod' => 'prod', 'production' => 'prod',
    ];

    private static ?string $name = null;

    /** Pure mapping, exposed for tests. Returns null for an unknown spelling. */
    public static function normalize(?string $raw): ?string
    {
        $raw = strtolower(trim((string)$raw));
        if ($raw === '') {
            return 'prod';
        }
        return self::MAP[$raw] ?? null;
    }

    /** Validate APP_ENV once at startup; terminates the process on an unknown value. */
    public static function boot(): string
    {
        if (self::$name !== null) {
            return self::$name;
        }
        $name = self::normalize((string)getenv('APP_ENV'));
        if ($name === null) {
            error_log('[config] Unknown APP_ENV value; refusing to start. Allowed: dev|uat|prod (aliases: development, testing, staging, production).');
            if (PHP_SAPI === 'cli') {
                fwrite(STDERR, "Unknown APP_ENV; refusing to start\n");
                exit(1);
            }
            http_response_code(500);
            header('Content-Type: application/json; charset=utf-8');
            echo json_encode(['success' => false, 'error' => 'Server misconfigured']);
            exit;
        }
        self::$name = $name;
        return $name;
    }

    public static function name(): string
    {
        return self::$name ?? self::boot();
    }

    public static function isDev(): bool  { return self::name() === 'dev'; }
    public static function isProd(): bool { return self::name() === 'prod'; }

    /** Debug output is development-only. UAT and PROD never display errors. */
    public static function debug(): bool
    {
        return self::isDev();
    }

    /**
     * Secure flag for session/identity cookies. PROD: always true (TLS is
     * terminated in front of the app). UAT: true unless COOKIE_SECURE=0 is
     * set explicitly (needed only when UAT is reached over plain HTTP, e.g.
     * the automated test rig). DEV: false unless COOKIE_SECURE=1.
     */
    public static function cookieSecure(): bool
    {
        $v = getenv('COOKIE_SECURE');
        $explicit = ($v === false || $v === '') ? null : in_array(strtolower($v), ['1', 'true', 'yes', 'on'], true);
        return match (self::name()) {
            'prod'  => true,
            'uat'   => $explicit ?? true,
            default => $explicit ?? false,
        };
    }

    /** Test helper: forget the cached value after putenv(). */
    public static function resetForTests(): void
    {
        self::$name = null;
    }
}
