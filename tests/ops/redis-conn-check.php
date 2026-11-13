<?php
declare(strict_types=1);

/**
 * Standalone RedisConn integration check (requires PHP phpredis).
 *
 * Normal mode, against a disposable Redis:
 *   REDIS_HOST=127.0.0.1 REDIS_PORT=6379 [REDIS_PASSWORD=...] [REDIS_DB=0] \
 *     php tests/ops/redis-conn-check.php
 *
 * Negative mode, against an endpoint that MUST reject the configured
 * connection (e.g. auth-required Redis with REDIS_PASSWORD empty, or a stopped
 * Redis server):
 *   REDIS_HOST=127.0.0.1 REDIS_PORT=6379 REDIS_PASSWORD= \
 *     REDIS_TEST_EXPECT_UNAVAILABLE=1 php tests/ops/redis-conn-check.php
 *
 * Never point these tests at a shared/production Redis. The script writes and
 * deletes only short-lived keys with a random suffix and never prints secrets.
 */
require_once __DIR__ . '/../../src/includes/RedisConn.php';

$fail = 0;
function check(string $name, bool $ok): void
{
    global $fail;
    echo ($ok ? 'PASS' : 'FAIL') . '  ' . $name . "\n";
    if (!$ok) $fail++;
}

if (!extension_loaded('redis')) {
    fwrite(STDERR, "phpredis extension is required; install/enable ext-redis first.\n");
    exit(2);
}
if ((string)getenv('REDIS_HOST') === '') {
    fwrite(STDERR, "Set REDIS_HOST to a disposable Redis endpoint.\n");
    exit(2);
}

$expectUnavailable = filter_var(getenv('REDIS_TEST_EXPECT_UNAVAILABLE') ?: '0', FILTER_VALIDATE_BOOLEAN);
$origPass = getenv('REDIS_PASSWORD');
$origDb = getenv('REDIS_DB');

if ($expectUnavailable) {
    // This mode explicitly covers both an empty password against an
    // auth-required server and a server that is not accepting connections.
    putenv('REDIS_PERSISTENT=1');
    RedisConn::reset();
    check('configured endpoint is unavailable and safely returns null', RedisConn::conn() === null);
    RedisConn::reset();
    echo $fail === 0 ? "\nNegative RedisConn check passed.\n" : "\n$fail RedisConn check(s) FAILED.\n";
    exit($fail === 0 ? 0 : 1);
}

// Both connection modes must complete the handshake and execute commands.
foreach (['0' => 'per-request connect()', '1' => 'persistent pconnect()'] as $flag => $label) {
    putenv('REDIS_PERSISTENT=' . $flag);
    RedisConn::reset();
    $r = RedisConn::conn();
    check("$label: connects, authenticates/selects and pings", $r instanceof Redis);
    if ($r instanceof Redis) {
        $k = RedisConn::prefix() . ':conncheck:' . bin2hex(random_bytes(8));
        check("$label: command round-trip", $r->setex($k, 5, 'ok') === true && $r->get($k) === 'ok');
        $r->del($k);
    }
    RedisConn::reset();
    check("$label: reset() then conn() reconnects", RedisConn::conn() instanceof Redis);
}

// Wrong credentials must never produce a usable connection. On an
// unauthenticated Redis, AUTH itself is rejected, which is also expected to
// take the fail-safe path.
putenv('REDIS_PERSISTENT=1');
$wrongPass = (string)($origPass === false ? '' : $origPass) . '-definitely-wrong';
putenv('REDIS_PASSWORD=' . $wrongPass);
RedisConn::reset();
check('wrong REDIS_PASSWORD -> conn() returns null', RedisConn::conn() === null);

// Restore credentials before testing invalid database selection.
if ($origPass === false) {
    putenv('REDIS_PASSWORD');
} else {
    putenv('REDIS_PASSWORD=' . $origPass);
}
putenv('REDIS_DB=999');
RedisConn::reset();
check('invalid REDIS_DB -> conn() returns null', RedisConn::conn() === null);

// Restore process environment for callers that include this script.
if ($origDb === false) {
    putenv('REDIS_DB');
} else {
    putenv('REDIS_DB=' . $origDb);
}
if ($origPass === false) {
    putenv('REDIS_PASSWORD');
} else {
    putenv('REDIS_PASSWORD=' . $origPass);
}
RedisConn::reset();

echo $fail === 0 ? "\nAll RedisConn checks passed.\n" : "\n$fail RedisConn check(s) FAILED.\n";
exit($fail === 0 ? 0 : 1);
