<?php
declare(strict_types=1);

require_once __DIR__ . '/RedisCache.php';
require_once __DIR__ . '/Realtime.php';

/**
 * Write-behind buffer for players' ticket marks.
 *
 * A tap used to cost ~7 MySQL queries. Now (when Redis and the worker are
 * up) it costs zero in steady state: the mark goes into a Redis "pending"
 * set and the worker writes ALL pending marks of ALL players to MySQL in
 * one multi-row INSERT IGNORE per second.
 *
 * Consistency rules (these are what keep it correct):
 *   - A mark is always visible via   MySQL rows  UNION  pending set.
 *     ticket.php and claim.php read exactly that union, so a mark counts
 *     immediately - before it is flushed - for display and for win claims.
 *   - Flushing is idempotent (INSERT IGNORE on a unique key) and a pending
 *     entry is only removed AFTER the rows were written, so a crash or DB
 *     error at any point can only cause a retry, never a lost mark.
 *   - If Redis is unavailable or the worker is not running, mark.php writes
 *     straight to MySQL like before (and drains that ticket's pending set).
 */
final class MarkBuffer
{
    // Pending (accepted but not yet in MySQL) marks and the dirty set NEVER
    // expire: they are removed only after their rows are committed to MySQL.
    // Only the disposable per-ticket read cache (mkc2) has a short TTL.
    private const CONFIRMED_CACHE_TTL = 2;
    // Redis sets cannot represent an empty value. This reserved member lets an
    // empty-but-warm mark cache be distinguished from a cache miss. Ticket
    // numbers are always 1..90, so this value cannot collide with a mark.
    private const EMPTY_CACHE_SENTINEL = '__housiy_empty__';

    private const LUA_MARK = <<<'LUA'
-- KEYS: 1=short-lived full mark cache, 2=pending marks, 3=dirty tickets,
--       4=dirty timestamps, 5=per-ticket mark generation,
--       6=authoritative cached called-number set, 7=trusted ticket-number set.
-- ARGV: 1=number, 2=ticket id.
-- Validate both facts and enqueue the mark in one atomic Redis execution.
if redis.call('SISMEMBER', KEYS[6], ARGV[1]) == 0 then return 0 end
if redis.call('SISMEMBER', KEYS[7], ARGV[1]) == 0 then return -1 end
local added = redis.call('SADD', KEYS[2], ARGV[1])
if added == 1 then
  redis.call('INCR', KEYS[5])
  redis.call('EXPIRE', KEYS[5], 21600)
end
redis.call('SADD', KEYS[3], ARGV[2])
local t = redis.call('TIME')
redis.call('ZADD', KEYS[4], 'NX', t[1], ARGV[2])

-- Keep an already-warm read cache in sync without making MySQL part of the
-- mark request. If absent, ticket.php hydrates it on its next read.
if redis.call('EXISTS', KEYS[1]) == 1 then
  -- Remove the empty-cache marker before adding a real number.
  redis.call('SREM', KEYS[1], '__housiy_empty__')
  -- Do not extend the cache TTL here. A direct-MySQL fallback may have
  -- happened during a Redis outage and could not invalidate an old cache.
  -- A fixed short lifetime bounds that stale window after Redis recovers.
  redis.call('SADD', KEYS[1], ARGV[1])
end
return 1
LUA;

    /**
     * Merge an authoritative MySQL snapshot into the short-lived Redis cache,
     * then include pending marks as observed atomically in Redis. This is
     * additive (never DEL+replace), so a concurrent mark cannot be overwritten
     * by an older SQL snapshot.
     */
    private const LUA_CACHE_MERGE = <<<'LUA'
-- Do not cache an SQL snapshot if a new mark arrived after the caller read
-- its pending set. The mark Lua script increments this generation atomically.
local current = tonumber(redis.call('GET', KEYS[3]) or '0')
local expected = tonumber(ARGV[1])
if current ~= expected then
  return -1
end
-- Remove a prior empty-cache marker before merging real marks.
redis.call('SREM', KEYS[1], '__housiy_empty__')
for i = 3, #ARGV do
  redis.call('SADD', KEYS[1], ARGV[i])
end
local pending = redis.call('SMEMBERS', KEYS[2])
for _, number in ipairs(pending) do
  redis.call('SADD', KEYS[1], number)
end
local count = redis.call('SCARD', KEYS[1])
if count == 0 then
  -- Keep the empty result cacheable; otherwise every poll by a player who
  -- has not marked a number would issue another SELECT against MySQL.
  redis.call('SADD', KEYS[1], '__housiy_empty__')
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return count
LUA;

    private const LUA_INVALIDATE = <<<'LUA'
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 21600)
redis.call('DEL', KEYS[1])
return 1
LUA;

    private const LUA_ACK = <<<'LUA'
for i = 2, #ARGV do
  redis.call('SREM', KEYS[1], ARGV[i])
end
if redis.call('SCARD', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[3], ARGV[1])
end
return 1
LUA;

    private static function pendKey(int $ticketId): string
    {
        return RedisCache::key('mkp:' . $ticketId);
    }

    private static function dirtyKey(): string
    {
        return RedisCache::key('mkdirty');
    }

    /** ZSET ticketId -> unix time it first became dirty (oldest-pending age). */
    private static function dirtyTsKey(): string
    {
        return RedisCache::key('mkdirtyts');
    }

    /** Per-ticket monotonic generation used to guard cache hydration races. */
    private static function versionKey(int $ticketId): string
    {
        return RedisCache::key('mkv:' . $ticketId);
    }

    public static function metricsKey(): string
    {
        return RedisCache::key('metrics:persist');
    }

    /** Persistence health numbers (all best-effort; never throws). */
    public static function metrics(): array
    {
        $r = RedisConn::conn();
        if (!$r) {
            return [];
        }
        try {
            $m = $r->hGetAll(self::metricsKey()) ?: [];
            $m['queue_depth'] = (int)$r->sCard(self::dirtyKey());
            $oldest = $r->zRange(self::dirtyTsKey(), 0, 0, true);
            $m['oldest_pending_age_s'] = $oldest ? max(0, time() - (int)array_values($oldest)[0]) : 0;
            return $m;
        } catch (Throwable $e) {
            RedisConn::reset();
            return [];
        }
    }

    private static function note(callable $fn): void
    {
        $r = RedisConn::conn();
        if (!$r) {
            return;
        }
        try {
            $fn($r, self::metricsKey());
        } catch (Throwable $e) {
            RedisConn::reset();
        }
    }

    /** @return int[] sorted ascending, unique */
    private static function norm(array $nums): array
    {
        $nums = array_values(array_unique(array_map('intval', $nums)));
        sort($nums);
        return $nums;
    }

    /** Current mark generation; read before pending() to guard cache hydration. */
    public static function version(int $ticketId): ?int
    {
        $r = RedisConn::conn();
        if (!$r) return null;
        try {
            $value = $r->get(self::versionKey($ticketId));
            return $value === false || $value === null ? 0 : (int)$value;
        } catch (Throwable $e) {
            RedisConn::reset();
            return null;
        }
    }

    /** Pending (not yet in MySQL) marks of one ticket. Empty if Redis is down. */
    public static function pending(int $ticketId): array
    {
        $r = RedisConn::conn();
        if (!$r) {
            return [];
        }
        try {
            $m = $r->sMembers(self::pendKey($ticketId));
            return is_array($m) ? array_map('intval', $m) : [];
        } catch (Throwable $e) {
            RedisConn::reset();
            return [];
        }
    }

    /**
     * MySQL rows UNION pending marks - the one true view of a ticket's marks.
     *
     * ORDER MATTERS: flush writes a mark to MySQL first and only then removes
     * it from the pending set. So callers must read pending BEFORE querying
     * MySQL: a mark is then always seen in one of the two (still pending, or
     * already committed). Reading MySQL first could miss a mark that moves
     * between the two reads.
     *
     * @param int[] $pendingBefore result of pending() taken before the SQL read
     */
    public static function union(array $dbMarked, array $pendingBefore): array
    {
        return $pendingBefore ? self::norm(array_merge($dbMarked, $pendingBefore)) : $dbMarked;
    }

    /**
     * Read the short-lived full mark-list cache used by ticket snapshots.
     * A miss falls back to MySQL UNION pending in ticket.php; an empty-but-cached
     * result is represented by the reserved sentinel and returned as [].
     *
     * @return int[]|null null means cache miss/unavailable; [] is a valid cache hit
     */
    public static function cached(int $ticketId): ?array
    {
        $r = RedisConn::conn();
        if (!$r) return null;
        try {
            $values = $r->sMembers(RedisCache::key('mkc2:' . $ticketId));
            if (!is_array($values) || !$values) return null;
            // An empty ticket-mark list is a valid cache hit, represented by
            // the reserved sentinel because Redis deletes empty sets.
            $values = array_values(array_filter(
                $values,
                static fn($value) => (string)$value !== self::EMPTY_CACHE_SENTINEL
            ));
            return self::norm($values);
        } catch (Throwable $e) {
            RedisConn::reset();
            return null;
        }
    }

    /**
     * Buffer one validated mark. Returns true when Redis accepted it, or null
     * when the caller must use the synchronous MySQL fallback. The normal
     * request path deliberately does not read MySQL or return a full mark list:
     * the browser already knows which number it tapped, and ticket.php reads
     * the authoritative MySQL UNION pending state when it needs reconciliation.
     */
    public static function buffer(int $ticketId, int $number, string $calledKey, string $ticketNumbersKey): ?bool
    {
        $r = RedisConn::conn();
        if (!$r || !Realtime::workerAlive()) {
            return null;
        }
        try {
            $accepted = $r->eval(
                self::LUA_MARK,
                [
                    RedisCache::key('mkc2:' . $ticketId),
                    self::pendKey($ticketId),
                    self::dirtyKey(),
                    self::dirtyTsKey(),
                    self::versionKey($ticketId),
                    $calledKey,
                    $ticketNumbersKey,
                    (string)$number,
                    (string)$ticketId,
                ],
                7
            );
            if ((int)$accepted === 0) return false; // not called
            if ((int)$accepted === -1) return false; // not on trusted ticket set
            return (int)$accepted === 1 ? true : null;
        } catch (Throwable $e) {
            RedisConn::reset();
            return null;
        }
    }

    /**
     * Warm the disposable full-mark cache from an SQL snapshot plus the
     * current pending Redis set. Called only on cache misses, never by mark.php.
     * The operation is additive to preserve concurrent marks.
     *
     * @param int[] $dbMarked
     */
    public static function cacheMerge(int $ticketId, array $dbMarked, int $expectedVersion): void
    {
        $r = RedisConn::conn();
        if (!$r) return;
        try {
            $args = [
                (string)$expectedVersion,
                (string)self::CONFIRMED_CACHE_TTL,
                ...array_map('strval', self::norm($dbMarked)),
            ];
            $r->eval(
                self::LUA_CACHE_MERGE,
                [
                    RedisCache::key('mkc2:' . $ticketId),
                    self::pendKey($ticketId),
                    self::versionKey($ticketId),
                    ...$args,
                ],
                3
            );
        } catch (Throwable $e) {
            RedisConn::reset();
        }
    }

    /**
     * A mark was committed straight to MySQL (fallback path), bypassing the
     * buffer. Drop this ticket's cached mark list so the next ticket snapshot
     * rebuilds it from MySQL instead of serving stale data.
     * Best-effort by design: mkc is a short-lived ticket-read optimization. If Redis
     * is unreachable during a direct-MySQL fallback, the short TTL bounds any
     * stale cache window; claim.php never trusts this cache.
     */
    public static function invalidate(int $ticketId): void
    {
        $r = RedisConn::conn();
        if (!$r) return;
        try {
            $r->eval(
                self::LUA_INVALIDATE,
                [RedisCache::key('mkc2:' . $ticketId), self::versionKey($ticketId)],
                2
            );
        } catch (Throwable $e) {
            RedisConn::reset();
        }
    }

    /** Write one ticket's pending marks straight to MySQL (worker-down path). */
    public static function flushTicket(PDO $pdo, int $ticketId): void
    {
        $pend = self::pending($ticketId);
        if (!$pend) {
            return;
        }
        $rows = [];
        foreach ($pend as $n) {
            $rows[] = [$ticketId, $n];
        }
        self::insertRows($pdo, $rows);
        self::ack($ticketId, $pend);
    }

    /**
     * Drain pending marks of every dirty ticket into MySQL with one
     * multi-row INSERT IGNORE per chunk. Returns the number of marks written.
     */
    public static function flush(PDO $pdo, int $maxTickets = 2000): int
    {
        $r = RedisConn::conn();
        if (!$r) {
            return 0;
        }
        try {
            $dirty = $r->sMembers(self::dirtyKey());
            if (!is_array($dirty) || !$dirty) {
                return 0;
            }
            $dirty = array_slice($dirty, 0, $maxTickets);
            $pipe = $r->multi(Redis::PIPELINE);
            foreach ($dirty as $tid) {
                $pipe->sMembers(self::pendKey((int)$tid));
            }
            $lists = $pipe->exec();
        } catch (Throwable $e) {
            RedisConn::reset();
            return 0;
        }

        $rows = [];
        $perTicket = [];
        foreach ($dirty as $i => $tid) {
            $nums = is_array($lists[$i] ?? null) ? array_map('intval', $lists[$i]) : [];
            $perTicket[(int)$tid] = $nums;
            foreach ($nums as $n) {
                $rows[] = [(int)$tid, $n];
            }
        }
        if ($rows) {
            $t0 = microtime(true);
            try {
                self::insertRows($pdo, $rows); // throws on DB error -> nothing is acked, retried next tick
            } catch (Throwable $e) {
                self::note(function ($r, $k) use ($e) {
                    $r->hIncrBy($k, 'failures_total', 1);
                    $r->hMSet($k, ['last_error' => substr($e->getMessage(), 0, 200), 'last_error_at' => (string)time()]);
                });
                throw $e;
            }
            $ms = (int)round((microtime(true) - $t0) * 1000);
            self::note(function ($r, $k) use ($rows, $ms) {
                $r->hIncrBy($k, 'marks_persisted_total', count($rows));
                $r->hIncrBy($k, 'batches_total', 1);
                $r->hMSet($k, ['last_batch_size' => (string)count($rows), 'last_batch_ms' => (string)$ms, 'last_success_at' => (string)time()]);
            });
        }
        foreach ($perTicket as $tid => $nums) {
            self::ack($tid, $nums);
        }
        return count($rows);
    }

    /** @param array<int,array{0:int,1:int}> $rows */
    private static function insertRows(PDO $pdo, array $rows): void
    {
        foreach (array_chunk($rows, 500) as $chunk) {
            $ph = implode(',', array_fill(0, count($chunk), '(?, ?)'));
            $flat = [];
            foreach ($chunk as [$tid, $n]) {
                $flat[] = $tid;
                $flat[] = $n;
            }
            $pdo->prepare('INSERT IGNORE INTO marked_numbers (ticket_id, number) VALUES ' . $ph)->execute($flat);
        }
    }

    private static function ack(int $ticketId, array $nums): void
    {
        $r = RedisConn::conn();
        if (!$r) {
            return;
        }
        try {
            $r->eval(
                self::LUA_ACK,
                [self::pendKey($ticketId), self::dirtyKey(), self::dirtyTsKey(), (string)$ticketId, ...array_map('strval', $nums)],
                3
            );
        } catch (Throwable $e) {
            RedisConn::reset(); // entries stay pending; next flush re-inserts harmlessly
        }
    }
}
