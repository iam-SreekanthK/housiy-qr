<?php
declare(strict_types=1);

require_once __DIR__ . '/RedisConn.php';
require_once __DIR__ . '/RedisCache.php';
require_once __DIR__ . '/Realtime.php';
require_once __DIR__ . '/RoomAccess.php';
require_once __DIR__ . '/ReactionBuffer.php';

/**
 * Room-scoped emoji reactions.
 *
 * MySQL (table room_emoji_reactions) is the source of truth, exactly like the
 * rest of the game. Redis only makes it cheaper and faster (see ReactionBuffer):
 *   - reads (poll / latest / history / players / room status) are served from
 *     Redis: zero MySQL queries once a room is warm;
 *   - every accepted reaction and its realtime outbox row commit together in
 *     MySQL; Redis cache writes are best-effort and never own accepted data;
 *   - the worker retries durable outbox events when Redis Pub/Sub is unavailable;
 *   - a membership fact is cached (membership never changes once joined);
 *   - the per-sender cooldown is one atomic SET NX PX (falls back to a MySQL
 *     timestamp check when Redis is unavailable);
 *   - without Redis every function below runs the plain MySQL queries;
 *   - a "reaction" signal is published after the INSERT commits so connected
 *     browsers fetch it immediately instead of polling (see Realtime::flush:
 *     this signal type does NOT bump the room-state cache version, because a
 *     reaction never changes anything that ticket.php / results.php return).
 *
 * Visibility rules (enforced in SQL, in every read):
 *   EVERYONE reactions -> every member of the room
 *   PLAYER reactions   -> only the sender and the recipient
 */
final class Reactions
{
    /** Request-local committed events for the no-extra-SQL realtime fast path. */
    private static array $recentCommittedEvents = [];
    private static bool $lastStoreWasReplay = false;
    /** Every emoji the server accepts (the picker UI offers a subset of these). */
    public const EMOJIS = ['🎉', '❤️', '😂', '👏', '🔥', '👍', '😍', '😮', '😢', '🥳', '💯', '🙌', '🤝', '✨', '🥰', '😭', '🤩', '💪'];

    public const AUDIENCE_EVERYONE = 'EVERYONE';
    public const AUDIENCE_PLAYER   = 'PLAYER';

    /** Rows returned by one poll; clients keep polling while a page comes back full. */
    public const POLL_PAGE = 30;
    /** Upper bound for one history response. */
    public const HISTORY_LIMIT = 500;
    /** Minimum gap between two reactions from the same sender in the same room. */
    public const COOLDOWN_MS = 800;
    /** Reactions older than this are purged (opportunistically, on send). */
    public const RETENTION_SECONDS = 86400;

    public const DDL = "CREATE TABLE IF NOT EXISTS room_emoji_reactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  room_id BIGINT UNSIGNED NOT NULL,
  sender_user_id BIGINT UNSIGNED NOT NULL,
  recipient_user_id BIGINT UNSIGNED NULL,
  audience ENUM('EVERYONE','PLAYER') NOT NULL,
  emoji VARCHAR(32) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_room_reactions (room_id, id),
  KEY idx_recipient_reactions (room_id, recipient_user_id, id),
  KEY idx_reactions_created (created_at),
  CONSTRAINT fk_rer_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
  CONSTRAINT fk_rer_sender FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_rer_recipient FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";

    public const OUTBOX_DDL = "CREATE TABLE IF NOT EXISTS room_reaction_outbox (
  reaction_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
  room_code CHAR(8) NOT NULL,
  audience ENUM('EVERYONE','PLAYER') NOT NULL,
  sender_user_id BIGINT UNSIGNED NOT NULL,
  recipient_user_id BIGINT UNSIGNED NULL,
  payload JSON NOT NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_attempt_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at DATETIME NULL,
  last_error VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_reaction_outbox_pending (published_at, next_attempt_at, reaction_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";

    public const IDEMPOTENCY_DDL = "CREATE TABLE IF NOT EXISTS room_reaction_idempotency (
  room_id BIGINT UNSIGNED NOT NULL,
  sender_user_id BIGINT UNSIGNED NOT NULL,
  idempotency_key CHAR(32) NOT NULL,
  reaction_id BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (room_id, sender_user_id, idempotency_key),
  KEY idx_reaction_idempotency_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";

    // ------------------------------------------------------------ pure rules

    public static function isAllowedEmoji(string $emoji): bool
    {
        return in_array($emoji, self::EMOJIS, true);
    }

    /** Anything other than the literal "player" means the whole room. */
    public static function audienceFor(mixed $target): string
    {
        return $target === 'player' ? self::AUDIENCE_PLAYER : self::AUDIENCE_EVERYONE;
    }

    /** Reactions stop once the game has ended (completed or cancelled). */
    public static function isClosed(string $roomStatus): bool
    {
        return in_array(strtoupper($roomStatus), ['COMPLETED', 'CANCELLED'], true);
    }

    /**
     * Validate a private recipient id against the sender.
     * @return string|null an error message, or null when acceptable
     */
    public static function recipientError(int $recipientId, int $senderId): ?string
    {
        return ($recipientId < 1 || $recipientId === $senderId) ? 'Choose another player.' : null;
    }

    /**
     * Turn a history row into what the browser renders: direction relative to
     * $userId and the name of the "other side".
     *
     * @param array<string,mixed> $row
     * @return array<string,mixed>
     */
    public static function decorateHistoryRow(array $row, int $userId): array
    {
        $sent = (int)$row['sender_user_id'] === $userId;
        $row['direction'] = $sent ? 'SENT' : 'RECEIVED';
        $row['other_name'] = $sent
            ? (($row['audience'] === self::AUDIENCE_EVERYONE) ? 'Everyone' : ($row['recipient_name'] ?? 'Player'))
            : ($row['sender_name'] ?? 'Player');
        return $row;
    }

    // --------------------------------------------------------------- storage

    public static function ensureTable(PDO $pdo): void
    {
        $pdo->exec(self::DDL);
        $pdo->exec(self::OUTBOX_DDL);
        $pdo->exec(self::IDEMPOTENCY_DDL);
    }

    /**
     * Run $fn; if the table does not exist yet (database created before this
     * feature shipped) create it once and retry. New installs get the table
     * from sql/schema.sql, so no DDL runs on the normal request path.
     *
     * @template T
     * @param callable():T $fn
     * @return T
     */
    public static function guard(PDO $pdo, callable $fn): mixed
    {
        try {
            return $fn();
        } catch (PDOException $e) {
            if (($e->errorInfo[0] ?? '') !== '42S02') {
                throw $e;
            }
            self::ensureTable($pdo);
            return $fn();
        }
    }

    /**
     * Room row (id, room_code, status, host_user_id). Cached in Redis under the
     * room's realtime version (so a start/end invalidates it at once) with a
     * short TTL as safety net; unknown rooms are 404 and never cached.
     *
     * @param callable():PDO $db
     */
    public static function roomFor(callable $db, string $roomCode): array
    {
        $code = strtoupper(trim($roomCode));
        $r = RedisConn::conn();
        $key = null;
        if ($r) {
            try {
                $key = RedisCache::key('rx:room:' . $code . ':' . (int)$r->get(Realtime::versionKey($code)));
                $hit = $r->get($key);
                if (is_string($hit)) {
                    $room = json_decode($hit, true);
                    if (is_array($room) && isset($room['id'], $room['status']) && array_key_exists('ended_at', $room)) {
                        return $room;
                    }
                }
            } catch (RedisException $e) {
                RedisConn::reset();
                $key = null;
            }
        }
        $row = RoomAccess::findByCode($db(), $code); // 404 if unknown
        $room = ['id' => (int)$row['id'], 'room_code' => (string)$row['room_code'], 'status' => (string)$row['status'], 'host_user_id' => (int)$row['host_user_id'], 'ended_at' => $row['ended_at'] ?? null];
        if ($key !== null) {
            RedisCache::setRaw($key, json_encode($room), ReactionBuffer::ROOM_TTL);
        }
        return $room;
    }

    /**
     * Membership is immutable once joined, so the positive fact is cached.
     * @param callable():PDO $db
     */
    public static function requireActiveMember(callable $db, array $room, array $user): void
    {
        // The host is a room-scoped participant even if a legacy/rematch room
        // has not yet materialized their room_players row. This mirrors
        // RoomAccess::requireMember and prevents host reaction reads from
        // returning 403 while the host dashboard is otherwise authorized.
        if ((int)($room['host_user_id'] ?? 0) === (int)($user['id'] ?? 0)) {
            return;
        }
        $k = 'rxm:' . (int)$room['id'] . ':' . (int)$user['id'];
        if (RedisCache::get($k) === '1') {
            return;
        }
        $q = $db()->prepare('SELECT 1 FROM room_players WHERE room_id=? AND user_id=? AND is_active=1 LIMIT 1');
        $q->execute([(int)$room['id'], (int)$user['id']]);
        if (!$q->fetchColumn()) {
            json_error('You are not an active player in this room.', 403);
        }
        RedisCache::set($k, '1', 300);
    }

    /**
     * Every active player of the room, host included (cached briefly; room_join
     * drops the cache so a new player shows up at once).
     *
     * @param callable():PDO $db
     * @return array<int,array{id:int,name:string}>
     */
    public static function roomPlayers(callable $db, int $roomId, bool $fresh = false): array
    {
        $key = 'rx:pl:' . $roomId;
        if (!$fresh) {
            $hit = RedisCache::get($key);
            $list = $hit === null ? null : json_decode($hit, true);
            if (is_array($list)) {
                return $list;
            }
        }
        $q = $db()->prepare('SELECT u.id, u.name FROM room_players rp JOIN users u ON u.id=rp.user_id WHERE rp.room_id=? AND rp.is_active=1 ORDER BY u.name');
        $q->execute([$roomId]);
        $list = array_map(fn($r) => ['id' => (int)$r['id'], 'name' => (string)$r['name']], $q->fetchAll());
        RedisCache::set($key, json_encode($list, JSON_UNESCAPED_UNICODE), ReactionBuffer::PLAYERS_TTL);
        return $list;
    }

    /**
     * Everyone but the caller.
     * @param callable():PDO $db
     * @return array<int,array{id:int,name:string}>
     */
    public static function players(callable $db, int $roomId, int $exceptUserId): array
    {
        return array_values(array_filter(self::roomPlayers($db, $roomId), fn($p) => $p['id'] !== $exceptUserId));
    }

    // ------------------------------------------------- reads (Redis, else MySQL)

    /**
     * @param callable():PDO $db
     * @return array<int,array<string,mixed>>
     */
    public static function historyFor(callable $db, int $roomId, int $userId): array
    {
        if (ReactionBuffer::prepare($db, $roomId)) {
            $rows = ReactionBuffer::history($roomId, $userId, self::HISTORY_LIMIT);
            if ($rows !== null) {
                return $rows;
            }
        }
        return self::history($db(), $roomId, $userId);
    }

    /** Total reactions visible to this user (not limited by HISTORY_LIMIT). */
    public static function countFor(callable $db, int $roomId, int $userId): int
    {
        $pdo = $db();
        return self::guard($pdo, function () use ($pdo, $roomId, $userId): int {
            $q = $pdo->prepare("SELECT COUNT(*) FROM room_emoji_reactions WHERE room_id=? AND (audience='EVERYONE' OR sender_user_id=? OR recipient_user_id=?)");
            $q->execute([$roomId, $userId, $userId]);
            return (int)$q->fetchColumn();
        });
    }

    /** @param callable():PDO $db */
    public static function latestFor(callable $db, int $roomId, int $userId): int
    {
        if (ReactionBuffer::prepare($db, $roomId)) {
            $id = ReactionBuffer::latestId($roomId, $userId);
            if ($id !== null) {
                return $id;
            }
        }
        return self::latestId($db(), $roomId, $userId);
    }

    /**
     * @param callable():PDO $db
     * @return array<int,array<string,mixed>>
     */
    public static function pollFor(callable $db, int $roomId, int $userId, int $after): array
    {
        if (ReactionBuffer::prepare($db, $roomId)) {
            $rows = ReactionBuffer::poll($roomId, $userId, $after, self::POLL_PAGE);
            if ($rows !== null) {
                $shape = array_flip(['id', 'sender_user_id', 'sender_name', 'recipient_user_id', 'audience', 'emoji', 'created_at']);
                return array_map(fn($r) => array_intersect_key($r, $shape), $rows);
            }
        }
        return self::poll($db(), $roomId, $userId, $after);
    }

    /** @return array<int,array<string,mixed>> newest first, only what $userId may see */
    public static function history(PDO $pdo, int $roomId, int $userId): array
    {
        return self::guard($pdo, function () use ($pdo, $roomId, $userId) {
            $q = $pdo->prepare("SELECT r.id, r.sender_user_id, s.name AS sender_name,
              r.recipient_user_id, rec.name AS recipient_name, r.audience, r.emoji,
              UNIX_TIMESTAMP(r.created_at) AS created_at
              FROM room_emoji_reactions r
              JOIN users s ON s.id=r.sender_user_id
              LEFT JOIN users rec ON rec.id=r.recipient_user_id
              WHERE r.room_id=? AND (r.audience='EVERYONE' OR r.sender_user_id=? OR r.recipient_user_id=?)
              ORDER BY r.id DESC LIMIT " . self::HISTORY_LIMIT);
            $q->execute([$roomId, $userId, $userId]);
            return array_map(fn($row) => self::decorateHistoryRow($row, $userId), $q->fetchAll(PDO::FETCH_ASSOC));
        });
    }

    /** Highest reaction id visible to $userId (a baseline so old reactions are not replayed). */
    public static function latestId(PDO $pdo, int $roomId, int $userId): int
    {
        return self::guard($pdo, function () use ($pdo, $roomId, $userId) {
            $q = $pdo->prepare("SELECT COALESCE(MAX(id), 0) FROM room_emoji_reactions WHERE room_id=? AND (audience='EVERYONE' OR recipient_user_id=? OR sender_user_id=?)");
            $q->execute([$roomId, $userId, $userId]);
            return (int)$q->fetchColumn();
        });
    }

    /** @return array<int,array<string,mixed>> oldest first, ids greater than $after */
    public static function poll(PDO $pdo, int $roomId, int $userId, int $after): array
    {
        return self::guard($pdo, function () use ($pdo, $roomId, $userId, $after) {
            $q = $pdo->prepare("SELECT r.id, r.sender_user_id, u.name AS sender_name, r.recipient_user_id, r.audience, r.emoji, UNIX_TIMESTAMP(r.created_at) created_at FROM room_emoji_reactions r JOIN users u ON u.id=r.sender_user_id WHERE r.room_id=? AND r.id>? AND (r.audience='EVERYONE' OR r.recipient_user_id=? OR r.sender_user_id=?) ORDER BY r.id ASC LIMIT " . self::POLL_PAGE);
            $q->execute([$roomId, max(0, $after), $userId, $userId]);
            return $q->fetchAll();
        });
    }

    // ---------------------------------------------------------------- sending

    /**
     * True when the sender may send now. Atomic in Redis (one SET NX PX); the
     * MySQL fallback compares against the sender's last row (1 s resolution).
     */
    public static function cooldownPassed(callable $db, int $roomId, int $userId): bool
    {
        $r = RedisConn::conn();
        if ($r) {
            try {
                return (bool)$r->set(RedisCache::key('rxcd:' . $roomId . ':' . $userId), '1', ['nx', 'px' => self::COOLDOWN_MS]);
            } catch (Throwable $e) {
                RedisConn::reset();
            }
        }
        $pdo = $db();
        return self::guard($pdo, function () use ($pdo, $roomId, $userId) {
            $q = $pdo->prepare('SELECT TIMESTAMPDIFF(SECOND, created_at, NOW()) FROM room_emoji_reactions WHERE room_id=? AND sender_user_id=? ORDER BY id DESC LIMIT 1');
            $q->execute([$roomId, $userId]);
            $elapsed = $q->fetchColumn();
            return $elapsed === false || $elapsed === null || (int)$elapsed >= 1;
        });
    }

    /** Find an already committed idempotent reaction for this sender and room. */
    public static function findIdempotent(callable $db, int $roomId, int $senderId, string $key): ?int
    {
        if ($key === '') return null;
        $pdo = $db();
        return self::guard($pdo, function () use ($pdo, $roomId, $senderId, $key): ?int {
            $q = $pdo->prepare('SELECT reaction_id FROM room_reaction_idempotency WHERE room_id=? AND sender_user_id=? AND idempotency_key=? LIMIT 1');
            $q->execute([$roomId, $senderId, $key]);
            $id = $q->fetchColumn();
            return $id === false || $id === null ? null : (int)$id;
        });
    }

    /** Insert and return the new reaction id. */
    public static function insert(PDO $pdo, int $roomId, int $senderId, ?int $recipientId, string $audience, string $emoji): int
    {
        return self::guard($pdo, function () use ($pdo, $roomId, $senderId, $recipientId, $audience, $emoji) {
            $ins = $pdo->prepare('INSERT INTO room_emoji_reactions (room_id,sender_user_id,recipient_user_id,audience,emoji) VALUES (?,?,?,?,?)');
            $ins->execute([$roomId, $senderId, $recipientId, $audience, $emoji]);
            return (int)$pdo->lastInsertId();
        });
    }

    /** Opportunistic retention clean-up (about 1 send in 100). */
    public static function maybePurge(PDO $pdo): void
    {
        if (random_int(1, 100) !== 1) {
            return;
        }
        try {
            $pdo->exec('DELETE FROM room_emoji_reactions WHERE created_at < (NOW() - INTERVAL ' . self::RETENTION_SECONDS . ' SECOND)');
            $pdo->exec('DELETE FROM room_reaction_idempotency WHERE created_at < (NOW() - INTERVAL ' . self::RETENTION_SECONDS . ' SECOND)');
        } catch (Throwable $e) {
            error_log('[reactions] purge failed: ' . $e->getMessage());
        }
    }

    /**
     * Persist reaction + outbox atomically in MySQL before acknowledging it.
     * Redis is only a best-effort cache/delivery accelerator; it never owns
     * the accepted reaction or its ID.
     *
     * @param callable():PDO $db
     */
    public static function store(callable $db, int $roomId, array $sender, ?int $recipientId, ?string $recipientName, string $audience, string $emoji, string $roomCode = '', string $idempotencyKey = ''): int
    {
        $pdo = $db();
        return self::guard($pdo, function () use ($pdo, $roomId, $sender, $recipientId, $recipientName, $audience, $emoji, $roomCode, $idempotencyKey): int {
            $ownsTransaction = !$pdo->inTransaction();
            if ($ownsTransaction) {
                $pdo->beginTransaction();
            }
            try {
                self::$lastStoreWasReplay = false;
                if ($idempotencyKey !== '') {
                    $reserve = $pdo->prepare('INSERT IGNORE INTO room_reaction_idempotency (room_id,sender_user_id,idempotency_key,reaction_id) VALUES (?,?,?,NULL)');
                    $reserve->execute([$roomId, (int)$sender['id'], $idempotencyKey]);
                    if ($reserve->rowCount() === 0) {
                        $lookup = $pdo->prepare('SELECT reaction_id FROM room_reaction_idempotency WHERE room_id=? AND sender_user_id=? AND idempotency_key=? FOR UPDATE');
                        $lookup->execute([$roomId, (int)$sender['id'], $idempotencyKey]);
                        $existingId = (int)$lookup->fetchColumn();
                        if ($existingId > 0) {
                            if ($ownsTransaction) $pdo->commit();
                            self::$lastStoreWasReplay = true;
                            return $existingId;
                        }
                    }
                }
                $id = self::insert($pdo, $roomId, (int)$sender['id'], $recipientId, $audience, $emoji);
                $event = [
                    'id' => $id, 'room_id' => $roomId, 'emoji' => $emoji,
                    'sender_user_id' => (int)$sender['id'], 'sender_name' => (string)$sender['name'],
                    'recipient_user_id' => $recipientId, 'recipient_name' => $recipientName,
                    'audience' => $audience, 'created_at' => time(),
                ];
                $outbox = $pdo->prepare('INSERT INTO room_reaction_outbox (reaction_id,room_code,audience,sender_user_id,recipient_user_id,payload) VALUES (?,?,?,?,?,?)');
                $outbox->execute([$id, strtoupper(trim($roomCode)), $audience, (int)$sender['id'], $recipientId, json_encode($event, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR)]);
                if ($idempotencyKey !== '') {
                    $idemUpdate = $pdo->prepare('UPDATE room_reaction_idempotency SET reaction_id=? WHERE room_id=? AND sender_user_id=? AND idempotency_key=?');
                    $idemUpdate->execute([$id, $roomId, (int)$sender['id'], $idempotencyKey]);
                }
                if ($ownsTransaction) {
                    $pdo->commit();
                }
            } catch (Throwable $e) {
                if ($ownsTransaction && $pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }
            // Cache population is deliberately best effort. A failed Redis write
            // cannot undo or lose the committed MySQL reaction.
            // Keep the just-committed event in request memory. The API can
            // publish it without SELECTing the outbox row and updating it on
            // the latency-sensitive request. The durable worker will mark the
            // outbox row published in a batch; duplicate delivery is expected
            // and clients deduplicate by the MySQL reaction ID.
            self::$recentCommittedEvents[$id] = [
                'room_code' => strtoupper(trim($roomCode)),
                'audience' => $audience,
                'sender_user_id' => (int)$sender['id'],
                'recipient_user_id' => $recipientId,
                'payload' => $event,
            ];
            try {
                ReactionBuffer::cachePersisted($event);
            } catch (Throwable $e) {
                error_log('[reactions] cache update failed: ' . $e->getMessage());
            }
            self::maybePurge($pdo);
            return $id;
        });
    }

    /**
     * Publish the just-committed reaction from request memory, avoiding an
     * outbox SELECT and per-event UPDATE on the API critical path. The durable
     * outbox remains pending until the worker publishes/marks it in batches;
     * therefore this fast path is intentionally at-least-once.
     */
    public static function lastStoreWasReplay(): bool
    {
        return self::$lastStoreWasReplay;
    }

    public static function publishImmediateReaction(int $reactionId): bool
    {
        $row = self::$recentCommittedEvents[$reactionId] ?? null;
        unset(self::$recentCommittedEvents[$reactionId]);
        if (!$row) return false;
        return Realtime::publishReaction(
            (string)$row['room_code'],
            (string)$row['audience'],
            (int)$row['sender_user_id'],
            $row['recipient_user_id'] === null ? null : (int)$row['recipient_user_id'],
            (array)$row['payload']
        );
    }

    /** Fast path for retrying an existing durable outbox row. */
    public static function publishOutboxReaction(PDO $pdo, int $reactionId): bool
    {
        $q = $pdo->prepare('SELECT reaction_id,room_code,audience,sender_user_id,recipient_user_id,payload FROM room_reaction_outbox WHERE reaction_id=? AND published_at IS NULL LIMIT 1');
        $q->execute([$reactionId]);
        $row = $q->fetch(PDO::FETCH_ASSOC);
        if (!$row) return true; // already published by another worker/request
        $payload = json_decode((string)$row['payload'], true);
        if (!is_array($payload)) {
            self::recordOutboxFailure($pdo, $reactionId, 'Invalid outbox payload');
            return false;
        }
        // A Redis outage may have left a previously warm cache stale. Reapply
        // the committed reaction before publishing; if the cache is cold, the
        // next prepare() hydrates it from MySQL instead.
        try { ReactionBuffer::cachePersisted($payload); } catch (Throwable $e) { /* cache is best effort */ }
        if (!Realtime::publishReaction((string)$row['room_code'], (string)$row['audience'], (int)$row['sender_user_id'], $row['recipient_user_id'] === null ? null : (int)$row['recipient_user_id'], $payload)) {
            self::recordOutboxFailure($pdo, $reactionId, 'Realtime transport unavailable');
            return false;
        }
        $done = $pdo->prepare('UPDATE room_reaction_outbox SET published_at=NOW(), last_error=NULL WHERE reaction_id=? AND published_at IS NULL');
        $done->execute([$reactionId]);
        return true;
    }

    /**
     * Publish a bounded batch of committed outbox events. The pending index is
     * used by the ordered range scan; successful and failed rows are updated in
     * batches so a worker tick does not issue SELECT+UPDATE for every reaction.
     * Delivery is at-least-once; clients deduplicate by reaction ID.
     */
    public static function publishOutbox(PDO $pdo, int $limit = 100): int
    {
        $limit = max(1, min(500, $limit));
        $q = $pdo->prepare("SELECT reaction_id,room_code,audience,sender_user_id,recipient_user_id,payload FROM room_reaction_outbox FORCE INDEX (idx_reaction_outbox_pending) WHERE published_at IS NULL AND next_attempt_at <= NOW() ORDER BY next_attempt_at ASC, reaction_id ASC LIMIT " . $limit);
        $q->execute();
        $rows = $q->fetchAll(PDO::FETCH_ASSOC);
        if (!$rows) return 0;

        $publishedIds = [];
        $failedIds = [];
        foreach ($rows as $row) {
            $id = (int)$row['reaction_id'];
            $payload = json_decode((string)$row['payload'], true);
            if (!is_array($payload)) {
                $failedIds[] = $id;
                continue;
            }
            // Cache is an accelerator only. Rebuild/update best-effort, then
            // publish directly without a second outbox SELECT for this row.
            try { ReactionBuffer::cachePersisted($payload); } catch (Throwable $e) { /* cache is best effort */ }
            if (Realtime::publishReaction((string)$row['room_code'], (string)$row['audience'], (int)$row['sender_user_id'], $row['recipient_user_id'] === null ? null : (int)$row['recipient_user_id'], $payload)) {
                $publishedIds[] = $id;
            } else {
                $failedIds[] = $id;
            }
        }

        if ($publishedIds) {
            $marks = implode(',', array_fill(0, count($publishedIds), '?'));
            $done = $pdo->prepare("UPDATE room_reaction_outbox SET published_at=NOW(), last_error=NULL WHERE published_at IS NULL AND reaction_id IN ($marks)");
            $done->execute($publishedIds);
        }
        if ($failedIds) {
            $marks = implode(',', array_fill(0, count($failedIds), '?'));
            // Batch backoff is bounded to 60 seconds. Each retry tick advances
            // attempts; all failed rows in this batch share the same retry time.
            $failure = $pdo->prepare("UPDATE room_reaction_outbox SET attempts=attempts+1, last_error='Realtime transport unavailable or invalid payload', next_attempt_at=DATE_ADD(NOW(), INTERVAL LEAST(60, POW(2, LEAST(attempts, 6))) SECOND) WHERE published_at IS NULL AND reaction_id IN ($marks)");
            $failure->execute($failedIds);
        }
        // Published events are no longer needed for delivery retries; history
        // remains in room_emoji_reactions. Cleanup is deliberately infrequent.
        try { $pdo->exec("DELETE FROM room_reaction_outbox WHERE published_at < (NOW() - INTERVAL 1 DAY) LIMIT 500"); } catch (Throwable $e) { /* cleanup is best effort */ }
        return count($publishedIds);
    }

    private static function recordOutboxFailure(PDO $pdo, int $id, string $message): void
    {
        $q = $pdo->prepare("UPDATE room_reaction_outbox SET attempts=attempts+1, last_error=?, next_attempt_at=DATE_ADD(NOW(), INTERVAL LEAST(60, POW(2, LEAST(attempts, 6))) SECOND) WHERE reaction_id=? AND published_at IS NULL");
        $q->execute([substr($message, 0, 500), $id]);
    }

    /** Wake the room's browsers (published when the HTTP response is produced). */
    public static function signal(string $roomCode, string $audience, int $senderId, ?int $recipientId, array $event = []): void
    {
        // Legacy callers may queue a transient event. Reaction API uses the
        // durable outbox publisher so a failed publish remains retryable.
        if ($audience === self::AUDIENCE_EVERYONE) {
            Realtime::room($roomCode, 'reaction', null, $event ?: null);
            return;
        }
        Realtime::room($roomCode, 'reaction', $recipientId, $event ?: null);
        Realtime::room($roomCode, 'reaction', $senderId, $event ?: null);
    }
}
