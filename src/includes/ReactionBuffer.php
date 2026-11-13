<?php
declare(strict_types=1);

require_once __DIR__ . '/RedisConn.php';
require_once __DIR__ . '/RedisCache.php';
require_once __DIR__ . '/Realtime.php';
require_once __DIR__ . '/Reactions.php';

/**
 * Redis hot path for emoji reactions. Reads can be served from cache; accepted
 * writes are committed to MySQL first, then mirrored into Redis best-effort.
 *
 * Same contract as MarkBuffer: MySQL stays the source of truth, Redis only
 * makes it cheaper, and every function degrades to "not available" (null /
 * false) so the caller can run the plain MySQL path instead.
 *
 * Redis layout (per room):
 *   rx:seq            global INCR counter, the reaction id (== MySQL id)
 *   rx:e:{room}       ZSET score=id  reactions for EVERYONE
 *   rx:u:{room}:{uid} ZSET score=id  PRIVATE reactions the user sent or received
 *   rx:warm:{room}    marker: the ZSETs above were loaded from MySQL
 *   rx:pending        LIST of reactions not yet in MySQL (written by the worker)
 * Visibility is therefore decided by WHICH KEY a reaction is stored in: a
 * private reaction is never in a key another user reads.
 *
 * Write path: INCR the id, then in ONE transaction add the reaction to the
 * ZSET(s) and (worker alive) to rx:pending. The worker persists the pending
 * list with one multi-row INSERT per tick. If no worker is running the row
 * is inserted synchronously instead, so nothing ever waits on a dead worker.
 *
 * Idempotency: persisting skips ids that already hold the same reaction, and
 * re-inserts under a fresh MySQL id if the id is taken by a different one
 * (only possible after Redis was unreachable while MySQL-only inserts ran).
 * A reaction whose room or user was deleted meanwhile is dropped instead of
 * blocking the queue.
 */
final class ReactionBuffer
{
    public const CAP = 500;            // newest reactions kept per ZSET
    public const TTL = 86400;          // idle expiry of a room's keys
    public const PLAYERS_TTL = 20;     // cached player list of a room
    public const ROOM_TTL = 10;        // cached room row (status) - also versioned
    public const FLUSH_MAX = 1000;     // reactions persisted per worker tick
    private const CHUNK = 250;         // rows per multi-row INSERT

    private static function k(string $s): string
    {
        return RedisCache::key($s);
    }

    private static function eKey(int $room): string
    {
        return self::k('rx:e:' . $room);
    }

    private static function uKey(int $room, int $user): string
    {
        return self::k('rx:u:' . $room . ':' . $user);
    }

    private static function pendingKey(): string
    {
        return self::k('rx:pending');
    }

    public static function depth(): int
    {
        $r = RedisConn::conn();
        if (!$r) {
            return 0;
        }
        try {
            return (int)$r->lLen(self::pendingKey());
        } catch (RedisException $e) {
            RedisConn::reset();
            return 0;
        }
    }

    // --------------------------------------------------------------- warm-up

    /**
     * Make Redis a complete view of the room. Costs one MySQL query per room
     * (plus one per Redis lifetime for the id counter) and only after the
     * keys expired or Redis lost its data; otherwise two EXISTS calls.
     *
     * @param callable():PDO $db
     * @return bool false when Redis cannot be used (caller falls back)
     */
    public static function prepare(callable $db, int $roomId): bool
    {
        $r = RedisConn::conn();
        if (!$r) {
            return false;
        }
        try {
            $seqKey = self::k('rx:seq');
            $warmKey = self::k('rx:warm:' . $roomId);
            $p = $r->multi(Redis::PIPELINE);
            $p->exists($seqKey);
            $p->exists($warmKey);
            [$hasSeq, $warm] = $p->exec();
            if ($hasSeq && $warm) {
                return true;
            }
            $pdo = $db();
            if (!$hasSeq) {
                $max = (int)$pdo->query('SELECT COALESCE(MAX(id),0) FROM room_emoji_reactions')->fetchColumn();
                $r->set($seqKey, (string)$max, ['nx']);
            }
            if (!$warm) {
                $q = $pdo->prepare("SELECT r.id, r.room_id, r.sender_user_id, s.name AS sender_name,
                  r.recipient_user_id, rec.name AS recipient_name, r.audience, r.emoji,
                  UNIX_TIMESTAMP(r.created_at) AS created_at
                  FROM room_emoji_reactions r
                  JOIN users s ON s.id=r.sender_user_id
                  LEFT JOIN users rec ON rec.id=r.recipient_user_id
                  WHERE r.room_id=? ORDER BY r.id DESC LIMIT " . self::CAP);
                $q->execute([$roomId]);
                $m = $r->multi(Redis::PIPELINE);
                foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $row) {
                    $row = self::normalize($row);
                    $json = json_encode($row, JSON_UNESCAPED_UNICODE);
                    foreach (self::keysFor($row) as $key) {
                        $m->zAdd($key, $row['id'], $json);
                    }
                }
                $m->setex($warmKey, self::TTL, '1');
                $m->exec();
            }
            return true;
        } catch (RedisException $e) {
            RedisConn::reset();
            return false;
        }
    }

    /** @param array<string,mixed> $row @return array<string,mixed> */
    private static function normalize(array $row): array
    {
        return [
            'id'                => (int)$row['id'],
            'room_id'           => (int)$row['room_id'],
            'sender_user_id'    => (int)$row['sender_user_id'],
            'sender_name'       => (string)($row['sender_name'] ?? ''),
            'recipient_user_id' => isset($row['recipient_user_id']) ? (int)$row['recipient_user_id'] : null,
            'recipient_name'    => isset($row['recipient_name']) ? (string)$row['recipient_name'] : null,
            'audience'          => (string)$row['audience'],
            'emoji'             => (string)$row['emoji'],
            'created_at'        => (int)$row['created_at'],
        ];
    }

    /** @param array<string,mixed> $row @return string[] ZSET keys a reaction belongs in */
    private static function keysFor(array $row): array
    {
        $room = (int)$row['room_id'];
        if ($row['audience'] === 'EVERYONE') {
            return [self::eKey($room)];
        }
        return [self::uKey($room, (int)$row['sender_user_id']), self::uKey($room, (int)$row['recipient_user_id'])];
    }

    // ----------------------------------------------------------------- write

    /**
     * Record a reaction in Redis (call prepare() first).
     *
     * @return array{row:array<string,mixed>,deferred:bool}|null null = Redis failed, nothing stored
     */
    public static function add(int $roomId, int $senderId, string $senderName, ?int $recipientId, ?string $recipientName, string $audience, string $emoji): ?array
    {
        $r = RedisConn::conn();
        if (!$r) {
            return null;
        }
        try {
            $deferred = Realtime::workerAlive();
            $id = (int)$r->incr(self::k('rx:seq'));
            $row = [
                'id' => $id, 'room_id' => $roomId, 'sender_user_id' => $senderId, 'sender_name' => $senderName,
                'recipient_user_id' => $recipientId, 'recipient_name' => $recipientName,
                'audience' => $audience, 'emoji' => $emoji, 'created_at' => time(),
            ];
            $json = json_encode($row, JSON_UNESCAPED_UNICODE);
            $m = $r->multi(Redis::MULTI);
            foreach (self::keysFor($row) as $key) {
                $m->zAdd($key, $id, $json);
                $m->zRemRangeByRank($key, 0, -(self::CAP + 1));
                $m->expire($key, self::TTL);
            }
            $m->expire(self::k('rx:warm:' . $roomId), self::TTL);
            if ($deferred) {
                $m->rPush(self::pendingKey(), $json);
            }
            $m->exec();
            return ['row' => $row, 'deferred' => $deferred];
        } catch (RedisException $e) {
            RedisConn::reset();
            return null;
        }
    }

    /** Hand a reaction whose synchronous insert failed to the worker's queue. */
    public static function requeue(array $row): void
    {
        $r = RedisConn::conn();
        if (!$r) {
            return;
        }
        try {
            $r->rPush(self::pendingKey(), json_encode($row, JSON_UNESCAPED_UNICODE));
        } catch (RedisException $e) {
            RedisConn::reset();
        }
    }

    /** Best-effort cache insertion for a reaction already committed in MySQL. */
    public static function cachePersisted(array $row): void
    {
        $r = RedisConn::conn();
        if (!$r) return;
        try {
            $row = self::normalize($row);
            $warmKey = self::k('rx:warm:' . (int)$row['room_id']);
            // Never mark an incomplete cache as warm. If the room cache has not
            // been built yet, the next read will hydrate it from MySQL.
            if ($r->exists($warmKey)) {
                $json = json_encode($row, JSON_UNESCAPED_UNICODE);
                $m = $r->multi(Redis::MULTI);
                foreach (self::keysFor($row) as $key) {
                    $m->zAdd($key, $row['id'], $json);
                    $m->zRemRangeByRank($key, 0, -(self::CAP + 1));
                    $m->expire($key, self::TTL);
                }
                $m->expire($warmKey, self::TTL);
                $m->exec();
            }
            $seq = self::k('rx:seq');
            $current = (int)$r->get($seq);
            if ($current < (int)$row['id']) $r->set($seq, (string)$row['id']);
        } catch (Throwable $e) {
            RedisConn::reset();
        }
    }

    // ------------------------------------------------------------------ read

    /** @return array<int,array<string,mixed>>|null oldest first; null = Redis unavailable */
    public static function poll(int $roomId, int $userId, int $after, int $limit): ?array
    {
        $r = RedisConn::conn();
        if (!$r) {
            return null;
        }
        try {
            $min = '(' . max(0, $after);
            $p = $r->multi(Redis::PIPELINE);
            foreach ([self::eKey($roomId), self::uKey($roomId, $userId)] as $key) {
                $p->zRangeByScore($key, $min, '+inf', ['limit' => [0, $limit]]);
            }
            $out = [];
            foreach ($p->exec() as $members) {
                foreach (is_array($members) ? $members : [] as $json) {
                    $row = json_decode((string)$json, true);
                    if (is_array($row)) {
                        $out[(int)$row['id']] = $row;
                    }
                }
            }
            ksort($out);
            return array_slice(array_values($out), 0, $limit);
        } catch (RedisException $e) {
            RedisConn::reset();
            return null;
        }
    }

    public static function latestId(int $roomId, int $userId): ?int
    {
        $r = RedisConn::conn();
        if (!$r) {
            return null;
        }
        try {
            $p = $r->multi(Redis::PIPELINE);
            foreach ([self::eKey($roomId), self::uKey($roomId, $userId)] as $key) {
                $p->zRevRange($key, 0, 0, true);
            }
            $max = 0;
            foreach ($p->exec() as $top) {
                foreach (is_array($top) ? $top : [] as $score) {
                    $max = max($max, (int)$score);
                }
            }
            return $max;
        } catch (RedisException $e) {
            RedisConn::reset();
            return null;
        }
    }

    /** @return array<int,array<string,mixed>>|null newest first, decorated for $userId */
    public static function history(int $roomId, int $userId, int $limit): ?array
    {
        $r = RedisConn::conn();
        if (!$r) {
            return null;
        }
        try {
            $p = $r->multi(Redis::PIPELINE);
            foreach ([self::eKey($roomId), self::uKey($roomId, $userId)] as $key) {
                $p->zRevRange($key, 0, $limit - 1);
            }
            $rows = [];
            foreach ($p->exec() as $members) {
                foreach (is_array($members) ? $members : [] as $json) {
                    $row = json_decode((string)$json, true);
                    if (is_array($row)) {
                        $rows[(int)$row['id']] = $row;
                    }
                }
            }
            krsort($rows);
            return array_map(fn($row) => Reactions::decorateHistoryRow($row, $userId), array_slice(array_values($rows), 0, $limit));
        } catch (RedisException $e) {
            RedisConn::reset();
            return null;
        }
    }

    // --------------------------------------------------------- MySQL batching

    /**
     * Worker tick: persist queued reactions with ONE multi-row INSERT (plus
     * one id check). A reaction leaves the queue only after its rows are
     * committed, so a crash or DB error can only cause a retry.
     *
     * @return int reactions taken off the queue
     */
    public static function flush(PDO $pdo, int $max = self::FLUSH_MAX): int
    {
        $r = RedisConn::conn();
        if (!$r) {
            return 0;
        }
        try {
            $items = $r->lRange(self::pendingKey(), 0, $max - 1);
        } catch (RedisException $e) {
            RedisConn::reset();
            return 0;
        }
        if (!is_array($items) || !$items) {
            return 0;
        }
        $rows = [];
        foreach ($items as $json) {
            $row = json_decode((string)$json, true);
            if (is_array($row) && isset($row['id'], $row['room_id'], $row['sender_user_id'], $row['audience'], $row['emoji'])) {
                $rows[] = $row; // malformed entries are simply dropped with the batch
            }
        }
        self::persist($pdo, $rows); // throws on a DB error -> nothing is removed, retried next tick
        try {
            $r->lTrim(self::pendingKey(), count($items), -1);
        } catch (RedisException $e) {
            RedisConn::reset(); // rows stay queued; persist() skips them next time
        }
        return count($items);
    }

    /**
     * Write rows to MySQL. Safe to repeat. Used by the worker and by the
     * synchronous path (no worker alive).
     *
     * @param array<int,array<string,mixed>> $rows
     */
    public static function persist(PDO $pdo, array $rows): void
    {
        if (!$rows) {
            return;
        }
        Reactions::guard($pdo, function () use ($pdo, $rows) {
            $ids = array_map(fn($r) => (int)$r['id'], $rows);
            $q = $pdo->prepare('SELECT id, room_id, sender_user_id, emoji FROM room_emoji_reactions WHERE id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')');
            $q->execute($ids);
            $have = [];
            foreach ($q->fetchAll(PDO::FETCH_ASSOC) as $h) {
                $have[(int)$h['id']] = $h;
            }
            $fresh = $taken = [];
            foreach ($rows as $row) {
                $h = $have[(int)$row['id']] ?? null;
                if ($h === null) {
                    $fresh[] = $row;
                } elseif ((int)$h['room_id'] !== (int)$row['room_id'] || (int)$h['sender_user_id'] !== (int)$row['sender_user_id'] || $h['emoji'] !== $row['emoji']) {
                    $taken[] = $row; // id belongs to a different reaction
                } // else: already persisted (retry after a crash) -> skip
            }
            self::insertRows($pdo, $fresh, true);
            self::insertRows($pdo, $taken, false);
            if ($taken) {
                self::catchUpSeq($pdo);
            }
        });
    }

    /** @param array<int,array<string,mixed>> $rows */
    private static function insertRows(PDO $pdo, array $rows, bool $withId): void
    {
        foreach (array_chunk($rows, self::CHUNK) as $chunk) {
            try {
                self::insertChunk($pdo, $chunk, $withId);
            } catch (PDOException $e) {
                if ((int)($e->errorInfo[1] ?? 0) !== 1452) { // 1452 = FK: room/user no longer exists
                    throw $e;
                }
                foreach ($chunk as $one) { // keep the good rows, drop the orphaned ones
                    try {
                        self::insertChunk($pdo, [$one], $withId);
                    } catch (PDOException $inner) {
                        if ((int)($inner->errorInfo[1] ?? 0) !== 1452) {
                            throw $inner;
                        }
                    }
                }
            }
        }
    }

    /** @param array<int,array<string,mixed>> $chunk */
    private static function insertChunk(PDO $pdo, array $chunk, bool $withId): void
    {
        $cols = ($withId ? 'id,' : '') . 'room_id,sender_user_id,recipient_user_id,audience,emoji,created_at';
        $one = '(' . ($withId ? '?,' : '') . '?,?,?,?,?,FROM_UNIXTIME(?))';
        $args = [];
        foreach ($chunk as $r) {
            if ($withId) {
                $args[] = (int)$r['id'];
            }
            array_push($args, (int)$r['room_id'], (int)$r['sender_user_id'], $r['recipient_user_id'] !== null ? (int)$r['recipient_user_id'] : null, (string)$r['audience'], (string)$r['emoji'], (int)$r['created_at']);
        }
        $pdo->prepare("INSERT INTO room_emoji_reactions ($cols) VALUES " . implode(',', array_fill(0, count($chunk), $one)))->execute($args);
    }

    /** After an id collision make the Redis counter pass everything MySQL holds. */
    private static function catchUpSeq(PDO $pdo): void
    {
        $r = RedisConn::conn();
        if (!$r) {
            return;
        }
        try {
            $max = (int)$pdo->query('SELECT COALESCE(MAX(id),0) FROM room_emoji_reactions')->fetchColumn();
            $key = self::k('rx:seq');
            if ((int)$r->get($key) < $max) {
                $r->set($key, (string)$max);
            }
        } catch (RedisException $e) {
            RedisConn::reset();
        }
    }

    /** Retention clean-up, at most once per 10 minutes across all workers. */
    public static function maintain(PDO $pdo): void
    {
        $r = RedisConn::conn();
        if (!$r) {
            return;
        }
        try {
            if (!$r->set(self::k('rx:purgelock'), '1', ['nx', 'ex' => 600])) {
                return;
            }
        } catch (RedisException $e) {
            RedisConn::reset();
            return;
        }
        $pdo->exec('DELETE FROM room_emoji_reactions WHERE created_at < (NOW() - INTERVAL ' . Reactions::RETENTION_SECONDS . ' SECOND) LIMIT 5000');
    }
}
