<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Integration tests that exercise the real HTTP API against a running
 * instance. The CI integration job boots the application against a
 * fresh MySQL instance and sets APP_BASE_URL accordingly.
 *
 * WARNING: These tests create rooms and modify game state.
 * Run against DEV/UAT only, never production.
 */
final class GameFlowApiTest extends TestCase
{
    private static string $baseUrl;
    private static string $hostCookieJar;
    private static string $playerCookieJar;
    private static string $roomCode;

    public static function setUpBeforeClass(): void
    {
        self::$baseUrl = rtrim(
            getenv('APP_BASE_URL') ?: 'http://127.0.0.1:8899',
            '/'
        );

        self::$hostCookieJar = tempnam(sys_get_temp_dir(), 'host_');
        self::$playerCookieJar = tempnam(sys_get_temp_dir(), 'player_');

        if (self::$hostCookieJar === false || self::$playerCookieJar === false) {
            throw new RuntimeException('Unable to create test cookie jars.');
        }
    }

    public static function tearDownAfterClass(): void
    {
        foreach ([self::$hostCookieJar, self::$playerCookieJar] as $cookieJar) {
            if (isset($cookieJar) && is_file($cookieJar)) {
                unlink($cookieJar);
            }
        }
    }

    /**
     * Send an HTTP request and decode its JSON response.
     *
     * The _http_status field is added for diagnostics. Existing API response
     * assertions remain compatible with this additional field.
     *
     * @return array<string, mixed>
     */
    private function request(
        string $method,
        string $path,
        array $body,
        string $cookieJar
    ): array {
        $url = self::$baseUrl . $path;
        $ch = curl_init($url);

        if ($ch === false) {
            throw new RuntimeException(
                "Unable to initialize cURL for {$method} {$path}"
            );
        }

        $options = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $method,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_COOKIEJAR => $cookieJar,
            CURLOPT_COOKIEFILE => $cookieJar,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 15,
        ];

        if ($method === 'POST') {
            $options[CURLOPT_POSTFIELDS] = json_encode(
                $body,
                JSON_THROW_ON_ERROR
            );
        }

        curl_setopt_array($ch, $options);

        $raw = curl_exec($ch);

        if ($raw === false) {
            $error = curl_error($ch);
            unset($ch);

            throw new RuntimeException(
                "HTTP request failed for {$method} {$path}: {$error}"
            );
        }

        $httpStatus = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        unset($ch);

        $decoded = json_decode($raw, true);

        if (!is_array($decoded)) {
            throw new RuntimeException(
                "Invalid JSON from {$method} {$path}; HTTP {$httpStatus}; " .
                'response: ' . substr($raw, 0, 500)
            );
        }

        $decoded['_http_status'] = $httpStatus;

        return $decoded;
    }

    /**
     * @return array<string, mixed>
     */
    private function get(string $path, string $cookieJar): array
    {
        return $this->request('GET', $path, [], $cookieJar);
    }

    /**
     * @param array<string, mixed> $body
     * @return array<string, mixed>
     */
    private function post(
        string $path,
        array $body,
        string $cookieJar
    ): array {
        return $this->request('POST', $path, $body, $cookieJar);
    }

    public function test_01_host_can_create_room(): void
    {
        $res = $this->post('/api/room_create.php', [
            'name' => 'API Test Host',
            'email' => 'apitest.host+' . bin2hex(random_bytes(4)) . '@example.com',
            'title' => 'API Test Room',
            'max_players' => 10,
        ], self::$hostCookieJar);

        $this->assertSame(200, $res['_http_status']);
        $this->assertTrue($res['success'] ?? false);
        $this->assertSame('LOBBY', $res['room']['status'] ?? null);

        self::$roomCode = $res['room']['room_code'];
    }

    public function test_02_player_can_join_and_receives_valid_ticket(): void
    {
        $res = $this->post('/api/room_join.php', [
            'name' => 'API Test Player',
            'email' => 'apitest.player+' . bin2hex(random_bytes(4)) . '@example.com',
            'room_code' => self::$roomCode,
        ], self::$playerCookieJar);

        $this->assertSame(200, $res['_http_status']);
        $this->assertTrue($res['success'] ?? false);

        $grid = $res['ticket']['grid'] ?? null;
        $this->assertIsArray($grid, 'Ticket grid must be an array.');

        $count = 0;

        foreach ($grid as $row) {
            $this->assertIsArray($row, 'Each ticket row must be an array.');

            foreach ($row as $value) {
                if ($value !== 0) {
                    $count++;
                }
            }
        }

        $this->assertSame(15, $count);
    }

    public function test_03_non_host_cannot_start_game(): void
    {
        $res = $this->post(
            '/api/game_start.php',
            ['room_code' => self::$roomCode],
            self::$playerCookieJar
        );

        $this->assertFalse($res['success'] ?? true);
    }

    public function test_04_host_can_start_game(): void
    {
        $res = $this->post(
            '/api/game_start.php',
            ['room_code' => self::$roomCode],
            self::$hostCookieJar
        );

        $this->assertTrue($res['success'] ?? false);
        $this->assertSame('LIVE', $res['room_status'] ?? null);
    }

    public function test_05_join_is_blocked_after_start(): void
    {
        $lateCookieJar = tempnam(sys_get_temp_dir(), 'late_');

        if ($lateCookieJar === false) {
            throw new RuntimeException('Unable to create late-player cookie jar.');
        }

        try {
            $res = $this->post('/api/room_join.php', [
                'name' => 'Late Joiner',
                'email' => 'late+' . bin2hex(random_bytes(4)) . '@example.com',
                'room_code' => self::$roomCode,
            ], $lateCookieJar);

            $this->assertFalse($res['success'] ?? true);
        } finally {
            if (is_file($lateCookieJar)) {
                unlink($lateCookieJar);
            }
        }
    }

    public function test_06_host_can_call_next_number(): void
    {
        // The first call may be blocked briefly by the game's start countdown.
        $res = null;

        for ($attempt = 0; $attempt < 8; $attempt++) {
            $res = $this->post(
                '/api/game_next.php',
                ['room_code' => self::$roomCode],
                self::$hostCookieJar
            );

            if ($res['success'] ?? false) {
                break;
            }

            sleep(1);
        }

        $this->assertTrue(
            $res['success'] ?? false,
            'game_next.php never succeeded: ' . json_encode($res)
        );

        $this->assertGreaterThanOrEqual(1, $res['number'] ?? 0);
        $this->assertLessThanOrEqual(90, $res['number'] ?? 0);
    }

    public function test_07_premature_full_house_claim_is_rejected(): void
    {
        $res = $this->post('/api/claim.php', [
            'room_code' => self::$roomCode,
            'prize_type' => 'FULL_HOUSE',
        ], self::$playerCookieJar);

        $this->assertFalse($res['valid'] ?? true);
    }

    public function test_08_host_can_pause_and_resume(): void
    {
        $pause = $this->post(
            '/api/game_pause.php',
            ['room_code' => self::$roomCode],
            self::$hostCookieJar
        );

        $this->assertTrue($pause['success'] ?? false);

        $resume = $this->post(
            '/api/game_resume.php',
            ['room_code' => self::$roomCode],
            self::$hostCookieJar
        );

        $this->assertTrue($resume['success'] ?? false);
    }

    public function test_09_host_can_end_game(): void
    {
        $res = $this->post(
            '/api/game_end.php',
            ['room_code' => self::$roomCode],
            self::$hostCookieJar
        );

        $this->assertTrue($res['success'] ?? false);
    }

    public function test_10_results_reflect_completed_status(): void
    {
        $res = $this->get(
            '/api/results.php?room_code=' . rawurlencode(self::$roomCode),
            self::$hostCookieJar
        );

        $this->assertTrue($res['success'] ?? false);
        $this->assertSame('COMPLETED', $res['room']['status'] ?? null);
    }
}
