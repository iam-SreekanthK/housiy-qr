<?php
declare(strict_types=1);

/**
 * Database connection factory.
 * Reads credentials from environment variables (set via Docker/OpenShift).
 * Non-secret connection details fall back to sane local-dev defaults;
 * DB_USER/DB_PASS do NOT, since a fallback credential would be a fixed,
 * publicly-visible password that ships with every deployment. If they
 * aren't set, the app refuses to start rather than silently connecting
 * with a known-weak credential.
 */
final class DB
{
    private static ?PDO $instance = null;

    /** Forget the cached connection (long-running workers call this after a DB error). */
    public static function reset(): void
    {
        self::$instance = null;
    }

    /**
     * Like conn(), but for long-running CLI workers: returns null instead of
     * terminating the process when MySQL is unreachable, so the caller can
     * retry. Credentials are still required (checked once via conn() at start).
     */
    public static function tryConn(): ?PDO
    {
        if (self::$instance instanceof PDO) {
            return self::$instance;
        }
        $dsn = sprintf(
            'mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
            getenv('DB_HOST') ?: 'db',
            getenv('DB_PORT') ?: '3306',
            getenv('DB_NAME') ?: 'housiy'
        );
        try {
            self::$instance = new PDO($dsn, (string)getenv('DB_USER'), (string)getenv('DB_PASS'), [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
                PDO::MYSQL_ATTR_INIT_COMMAND => "SET time_zone = '+00:00'",
            ]);
            return self::$instance;
        } catch (PDOException $e) {
            error_log('[DB CONNECTION ERROR] ' . $e->getMessage());
            return null;
        }
    }

    public static function conn(): PDO
    {
        if (self::$instance instanceof PDO) {
            return self::$instance;
        }

        $host = getenv('DB_HOST') ?: 'db';
        $port = getenv('DB_PORT') ?: '3306';
        $name = getenv('DB_NAME') ?: 'housiy';
        $user = getenv('DB_USER');
        $pass = getenv('DB_PASS');

        if ($user === false || $user === '' || $pass === false || $pass === '') {
            http_response_code(500);
            error_log('[DB CONFIG ERROR] DB_USER/DB_PASS environment variables are not set.');
            header('Content-Type: application/json');
            echo json_encode(['success' => false, 'error' => 'Database unavailable']);
            exit;
        }

        $dsn = "mysql:host={$host};port={$port};dbname={$name};charset=utf8mb4";
        $connectStarted = microtime(true);

        try {
            self::$instance = new PDO($dsn, $user, $pass, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
                PDO::MYSQL_ATTR_INIT_COMMAND => "SET time_zone = '+00:00'",
            ]);
            if (class_exists('EndpointProfiler')) {
                EndpointProfiler::record('db.connect', (microtime(true) - $connectStarted) * 1000.0);
            }
        } catch (PDOException $e) {
            if (class_exists('EndpointProfiler')) {
                EndpointProfiler::record('db.connect_failed', (microtime(true) - $connectStarted) * 1000.0);
            }
            http_response_code(500);
            error_log('[DB CONNECTION ERROR] ' . $e->getMessage());
            header('Content-Type: application/json');
            echo json_encode(['success' => false, 'error' => 'Database unavailable']);
            exit;
        }

        return self::$instance;
    }
}
