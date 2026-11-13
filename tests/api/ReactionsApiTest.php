<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * HTTP-level tests of src/api/reactions.php against a running instance
 * (same contract as GameFlowApiTest: APP_BASE_URL points at DEV/UAT only).
 * This API test class can be run with PHPUnit against the configured test target and
 * against the plain server, so both the Redis fast path and the MySQL
 * fallback are exercised.
 */
final class ReactionsApiTest extends TestCase
{
    private static string $baseUrl;
    private static string $roomCode;
    /** @var array<string,string> role => cookie jar path */
    private static array $jar = [];
    /** @var array<string,int> role => user id */
    private static array $id = [];

    public static function setUpBeforeClass(): void
    {
        self::$baseUrl = rtrim(getenv('APP_BASE_URL') ?: 'http://127.0.0.1:8899', '/');
        foreach (['host', 'alice', 'bob', 'carol', 'outsider', 'anon'] as $who) {
            self::$jar[$who] = (string)tempnam(sys_get_temp_dir(), "rx_{$who}_");
        }
        $tag = bin2hex(random_bytes(4));

        $room = self::call('POST', '/api/room_create.php', [
            'name' => 'Rx Host', 'email' => "rx.host+$tag@example.com", 'title' => 'Reactions API', 'max_players' => 10,
        ], 'host');
        self::$roomCode = $room['room']['room_code'];

        foreach (['alice' => 'Alice', 'bob' => 'Bob', 'carol' => 'Carol'] as $who => $name) {
            self::call('POST', '/api/room_join.php', [
                'name' => $name, 'email' => "rx.$who+$tag@example.com", 'room_code' => self::$roomCode,
            ], $who);
        }
        // Someone with an account who belongs to a different room.
        $other = self::call('POST', '/api/room_create.php', [
            'name' => 'Rx Outsider', 'email' => "rx.out+$tag@example.com", 'title' => 'Elsewhere', 'max_players' => 5,
        ], 'outsider');

        $byName = [];
        foreach (['alice', 'bob'] as $viewer) {
            $list = self::call('GET', '/api/reactions.php?action=players&room_code=' . self::$roomCode, [], $viewer);
            foreach ($list['players'] as $p) {
                $byName[$p['name']] = (int)$p['id'];
            }
        }
        self::$id = [
            'host' => $byName['Rx Host'], 'alice' => $byName['Alice'], 'bob' => $byName['Bob'], 'carol' => $byName['Carol'],
            'outsider' => (int)$other['user']['id'],
        ];
    }

    public static function tearDownAfterClass(): void
    {
        foreach (self::$jar as $path) {
            if (is_file($path)) {
                unlink($path);
            }
        }
    }

    // ------------------------------------------------------------------ helpers

    /** @return array<string,mixed> decoded JSON plus _http_status */
    private static function call(string $method, string $path, array $body, string $who): array
    {
        $ch = curl_init(self::$baseUrl . $path);
        $opt = [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST  => $method,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_COOKIEJAR      => self::$jar[$who],
            CURLOPT_COOKIEFILE     => self::$jar[$who],
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT        => 15,
        ];
        if ($method === 'POST') {
            $opt[CURLOPT_POSTFIELDS] = json_encode($body, JSON_THROW_ON_ERROR);
        }
        curl_setopt_array($ch, $opt);
        $raw = curl_exec($ch);
        if ($raw === false) {
            throw new RuntimeException("HTTP request failed: $method $path: " . curl_error($ch));
        }
        $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $json = json_decode($raw, true);
        if (!is_array($json)) {
            throw new RuntimeException("Invalid JSON from $method $path (HTTP $status): " . substr($raw, 0, 300));
        }
        $json['_http_status'] = $status;
        return $json;
    }

    /** @return array<string,mixed> */
    private function send(string $who, string $emoji, string $target = 'everyone', ?int $recipient = null, ?string $room = null): array
    {
        return self::call('POST', '/api/reactions.php', [
            'room_code' => $room ?? self::$roomCode, 'emoji' => $emoji, 'target' => $target, 'recipient_id' => $recipient,
        ], $who);
    }

    /** @return array<string,mixed> */
    private function read(string $who, string $query, ?string $room = null): array
    {
        return self::call('GET', '/api/reactions.php?room_code=' . ($room ?? self::$roomCode) . '&' . $query, [], $who);
    }

    private function cooldown(): void
    {
        usleep(1_300_000);
    }

    // -------------------------------------------------------------------- access

    public function test_requires_a_session(): void
    {
        $res = self::call('GET', '/api/reactions.php?room_code=' . self::$roomCode . '&action=poll', [], 'anon');
        $this->assertSame(401, $res['_http_status']);
        $this->assertFalse($res['success']);
    }

    public function test_room_code_is_required(): void
    {
        $res = self::call('GET', '/api/reactions.php?action=poll', [], 'alice');
        $this->assertSame(400, $res['_http_status']);
        $this->assertStringContainsString('Room code', $res['error']);
    }

    public function test_unknown_room_is_404(): void
    {
        $this->assertSame(404, $this->read('alice', 'action=poll', 'ZZZZZZZZ')['_http_status']);
    }

    public function test_room_code_is_case_insensitive(): void
    {
        $res = $this->read('alice', 'action=latest', strtolower(self::$roomCode));
        $this->assertSame(200, $res['_http_status']);
    }

    public function test_non_member_cannot_send_poll_list_or_read_history(): void
    {
        $this->assertSame(403, $this->send('outsider', '🎉')['_http_status']);
        foreach (['action=poll&after=0', 'action=history', 'action=latest', 'action=players'] as $q) {
            $this->assertSame(403, $this->read('outsider', $q)['_http_status'], $q);
        }
    }

    public function test_unsupported_method_is_405(): void
    {
        $res = self::call('DELETE', '/api/reactions.php?room_code=' . self::$roomCode, [], 'alice');
        $this->assertSame(405, $res['_http_status']);
    }

    // ------------------------------------------------------------------- players

    public function test_players_list_has_everyone_but_the_caller_including_the_host(): void
    {
        $res = $this->read('alice', 'action=players');
        $names = array_column($res['players'], 'name');
        sort($names);
        $this->assertSame(['Bob', 'Carol', 'Rx Host'], $names);
        foreach ($res['players'] as $p) {
            $this->assertIsInt($p['id']);
        }
        $this->assertArrayNotHasKey('email', $res['players'][0], 'e-mail addresses are never exposed');
    }

    // ------------------------------------------------------------------- sending

    public function test_everyone_reaction_is_delivered_to_every_member_with_the_sender_name(): void
    {
        $sent = $this->send('alice', '🎉');
        $this->assertSame(200, $sent['_http_status']);
        $this->assertTrue($sent['success']);
        $this->assertGreaterThan(0, $sent['id']);

        foreach (['host', 'alice', 'bob', 'carol'] as $who) {
            $poll = $this->read($who, 'action=poll&after=' . ($sent['id'] - 1));
            $this->assertCount(1, $poll['reactions'], "$who should see it");
            $this->assertSame('🎉', $poll['reactions'][0]['emoji']);
            $this->assertSame('Alice', $poll['reactions'][0]['sender_name']);
            $this->assertSame('EVERYONE', $poll['reactions'][0]['audience']);
            $this->assertSame('LOBBY', $poll['room_status']);
        }
    }

    public function test_every_allowed_emoji_can_be_sent(): void
    {
        $senders = ['host', 'alice', 'bob', 'carol'];
        $emoji = ['🎉', '❤️', '😂', '👏', '🔥', '👍', '😍', '😮', '😢', '🥳', '💯', '🙌', '🤝', '✨', '🥰', '😭', '🤩', '💪'];
        $this->cooldown(); // fresh budget for every sender
        foreach ($emoji as $i => $e) {
            $who = $senders[$i % 4];
            $res = $this->send($who, $e);
            $this->assertSame(200, $res['_http_status'], "$e from $who: " . json_encode($res, JSON_UNESCAPED_UNICODE));
            if ($i % 4 === 3) {
                $this->cooldown();
            } else {
                usleep(150_000);
            }
        }
        $hist = $this->read('carol', 'action=history')['history'];
        $stored = array_column($hist, 'emoji');
        foreach ($emoji as $e) {
            $this->assertContains($e, $stored, "$e must be stored exactly as sent (utf8mb4 round-trip)");
        }
    }

    public function test_invalid_emoji_is_rejected_and_nothing_is_stored(): void
    {
        $this->cooldown();
        $before = count($this->read('bob', 'action=history')['history']);
        foreach (['', 'x', '💩', '<img src=x onerror=alert(1)>', '🎉🎉'] as $bad) {
            $res = $this->send('bob', $bad);
            $this->assertSame(400, $res['_http_status'], json_encode($bad));
            $this->assertSame('Invalid emoji.', $res['error']);
        }
        $this->assertCount($before, $this->read('bob', 'action=history')['history']);
    }

    public function test_unknown_target_means_everyone(): void
    {
        $this->cooldown();
        $res = $this->send('carol', '👍', 'nonsense');
        $this->assertSame(200, $res['_http_status']);
        $poll = $this->read('host', 'action=poll&after=' . ($res['id'] - 1));
        $this->assertSame('EVERYONE', $poll['reactions'][0]['audience']);
    }

    public function test_cooldown_blocks_a_second_immediate_reaction(): void
    {
        $this->cooldown();
        $codes = [];
        for ($i = 0; $i < 4; $i++) {
            $codes[] = $this->send('host', '🔥')['_http_status'];
        }
        $this->assertSame(200, $codes[0]);
        $this->assertContains(429, $codes, 'rapid-fire sends must be throttled: ' . implode(',', $codes));
        $this->assertLessThanOrEqual(2, count(array_keys($codes, 200, true)), implode(',', $codes));
        $res = $this->send('host', '🔥');
        $this->assertSame('Please wait a moment before sending another reaction.', $res['error'] ?? null);
    }

    public function test_cooldown_is_per_sender(): void
    {
        $this->cooldown();
        $a = $this->send('alice', '👏');
        $b = $this->send('bob', '👏');
        $this->assertSame(200, $a['_http_status']);
        $this->assertSame(200, $b['_http_status'], 'one player\'s cooldown must not block another');
    }

    public function test_cooldown_expires(): void
    {
        $this->cooldown();
        $this->assertSame(200, $this->send('carol', '😮')['_http_status']);
        $this->cooldown();
        $this->assertSame(200, $this->send('carol', '😮')['_http_status']);
    }

    // ------------------------------------------------------------ private target

    public function test_private_reaction_is_visible_only_to_sender_and_recipient(): void
    {
        $this->cooldown();
        $sent = $this->send('alice', '😍', 'player', self::$id['bob']);
        $this->assertSame(200, $sent['_http_status']);
        $after = $sent['id'] - 1;

        $this->assertCount(1, $this->read('bob', "action=poll&after=$after")['reactions'], 'recipient sees it');
        $this->assertCount(1, $this->read('alice', "action=poll&after=$after")['reactions'], 'sender sees it');
        $this->assertCount(0, $this->read('carol', "action=poll&after=$after")['reactions'], 'a bystander must not');
        $this->assertCount(0, $this->read('host', "action=poll&after=$after")['reactions'], 'not even the host');

        $this->assertLessThan($sent['id'], $this->read('carol', 'action=latest')['latest_id'], 'bystander baseline ignores it');
        $this->assertSame($sent['id'], $this->read('bob', 'action=latest')['latest_id'], 'recipient baseline includes it');
        foreach (['carol', 'host'] as $who) {
            $ids = array_column($this->read($who, 'action=history')['history'], 'id');
            $this->assertNotContains($sent['id'], $ids, "$who history must not include a private reaction");
        }
    }

    public function test_history_marks_direction_and_the_other_party(): void
    {
        $this->cooldown();
        $sent = $this->send('bob', '🥳', 'player', self::$id['alice']);
        $all = $this->send('carol', '🥳');
        $this->assertSame(200, $sent['_http_status']);

        $bob = $this->read('bob', 'action=history')['history'];
        $mine = array_values(array_filter($bob, fn($h) => $h['id'] === $sent['id']))[0];
        $this->assertSame('SENT', $mine['direction']);
        $this->assertSame('Alice', $mine['other_name']);
        $this->assertSame('PLAYER', $mine['audience']);

        $alice = $this->read('alice', 'action=history')['history'];
        $got = array_values(array_filter($alice, fn($h) => $h['id'] === $sent['id']))[0];
        $this->assertSame('RECEIVED', $got['direction']);
        $this->assertSame('Bob', $got['other_name']);

        $roomWide = array_values(array_filter($alice, fn($h) => $h['id'] === $all['id']))[0];
        $this->assertSame('RECEIVED', $roomWide['direction']);
        $this->assertSame('Carol', $roomWide['other_name']);

        $own = array_values(array_filter($this->read('carol', 'action=history')['history'], fn($h) => $h['id'] === $all['id']))[0];
        $this->assertSame('SENT', $own['direction']);
        $this->assertSame('Everyone', $own['other_name']);
    }

    public function test_history_is_newest_first_with_unix_timestamps(): void
    {
        $hist = $this->read('alice', 'action=history')['history'];
        $ids = array_column($hist, 'id');
        $sorted = $ids;
        rsort($sorted);
        $this->assertSame($sorted, $ids);
        $this->assertEqualsWithDelta(time(), (int)$hist[0]['created_at'], 120, 'created_at is a unix timestamp');
    }

    public function test_private_reaction_needs_a_valid_recipient(): void
    {
        $this->cooldown();
        $this->assertSame(400, $this->send('alice', '🎉', 'player', null)['_http_status']);
        $this->assertSame(400, $this->send('alice', '🎉', 'player', 0)['_http_status']);
        $this->assertSame('Choose another player.', $this->send('alice', '🎉', 'player', self::$id['alice'])['error']);
        $this->assertSame(404, $this->send('alice', '🎉', 'player', 2147483000)['_http_status']);
    }

    public function test_cannot_target_a_real_user_who_is_not_in_this_room(): void
    {
        $this->cooldown();
        $res = $this->send('alice', '🎉', 'player', self::$id['outsider']);
        $this->assertSame(404, $res['_http_status']);
        $this->assertSame('That player is not active in this room.', $res['error']);
    }

    // ---------------------------------------------------------------------- poll

    public function test_poll_cursor_returns_only_newer_reactions_oldest_first(): void
    {
        $this->cooldown();
        $a = $this->send('alice', '💯');
        $this->cooldown();
        $b = $this->send('alice', '🙌');
        $poll = $this->read('carol', 'action=poll&after=' . ($a['id'] - 1))['reactions'];
        $ids = array_column($poll, 'id');
        $this->assertContains($a['id'], $ids);
        $this->assertContains($b['id'], $ids);
        $sorted = $ids;
        sort($sorted);
        $this->assertSame($sorted, $ids, 'oldest first so the client cursor only moves forward');
        $this->assertSame([], $this->read('carol', 'action=poll&after=' . $b['id'])['reactions']);
    }

    public function test_poll_returns_at_most_one_page(): void
    {
        $poll = $this->read('alice', 'action=poll&after=0');
        $this->assertLessThanOrEqual(30, count($poll['reactions']));
    }

    public function test_poll_without_an_action_and_with_a_negative_cursor_is_safe(): void
    {
        $res = self::call('GET', '/api/reactions.php?room_code=' . self::$roomCode . '&after=-5', [], 'alice');
        $this->assertSame(200, $res['_http_status']);
        $this->assertArrayHasKey('reactions', $res);
    }

    public function test_latest_is_the_highest_visible_id(): void
    {
        $this->cooldown();
        $sent = $this->send('host', '👍');
        $this->assertSame($sent['id'], $this->read('carol', 'action=latest')['latest_id']);
        $this->assertSame('LOBBY', $this->read('carol', 'action=latest')['room_status']);
    }

    // --------------------------------------------------------------- injection

    public function test_sql_in_parameters_is_inert(): void
    {
        $res = self::call('GET', '/api/reactions.php?room_code=' . urlencode(self::$roomCode) . '&action=poll&after=' . urlencode('0 OR 1=1'), [], 'carol');
        $this->assertSame(200, $res['_http_status']);
        $bad = self::call('GET', '/api/reactions.php?room_code=' . urlencode("X' OR '1'='1") . '&action=poll', [], 'carol');
        $this->assertSame(404, $bad['_http_status']);
    }

    // ----------------------------------------------------------------- game end

    /** Declared last on purpose: it ends the game, which locks reactions for the room. */
    public function test_zz_game_end_locks_sending_but_not_reading(): void
    {
        $this->cooldown();
        $start = self::call('POST', '/api/game_start.php', ['room_code' => self::$roomCode], 'host');
        $this->assertTrue($start['success'] ?? false);
        usleep(300_000);

        $live = $this->send('alice', '🎉');
        $this->assertSame(200, $live['_http_status'], 'reactions are allowed while the game is live');
        $this->assertSame('LIVE', $this->read('alice', 'action=latest')['room_status']);

        $end = self::call('POST', '/api/game_end.php', ['room_code' => self::$roomCode], 'host');
        $this->assertTrue($end['success'] ?? false);
        $this->cooldown();

        $locked = $this->send('bob', '🎉');
        $this->assertSame(409, $locked['_http_status']);
        $this->assertStringContainsString('game has ended', $locked['error']);

        foreach (['host', 'alice', 'bob', 'carol'] as $who) {
            $poll = $this->read($who, 'action=poll&after=0');
            $this->assertSame(200, $poll['_http_status']);
            $this->assertSame('COMPLETED', $poll['room_status'], "$who must be told so the picker locks");
            $this->assertNotEmpty($this->read($who, 'action=history')['history'], 'history stays readable');
        }
        $this->assertSame(409, $this->send('host', '🎉', 'player', self::$id['alice'])['_http_status'], 'private reactions are locked too');
    }
}
