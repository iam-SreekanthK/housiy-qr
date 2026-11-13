<?php
declare(strict_types=1);

require_once __DIR__ . '/RoomAccess.php';
require_once __DIR__ . '/GameEngine.php';
require_once __DIR__ . '/RedisCache.php';
require_once __DIR__ . '/Realtime.php';
require_once __DIR__ . '/EndpointProfiler.php';

/**
 * Room-wide read model shared by ticket.php and results.php.
 *
 * Everything in here is identical for every member of a room and only
 * changes on a state change, so it is computed once per change instead of
 * once per player per refresh. The cache key embeds a per-room version that
 * every state change bumps (Realtime::flush, before the writer's response
 * is sent), so a reader can never be served state older than a change it
 * could already observe. The 30s TTL is only a safety net for edits made
 * outside the application.
 *
 * Without Redis (or on any Redis error) this simply runs the original
 * MySQL queries.
 */
final class RoomState
{
    private const TTL = 30;

    /**
     * @param callable():PDO $db lazily opens MySQL (not needed on a cache hit)
     * @return array{room:array,game:array,called:int[],player_count:int,players:array,winners:array}
     */
    public static function load(callable $db, string $roomCode): array
    {
        $code = strtoupper(trim($roomCode));
        $cacheStart = microtime(true);
        $redis = RedisConn::conn();
        $key = null;
        if ($redis) {
            try {
                $ver = (int)$redis->get(Realtime::versionKey($code));
                $key = RedisCache::key('rs3:' . $code . ':' . $ver);
                $hit = $redis->get($key);
                if (is_string($hit)) {
                    $state = json_decode($hit, true);
                    if (is_array($state) && isset($state['room'], $state['game'])) {
                        EndpointProfiler::record('room_state.cache_hit', (microtime(true) - $cacheStart) * 1000.0);
                        EndpointProfiler::record('room_state.cache_hit_count', 0.0);
                        return $state;
                    }
                }
            } catch (Throwable $e) {
                RedisConn::reset();
                $key = null;
            }
        }

        EndpointProfiler::record('room_state.cache_miss', (microtime(true) - $cacheStart) * 1000.0);
        $pdo = $db();
        $q = EndpointProfiler::start('room_state.room_lookup');
        $room = RoomAccess::findByCode($pdo, $code); // 404 if missing
        EndpointProfiler::stop($q);
        $q = EndpointProfiler::start('room_state.game_lookup');
        $game = GameEngine::getOrCreateGame($pdo, (int)$room['id']);
        EndpointProfiler::stop($q);

        // Include the most recent call timestamp in the shared read model so
        // countdown rendering never needs a separate query on every poll.
        $calledStmt = EndpointProfiler::query($pdo, 'called_numbers', 'SELECT number, called_at FROM called_numbers WHERE game_id = ? ORDER BY sequence_no ASC', [$game['id']]);
        $calledRows = $calledStmt->fetchAll();
        $called = array_map(static fn($r) => (int)$r['number'], $calledRows);
        $lastCalledAt = $calledRows ? (string)$calledRows[count($calledRows) - 1]['called_at'] : null;

        $playersStmt = EndpointProfiler::query($pdo, 'room_players',
            'SELECT u.id, u.name, u.email
             FROM room_players rp
             JOIN users u ON u.id = rp.user_id
             WHERE rp.room_id = ? AND rp.is_active = 1
             ORDER BY rp.joined_at ASC', [$room['id']]);
        $players = array_map(function ($p) use ($room) {
            return [
                'id' => (int)$p['id'],
                'name' => $p['name'],
                'email' => $p['email'],
                'is_host' => (int)$p['id'] === (int)$room['host_user_id'],
            ];
        }, $playersStmt->fetchAll());

        $winnersStmt = EndpointProfiler::query($pdo, 'room_winners',
            'SELECT rpw.prize_type, wc.user_id AS winner_user_id, u.name AS winner_name, u.email AS winner_email, wc.claimed_at
             FROM room_prize_winners rpw
             JOIN winner_claims wc ON wc.id = rpw.winner_claim_id
             JOIN users u ON u.id = wc.user_id
             WHERE rpw.room_id = ?
             ORDER BY rpw.awarded_at ASC', [$room['id']]);

        $state = [
            'room' => $room,
            'game' => $game,
            'called' => $called,
            'last_called_at' => $lastCalledAt,
            // We already fetched all active player rows for the shared payload;
            // deriving the count avoids a redundant COUNT(*) on cache misses.
            'player_count' => count($players),
            'players' => $players,
            'winners' => $winnersStmt->fetchAll(),
        ];
        if ($redis && $key) {
            $serializeSpan = EndpointProfiler::start('room_state.serialize_cache_write');
            $encodedState = json_encode($state);
            RedisCache::setRaw($key, $encodedState, self::TTL);
            EndpointProfiler::stop($serializeSpan);
        }
        return $state;
    }

    /** Same rule as RoomAccess::requireMember; the (immutable) membership fact is cached. */
    public static function requireMember(callable $db, array $room, array $user): void
    {
        if ((int)$room['host_user_id'] === (int)$user['id']) {
            return;
        }
        $k = 'mem:' . (int)$room['id'] . ':' . (int)$user['id'];
        if (RedisCache::get($k) === '1') {
            return;
        }
        RoomAccess::requireMember($db(), $room, $user); // 403 if not a member
        RedisCache::set($k, '1', 300);
    }

    /**
     * The player's ticket in a room: {id, grid}. Tickets never change after
     * creation, so this is cached; returns null when the user has none.
     */
    public static function ticket(callable $db, int $roomId, int $userId): ?array
    {
        $k = 'tk:' . $roomId . ':' . $userId;
        $hit = RedisCache::get($k);
        $t = $hit !== null ? json_decode($hit, true) : null;
        if (is_array($t) && isset($t['id'], $t['grid'])) {
            EndpointProfiler::record('ticket.cache_hit', 0.0);
            return $t;
        }
        EndpointProfiler::record('ticket.cache_miss', 0.0);
        $stmt = EndpointProfiler::query($db(), 'ticket_lookup', 'SELECT id, ticket_grid FROM tickets WHERE room_id = ? AND user_id = ? LIMIT 1', [$roomId, $userId]);
        $row = $stmt->fetch();
        if (!$row) {
            return null;
        }
        $t = ['id' => (int)$row['id'], 'grid' => json_decode($row['ticket_grid'], true)];
        RedisCache::set($k, json_encode($t), 300);
        return $t;
    }
}
