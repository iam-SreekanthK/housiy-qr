<?php
declare(strict_types=1);

require_once __DIR__ . '/RedisConn.php';

/**
 * Realtime change signals.
 *
 * The WebSocket gateway carries versioned room events and small committed
 * event payloads (called number, mark, winner and reaction metadata). The
 * existing ticket.php / results.php endpoints remain canonical snapshots for
 * initial load, reconnect and sequence-gap recovery; they are not timer-polled.
 *
 * Signals are queued and flushed just before the HTTP response is written
 * (see json_response) or explicitly by the CLI worker, i.e. after the DB
 * commit, so a client woken by a signal always sees the committed state.
 */
final class Realtime
{
    /** Signal type that never bumps the room version (emoji reactions). */
    public const TRANSIENT_TYPE = 'reaction';

    /** @var array<string, array{room:string,type:string,user:?int,data?:array<string,mixed>,version?:int}> */
    private static array $queue = [];

    public static function channel(): string
    {
        return RedisConn::prefix() . ':events';
    }

    public static function versionKey(string $roomCode): string
    {
        return RedisConn::prefix() . ':room:' . $roomCode . ':v';
    }

    /** Queue a room-wide change signal (optionally limited to one user). */
    public static function room(string $roomCode, string $type, ?int $userId = null, ?array $data = null): void
    {
        $roomCode = strtoupper(trim($roomCode));
        if ($roomCode === '') {
            return;
        }
        // Reaction events carry their own payload and must not coalesce with a
        // second reaction in the same request. Other room signals remain coalesced.
        $suffix = $data !== null ? ':' . (string)($data['id'] ?? bin2hex(random_bytes(4))) : '';
        self::$queue[$roomCode . '|' . $type . '|' . ($userId ?? '*') . $suffix] = [
            'room' => $roomCode, 'type' => $type, 'user' => $userId,
            'event_id' => bin2hex(random_bytes(16)), 'occurred_at' => time(),
            ...($data !== null ? ['data' => $data] : []),
        ];
    }

    public static function workerKey(): string
    {
        return RedisConn::prefix() . ':worker:alive';
    }

    /** True while the auto-call worker is running (it refreshes a short-TTL key). */
    public static function workerAlive(): bool
    {
        $r = RedisConn::conn();
        if (!$r) {
            return false;
        }
        try {
            return (bool)$r->exists(self::workerKey());
        } catch (Throwable $e) {
            RedisConn::reset();
            return false;
        }
    }

    /** Publish one committed reaction directly; false means the outbox must retry. */
    public static function publishReaction(string $roomCode, string $audience, int $senderId, ?int $recipientId, array $data): bool
    {
        $roomCode = strtoupper(trim($roomCode));
        if ($roomCode === '') return false;
        $r = RedisConn::conn();
        if (!$r) return false;
        try {
            $targets = $audience === 'EVERYONE' ? [null] : array_values(array_unique(array_filter([$recipientId, $senderId], fn($v) => $v !== null)));
            $eventId = bin2hex(random_bytes(16));
            foreach ($targets as $target) {
                $event = ['room' => $roomCode, 'type' => 'reaction', 'user' => $target, 'event_id' => $eventId, 'occurred_at' => time(), 'data' => $data];
                $r->publish(self::channel(), json_encode($event, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR));
            }
            return true;
        } catch (Throwable $e) {
            RedisConn::reset();
            error_log('[realtime] reaction publish failed: ' . $e->getMessage());
            return false;
        }
    }

    public static function flush(): void
    {
        if (!self::$queue) {
            return;
        }
        $events = array_values(self::$queue);
        self::$queue = [];

        $r = RedisConn::conn();
        if (!$r) {
            return;
        }
        try {
            foreach ($events as $e) {
                // Room-wide changes invalidate the cached results payload.
                // Reactions are transient: they change nothing ticket.php / results.php
                // return, so they must not evict the shared room-state cache.
                if ($e['user'] === null && $e['type'] !== self::TRANSIENT_TYPE) {
                    // Keep the version key persistent. If it expires and the
                    // version falls back to zero, an older cached payload can
                    // become addressable again. Lua makes INCR + PERSIST atomic.
                    $versionKey = self::versionKey($e['room']);
                    $e['version'] = (int)$r->eval(
                        "local version = redis.call('INCR', KEYS[1]); redis.call('PERSIST', KEYS[1]); return version",
                        [$versionKey],
                        1
                    );
                }
                $r->publish(self::channel(), json_encode($e, JSON_UNESCAPED_SLASHES));
            }
        } catch (Throwable $ex) {
            RedisConn::reset();
            error_log('[realtime] publish failed: ' . $ex->getMessage());
        }
    }
}
