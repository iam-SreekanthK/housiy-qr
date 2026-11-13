<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../../src/includes/Reactions.php';
require_once __DIR__ . '/../../src/includes/Realtime.php';
require_once __DIR__ . '/../../src/includes/ReactionBuffer.php';

/**
 * Pure rules of the emoji-reactions feature (no database, no Redis needed):
 * the allowed emoji, audience/recipient validation, history decoration, the
 * table-creation retry, the rate-limit policies, the realtime signal rules,
 * and consistency between server, picker UI and schema.
 */
final class ReactionsTest extends TestCase
{
    private static function root(): string
    {
        return dirname(__DIR__, 2);
    }

    // ------------------------------------------------------------- emoji list

    public function test_every_listed_emoji_is_accepted(): void
    {
        $this->assertCount(18, Reactions::EMOJIS);
        foreach (Reactions::EMOJIS as $e) {
            $this->assertTrue(Reactions::isAllowedEmoji($e), $e);
        }
    }

    public function test_list_has_no_duplicates_and_fits_the_column(): void
    {
        $this->assertSame(count(Reactions::EMOJIS), count(array_unique(Reactions::EMOJIS)));
        foreach (Reactions::EMOJIS as $e) {
            $this->assertLessThanOrEqual(32, mb_strlen($e), 'emoji column is VARCHAR(32)');
        }
    }

    /** @dataProvider rejectedEmoji */
    public function test_anything_else_is_rejected(string $value): void
    {
        $this->assertFalse(Reactions::isAllowedEmoji($value));
    }

    /** @return array<string,array{string}> */
    public static function rejectedEmoji(): array
    {
        return [
            'empty'              => [''],
            'plain text'         => ['hello'],
            'html'               => ['<script>alert(1)</script>'],
            'sql'                => ["' OR 1=1 --"],
            'unlisted emoji'     => ['💩'],
            'listed + extra'     => ['🎉🎉'],
            'trailing space'     => ['🎉 '],
            'heart without VS16' => ["\u{2764}"],
            'numeric'            => ['1'],
        ];
    }

    public function test_heart_must_be_the_emoji_presentation_form(): void
    {
        $this->assertTrue(Reactions::isAllowedEmoji("\u{2764}\u{FE0F}"));
    }

    // ---------------------------------------------------------------- audience

    public function test_audience_defaults_to_everyone(): void
    {
        $this->assertSame('EVERYONE', Reactions::audienceFor('everyone'));
        $this->assertSame('EVERYONE', Reactions::audienceFor(null));
        $this->assertSame('EVERYONE', Reactions::audienceFor('PLAYER'), 'case-sensitive on purpose');
        $this->assertSame('EVERYONE', Reactions::audienceFor(['player']));
        $this->assertSame('EVERYONE', Reactions::audienceFor(true));
    }

    public function test_player_audience_only_for_the_literal_value(): void
    {
        $this->assertSame('PLAYER', Reactions::audienceFor('player'));
    }

    /** @dataProvider closedStatuses */
    public function test_closed_statuses(string $status, bool $closed): void
    {
        $this->assertSame($closed, Reactions::isClosed($status));
    }

    /** @return array<string,array{string,bool}> */
    public static function closedStatuses(): array
    {
        return [
            'lobby'     => ['LOBBY', false],
            'live'      => ['LIVE', false],
            'paused'    => ['PAUSED', false],
            'completed' => ['COMPLETED', true],
            'cancelled' => ['CANCELLED', true],
            'lowercase' => ['completed', true],
            'empty'     => ['', false],
        ];
    }

    public function test_recipient_rules(): void
    {
        $this->assertNull(Reactions::recipientError(7, 3));
        $this->assertSame('Choose another player.', Reactions::recipientError(0, 3));
        $this->assertSame('Choose another player.', Reactions::recipientError(-5, 3));
        $this->assertSame('Choose another player.', Reactions::recipientError(3, 3), 'cannot react to yourself');
    }

    // ----------------------------------------------------------------- history

    public function test_history_row_sent_to_everyone(): void
    {
        $row = Reactions::decorateHistoryRow(
            ['sender_user_id' => 5, 'sender_name' => 'Me', 'recipient_name' => null, 'audience' => 'EVERYONE'],
            5
        );
        $this->assertSame('SENT', $row['direction']);
        $this->assertSame('Everyone', $row['other_name']);
    }

    public function test_history_row_sent_to_a_player(): void
    {
        $row = Reactions::decorateHistoryRow(
            ['sender_user_id' => 5, 'sender_name' => 'Me', 'recipient_name' => 'Asha', 'audience' => 'PLAYER'],
            5
        );
        $this->assertSame('SENT', $row['direction']);
        $this->assertSame('Asha', $row['other_name']);
    }

    public function test_history_row_received(): void
    {
        $row = Reactions::decorateHistoryRow(
            ['sender_user_id' => 9, 'sender_name' => 'Ravi', 'recipient_name' => 'Me', 'audience' => 'PLAYER'],
            5
        );
        $this->assertSame('RECEIVED', $row['direction']);
        $this->assertSame('Ravi', $row['other_name']);
    }

    public function test_history_row_falls_back_to_generic_names(): void
    {
        $sent = Reactions::decorateHistoryRow(['sender_user_id' => 5, 'recipient_name' => null, 'audience' => 'PLAYER'], 5);
        $got  = Reactions::decorateHistoryRow(['sender_user_id' => 9, 'sender_name' => null, 'audience' => 'EVERYONE'], 5);
        $this->assertSame('Player', $sent['other_name']);
        $this->assertSame('Player', $got['other_name']);
    }

    public function test_history_row_keeps_its_other_fields(): void
    {
        $row = Reactions::decorateHistoryRow(
            ['id' => 12, 'emoji' => '🔥', 'created_at' => 1700000000, 'sender_user_id' => 1, 'audience' => 'EVERYONE'],
            2
        );
        $this->assertSame(12, $row['id']);
        $this->assertSame('🔥', $row['emoji']);
        $this->assertSame(1700000000, $row['created_at']);
    }

    // ----------------------------------------------------------- table creation

    public function test_guard_returns_the_result_without_touching_ddl(): void
    {
        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->never())->method('exec');
        $this->assertSame(42, Reactions::guard($pdo, fn() => 42));
    }

    public function test_guard_creates_the_missing_table_once_and_retries(): void
    {
        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->once())->method('exec')->with(Reactions::DDL)->willReturn(0);
        $calls = 0;
        $result = Reactions::guard($pdo, function () use (&$calls) {
            if ($calls++ === 0) {
                $e = new PDOException('Base table or view not found');
                $e->errorInfo = ['42S02', 1146, "Table 'x.room_emoji_reactions' doesn't exist"];
                throw $e;
            }
            return 'ok';
        });
        $this->assertSame('ok', $result);
        $this->assertSame(2, $calls);
    }

    public function test_guard_does_not_swallow_other_database_errors(): void
    {
        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->never())->method('exec');
        $this->expectException(PDOException::class);
        Reactions::guard($pdo, function () {
            $e = new PDOException('Deadlock');
            $e->errorInfo = ['40001', 1213, 'Deadlock found'];
            throw $e;
        });
    }

    public function test_guard_gives_up_if_the_retry_fails_too(): void
    {
        $pdo = $this->createMock(PDO::class);
        $pdo->method('exec')->willReturn(0);
        $this->expectException(PDOException::class);
        Reactions::guard($pdo, function () {
            $e = new PDOException('still missing');
            $e->errorInfo = ['42S02', 1146, 'missing'];
            throw $e;
        });
    }

    // ------------------------------------------------------------------ schema

    public function test_schema_sql_defines_the_same_table_as_the_runtime_ddl(): void
    {
        $schema = (string)file_get_contents(self::root() . '/sql/schema.sql');
        $this->assertStringContainsString('CREATE TABLE IF NOT EXISTS room_emoji_reactions', $schema);
        $norm = static fn(string $s): string => preg_replace('/\s+/', '', strtolower($s));
        $block = substr($schema, (int)strpos($schema, 'CREATE TABLE IF NOT EXISTS room_emoji_reactions'));
        $block = substr($block, 0, (int)strpos($block, ';') + 1);
        $this->assertSame($norm(Reactions::DDL . ';'), $norm($block), 'schema.sql and Reactions::DDL must not drift apart');
    }

    public function test_table_is_utf8mb4_and_cascades_with_rooms(): void
    {
        $this->assertStringContainsString('utf8mb4', Reactions::DDL);
        $this->assertStringContainsString('FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE', Reactions::DDL);
        $this->assertStringContainsString('idx_room_reactions (room_id, id)', Reactions::DDL);
        $this->assertStringContainsString('idx_recipient_reactions (room_id, recipient_user_id, id)', Reactions::DDL);
    }

    // ------------------------------------------------------------------- limits

    public function test_rate_limit_policies_exist_and_are_sane(): void
    {
        [$sendLimit, $sendWindow, $sendMode] = RateLimiter::policy('reaction_send');
        [$readLimit, $readWindow, $readMode] = RateLimiter::policy('reaction_read');
        // The 800 ms cooldown already caps a sender at 75/min; the policy sits just above it.
        $this->assertGreaterThanOrEqual(intdiv(60000, Reactions::COOLDOWN_MS), $sendLimit);
        $this->assertSame(60, $sendWindow);
        $this->assertSame(60, $readWindow);
        $this->assertSame('degraded', $sendMode, 'never fails open and never blocks the game when Redis is down');
        $this->assertSame('degraded', $readMode);
        $this->assertGreaterThan(0, $readLimit);
    }

    public function test_reaction_reads_do_not_share_the_game_state_bucket(): void
    {
        $this->assertNotSame(RateLimiter::key('reaction_read', 'u:1'), RateLimiter::key('state_read', 'u:1'));
    }

    // ------------------------------------------------------------------ realtime

    public function test_reaction_signal_type_is_the_transient_one(): void
    {
        $this->assertSame('reaction', Realtime::TRANSIENT_TYPE);
    }

    /** @return array<string,array{room:string,type:string,user:?int}> */
    private function queued(): array
    {
        $ref = new ReflectionProperty(Realtime::class, 'queue');
        $ref->setAccessible(true);
        return $ref->getValue();
    }

    private function clearQueue(): void
    {
        $ref = new ReflectionProperty(Realtime::class, 'queue');
        $ref->setAccessible(true);
        $ref->setValue(null, []);
    }

    public function test_everyone_reaction_queues_one_room_wide_signal(): void
    {
        $this->clearQueue();
        Reactions::signal('abcd1234', Reactions::AUDIENCE_EVERYONE, 1, null);
        $q = array_values($this->queued());
        $this->assertCount(1, $q);
        $this->assertSame(['room' => 'ABCD1234', 'type' => 'reaction', 'user' => null], $q[0]);
        $this->clearQueue();
    }

    public function test_private_reaction_signals_only_sender_and_recipient(): void
    {
        $this->clearQueue();
        Reactions::signal('ABCD1234', Reactions::AUDIENCE_PLAYER, 11, 22);
        $users = array_map(fn($e) => $e['user'], array_values($this->queued()));
        sort($users);
        $this->assertSame([11, 22], $users, 'no room-wide (null) signal for a private reaction');
        foreach ($this->queued() as $e) {
            $this->assertSame('reaction', $e['type']);
        }
        $this->clearQueue();
    }

    public function test_flush_without_redis_is_a_safe_no_op(): void
    {
        $this->clearQueue();
        Reactions::signal('ABCD1234', Reactions::AUDIENCE_EVERYONE, 1, null);
        Realtime::flush();
        $this->assertSame([], $this->queued(), 'queue is drained even when Redis is unavailable');
    }

    // ------------------------------------------- no Redis: everything degrades

    public function test_buffer_reports_unavailable_without_redis(): void
    {
        $originalHost = getenv('REDIS_HOST');

        putenv('REDIS_HOST=');
        RedisConn::reset();

        try {
            $this->assertNull(RedisConn::conn(), 'Redis must be unavailable when REDIS_HOST is unset');

            $neverCalled = function (): PDO {
                throw new LogicException('MySQL must not be opened just to find out Redis is missing');
            };

            $this->assertFalse(ReactionBuffer::prepare($neverCalled, 1));
            $this->assertNull(ReactionBuffer::add(1, 2, 'A', null, null, 'EVERYONE', '🎉'));
            $this->assertNull(ReactionBuffer::poll(1, 2, 0, 30));
            $this->assertNull(ReactionBuffer::latestId(1, 2));
            $this->assertNull(ReactionBuffer::history(1, 2, 500));
            $this->assertSame(0, ReactionBuffer::depth());

            $pdo = $this->createMock(PDO::class);
            $pdo->expects($this->never())->method('prepare');
            $this->assertSame(0, ReactionBuffer::flush($pdo), 'nothing to flush without Redis');

            ReactionBuffer::maintain($pdo);
            ReactionBuffer::requeue(['id' => 1]);
        } finally {
            if ($originalHost === false) {
                putenv('REDIS_HOST');
            } else {
                putenv('REDIS_HOST=' . $originalHost);
            }

            RedisConn::reset();

            $failedAt = new ReflectionProperty(RedisConn::class, 'failedAt');
            $failedAt->setAccessible(true);
            $failedAt->setValue(null, 0.0);
        }
    }

    public function test_persist_with_no_rows_never_touches_mysql(): void
    {
        $pdo = $this->createMock(PDO::class);
        $pdo->expects($this->never())->method('prepare');
        $pdo->expects($this->never())->method('exec');
        ReactionBuffer::persist($pdo, []);
        $this->addToAssertionCount(1);
    }

    public function test_buffer_limits_are_sane(): void
    {
        $this->assertGreaterThanOrEqual(Reactions::HISTORY_LIMIT, ReactionBuffer::CAP, 'Redis keeps at least as much history as MySQL serves');
        $this->assertGreaterThanOrEqual(Reactions::POLL_PAGE, ReactionBuffer::CAP);
        $this->assertLessThanOrEqual(30, ReactionBuffer::PLAYERS_TTL, 'player picker staleness is bounded');
        $this->assertLessThanOrEqual(30, ReactionBuffer::ROOM_TTL, 'room status (ended-game lock) staleness is bounded');
        $this->assertGreaterThan(0, ReactionBuffer::FLUSH_MAX);
    }

    public function test_room_cache_is_versioned_by_the_realtime_version(): void
    {
        $src = (string)file_get_contents(self::root() . '/src/includes/Reactions.php');
        $this->assertStringContainsString("Realtime::versionKey(\$code)", $src, 'a game start/end must invalidate the cached room status');
    }

    public function test_worker_flushes_reactions_every_tick_and_on_shutdown(): void
    {
        $w = (string)file_get_contents(self::root() . '/bin/worker.php');
        $this->assertSame(2, substr_count($w, 'ReactionBuffer::flush('), 'once per tick and once on graceful stop');
        $this->assertStringContainsString('ReactionBuffer::maintain(', $w);
    }

    public function test_joining_drops_the_cached_player_list(): void
    {
        $j = (string)file_get_contents(self::root() . '/src/api/room_join.php');
        $this->assertStringContainsString("RedisCache::del('rx:pl:'", $j);
    }

    public function test_endpoint_opens_mysql_lazily(): void
    {
        $e = (string)file_get_contents(self::root() . '/src/api/reactions.php');
        $this->assertStringNotContainsString('$pdo = DB::conn()', $e, 'reads must not open a MySQL connection up front');
        $this->assertStringContainsString('static fn(): PDO => DB::conn()', $e);
    }

    // --------------------------------------------- server / UI / client agreement

    /** @return string[] */
    private function pickerEmoji(string $file): array
    {
        $html = (string)file_get_contents(self::root() . '/src/' . $file);
        preg_match('/id="reactionEmojiGrid">(.*?)<\/div>/s', $html, $grid);
        preg_match_all('/data-emoji="([^"]+)"/u', $grid[1] ?? '', $m);
        return $m[1];
    }

    public function test_every_emoji_in_the_picker_is_accepted_by_the_server(): void
    {
        foreach (['player.html', 'host.html'] as $page) {
            $emoji = $this->pickerEmoji($page);
            $this->assertCount(12, $emoji, "$page picker offers 12 emoji");
            foreach ($emoji as $e) {
                $this->assertTrue(Reactions::isAllowedEmoji($e), "$page offers $e but the server would reject it");
            }
        }
    }

    public function test_player_and_host_pickers_are_identical(): void
    {
        $this->assertSame($this->pickerEmoji('player.html'), $this->pickerEmoji('host.html'));
    }

    public function test_both_pages_load_the_reactions_script_after_common_js(): void
    {
        foreach (['player.html', 'host.html'] as $page) {
            $html = (string)file_get_contents(self::root() . '/src/' . $page);
            $common = strpos($html, 'assets/js/common.js');
            $emoji  = strpos($html, 'assets/js/emoji-reactions.js');
            $this->assertNotFalse($emoji, "$page must include emoji-reactions.js");
            $this->assertGreaterThan($common, $emoji, "$page: emoji-reactions.js needs common.js first");
        }
    }

    public function test_both_pages_have_every_element_the_script_binds_to(): void
    {
        $ids = ['reactionTrigger', 'reactionModal', 'reactionFloatLayer', 'reactionClose', 'reactionEmojiGrid',
                'reactionPlayerWrap', 'reactionPlayerSelect', 'reactionSend', 'reactionHistoryList',
                'reactionHistoryCount', 'reactionHistoryCard', 'reactionHistoryToggle'];
        foreach (['player.html', 'host.html'] as $page) {
            $html = (string)file_get_contents(self::root() . '/src/' . $page);
            foreach ($ids as $id) {
                $this->assertSame(1, substr_count($html, 'id="' . $id . '"'), "$page: #$id must exist exactly once");
            }
        }
    }

    public function test_pages_that_do_not_play_have_no_reaction_button(): void
    {
        foreach (['index.html', 'admin.html', 'admin_login.html'] as $page) {
            $html = (string)file_get_contents(self::root() . '/src/' . $page);
            $this->assertStringNotContainsString('reactionTrigger', $html, $page);
        }
    }
}
