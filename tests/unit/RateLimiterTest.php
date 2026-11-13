<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Integration tests against a real Redis (REDIS_HOST/REDIS_PORT). Skipped
 * when Redis is not reachable. Uses a throw-away prefix so it never touches
 * application keys.
 */
final class RateLimiterTest extends TestCase
{
    private string $prefix;

    protected function setUp(): void
    {
        if (!extension_loaded('redis') || (string)getenv('REDIS_HOST') === '') {
            $this->markTestSkipped('needs phpredis and REDIS_HOST');
        }
        $this->prefix = 'rltest' . bin2hex(random_bytes(4));
        putenv('REDIS_PREFIX=' . $this->prefix);
        putenv('RATE_LIMIT_OVERRIDES=mark=5:2,claim=50:60,admin_login_ip=3:60');
        putenv('APP_ENV=uat');
        AppEnv::resetForTests();
        RateLimiter::resetForTests();
        // RedisConn deliberately backs off for ~2 s after a failed connect (no
        // retry storms), so give it a moment if the previous test killed Redis.
        $up = false;
        for ($i = 0; $i < 8 && !$up; $i++) {
            $up = RedisConn::conn() !== null;
            if (!$up) {
                usleep(500000);
            }
        }
        if (!$up) {
            $this->markTestSkipped('Redis not reachable');
        }
    }

    protected function tearDown(): void
    {
        $r = RedisConn::conn();
        if ($r) {
            foreach ($r->keys($this->prefix . ':*') as $k) {
                $r->del($k);
            }
        }
        putenv('RATE_LIMIT_OVERRIDES');
        putenv('RATE_LIMIT_ENABLED');
        putenv('APP_ENV=testing');
        AppEnv::resetForTests();
        RateLimiter::resetForTests();
    }

    public function test_failed_redis_authentication_is_rejected_before_connection_is_cached(): void
    {
        $configuredPassword = (string)getenv('REDIS_PASSWORD');
        putenv('REDIS_PASSWORD=__housiy_intentionally_wrong_password__');
        RedisConn::reset();

        try {
            $this->assertNull(
                RedisConn::conn(),
                'a Redis socket must not be considered connected when AUTH fails'
            );
        } finally {
            if ($configuredPassword === '') {
                putenv('REDIS_PASSWORD');
            } else {
                putenv('REDIS_PASSWORD=' . $configuredPassword);
            }
            RedisConn::reset();
        }

        // Restore a working connection for tearDown and subsequent tests.
        $this->assertNotNull(RedisConn::conn(), 'Redis should reconnect with the configured credentials');
    }

    public function test_limit_boundary_and_retry_after(): void
    {
        $got = [];
        for ($i = 0; $i < 7; $i++) {
            $got[] = RateLimiter::hit('mark', 'u:1');
        }
        $this->assertSame([true, true, true, true, true, false, false], array_column($got, 'allowed'));
        $this->assertSame(0, $got[5]['remaining']);
        $this->assertGreaterThanOrEqual(1, $got[5]['retry_after']);
        $this->assertLessThanOrEqual(2, $got[5]['retry_after']);
        $this->assertSame('redis', $got[0]['backend']);
    }

    public function test_counter_always_has_ttl_and_expires_then_recovers(): void
    {
        RateLimiter::hit('mark', 'u:2');
        $r = RedisConn::conn();
        $ttl = $r->pttl(RateLimiter::key('mark', 'u:2'));
        $this->assertGreaterThan(0, $ttl);
        $this->assertLessThanOrEqual(2000, $ttl);
        for ($i = 0; $i < 6; $i++) {
            RateLimiter::hit('mark', 'u:2');
        }
        $this->assertFalse(RateLimiter::hit('mark', 'u:2')['allowed']);
        usleep(2300000);
        $this->assertSame(0, $r->exists(RateLimiter::key('mark', 'u:2')), 'key must expire by itself');
        $this->assertTrue(RateLimiter::hit('mark', 'u:2')['allowed'], 'limit recovers after the window');
    }

    public function test_key_without_ttl_is_rearmed(): void
    {
        $r = RedisConn::conn();
        $key = RateLimiter::key('mark', 'u:3');
        $r->set($key, '4');                 // simulate a counter that lost its expiry
        $this->assertSame(-1, $r->ttl($key));
        RateLimiter::hit('mark', 'u:3');
        $this->assertGreaterThan(0, $r->pttl($key));
    }

    public function test_subjects_and_policies_are_independent(): void
    {
        for ($i = 0; $i < 6; $i++) {
            RateLimiter::hit('mark', 'u:10');
        }
        $this->assertFalse(RateLimiter::hit('mark', 'u:10')['allowed']);
        $this->assertTrue(RateLimiter::hit('mark', 'u:11')['allowed']);
        $this->assertTrue(RateLimiter::hit('claim', 'u:10')['allowed']);
    }

    public function test_keys_hold_no_raw_personal_data_and_are_namespaced(): void
    {
        $k = RateLimiter::key('mark', 'someone@example.com');
        $this->assertStringNotContainsString('someone', $k);
        $this->assertStringStartsWith($this->prefix . ':rl:uat:mark:', $k);
        $this->assertNotSame(RateLimiter::key('mark', 'a'), RateLimiter::key('mark', 'b'));
    }

    public function test_parallel_workers_total_equals_limit_exactly(): void
    {
        $env = array_merge(getenv(), ['REDIS_PREFIX' => $this->prefix, 'APP_ENV' => 'uat', 'RATE_LIMIT_OVERRIDES' => 'claim=50:60']);
        $handles = [];
        for ($p = 0; $p < 12; $p++) {
            $res = proc_open([PHP_BINARY, __DIR__ . '/support/rl_worker.php', 'claim', 'u:race', '20'],
                [1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, null, $env);
            $handles[] = [$res, $pipes];
        }
        $allowed = 0;
        foreach ($handles as [$res, $pipes]) {
            $allowed += (int)stream_get_contents($pipes[1]);
            proc_close($res);
        }
        $this->assertSame(50, $allowed, '12 processes x 20 attempts = 240 requests; exactly the limit (50) may pass');
    }

    public function test_rate_limiting_cannot_be_disabled_outside_dev(): void
    {
        putenv('RATE_LIMIT_ENABLED=0');
        $this->assertTrue(RateLimiter::enabled(), 'uat ignores RATE_LIMIT_ENABLED=0');
        putenv('APP_ENV=prod');
        AppEnv::resetForTests();
        $this->assertTrue(RateLimiter::enabled(), 'prod ignores RATE_LIMIT_ENABLED=0');
        putenv('APP_ENV=development');
        AppEnv::resetForTests();
        $this->assertFalse(RateLimiter::enabled(), 'dev may switch it off');
    }

    public function test_malformed_overrides_keep_safe_defaults(): void
    {
        putenv('RATE_LIMIT_OVERRIDES=mark=abc,claim=0:60,nope=5:5,admin_login_ip=999999999:1');
        RateLimiter::resetForTests();
        $this->assertSame(RateLimiter::DEFAULTS['mark'], RateLimiter::policy('mark'));
        $this->assertSame(RateLimiter::DEFAULTS['claim'], RateLimiter::policy('claim'));
        $this->assertSame(RateLimiter::DEFAULTS['admin_login_ip'], RateLimiter::policy('admin_login_ip'));
    }

    public function test_closed_policy_fails_closed_when_redis_is_down(): void
    {
        putenv('REDIS_PORT=1');                       // nothing listens here
        RedisConn::reset();
        $res = RateLimiter::hit('admin_login_ip', '203.0.113.1');
        putenv('REDIS_PORT=' . (getenv('TEST_REDIS_PORT') ?: '6380'));
        $this->assertFalse($res['allowed'], 'admin login must never be unlimited during an outage');
        $this->assertTrue($res['unavailable']);
        $this->assertSame('none', $res['backend']);
    }

    public function test_degraded_policy_uses_bounded_local_counter_when_redis_is_down(): void
    {
        if (!function_exists('apcu_enabled') || !apcu_enabled()) {
            $this->markTestSkipped('APCu not enabled for CLI (run with -d apc.enable_cli=1)');
        }
        putenv('REDIS_PORT=1');
        RedisConn::reset();
        $subject = 'u:' . bin2hex(random_bytes(4));
        $allowed = 0;
        for ($i = 0; $i < 8; $i++) {
            $r = RateLimiter::hit('mark', $subject);          // mark = 5 per 2 s in this test
            $this->assertSame('apcu', $r['backend']);
            $allowed += $r['allowed'] ? 1 : 0;
        }
        putenv('REDIS_PORT=' . (getenv('TEST_REDIS_PORT') ?: '6380'));
        $this->assertSame(5, $allowed, 'same limit enforced locally during the outage');
    }
}
