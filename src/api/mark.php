<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/GameEngine.php';
require_once __DIR__ . '/../includes/MarkBuffer.php';

/**
 * A player marks (dabs) one number on their own ticket. This only records
 * the player's own tap — it is never trusted for win validation on its own;
 * ClaimValidator re-checks the called_numbers ledger independently. But a
 * claim now also requires the number to have been marked here, so players
 * must actually select their numbers instead of having everything called
 * auto-marked for them.
 */
require_post();
$user = Auth::requireUser();
RateLimiter::enforce('mark', 'u:' . $user['id']);
$body = json_body();

$roomCode = strtoupper(trim((string)($body['room_code'] ?? '')));
$numberRaw = $body['number'] ?? null;

// Do not rely on PHP's loose integer cast: values such as "12abc" would
// otherwise be accepted as number 12.
if ($roomCode === '' || strlen($roomCode) > 32) {
    json_error('Invalid room code.');
}
if (!(is_int($numberRaw) || (is_string($numberRaw) && ctype_digit($numberRaw)))) {
    json_error('Invalid number.');
}
$number = (int)$numberRaw;
if ($number < 1 || $number > 90) {
    json_error('Invalid number.');
}

// MySQL is opened lazily: on the hot path every check below is answered
// from Redis, so a tap normally costs zero queries. Every cache miss, and
// every Redis failure, falls through to the original MySQL queries.
$pdo = null;
$db = function () use (&$pdo): PDO {
    return $pdo ??= DB::conn();
};

$roomCodeNorm = $roomCode;

// Room id (immutable once created).
$cacheSpan = EndpointProfiler::start('mark.room_id_cache');
$roomId = RedisCache::get('rc:' . $roomCodeNorm);
EndpointProfiler::stop($cacheSpan);
if ($roomId === null || (int)$roomId < 1) {
    $room = RoomAccess::findByCode($db(), $roomCodeNorm);
    $roomId = (string)(int)$room['id'];
    $roomCodeNorm = (string)$room['room_code'];
    RedisCache::set('rc:' . $roomCodeNorm, $roomId, 300);
}
$roomId = (int)$roomId;

// Game id (one game row per room).
$cacheSpan = EndpointProfiler::start('mark.game_id_cache');
$gameId = RedisCache::get('gid:' . $roomId);
EndpointProfiler::stop($cacheSpan);
if ($gameId === null || (int)$gameId < 1) {
    $game = GameEngine::getOrCreateGame($db(), $roomId);
    $gameId = (string)(int)$game['id'];
    RedisCache::set('gid:' . $roomId, $gameId, 300);
}
$gameId = (int)$gameId;

// Marking is permitted only while the room is active or paused. Once the
// room is completed/cancelled, reject marks for every participant (including
// the host) regardless of Redis cache state or a still-open winner popup.
$roomStatusStmt = EndpointProfiler::query(
    $db(),
    'mark.room_status_guard',
    'SELECT r.status AS room_status, g.status AS game_status,
            EXISTS(SELECT 1 FROM room_players rp WHERE rp.room_id = r.id AND rp.user_id = ? AND rp.is_active = 1) AS active_member
     FROM rooms r JOIN games g ON g.room_id = r.id WHERE r.id = ? AND g.id = ? LIMIT 1',
    [$user['id'], $roomId, $gameId]
);
$roomStatusRow = $roomStatusStmt->fetch();
$roomStatus = strtoupper((string)($roomStatusRow['room_status'] ?? ''));
$gameStatus = strtoupper((string)($roomStatusRow['game_status'] ?? ''));
if (empty($roomStatusRow['active_member'])) {
    json_error('You have been removed from this room. Please return to the home page.', 403);
}
if (!in_array($roomStatus, ['LIVE', 'PAUSED'], true) || !in_array($gameStatus, ['RUNNING', 'PAUSED'], true)) {
    json_error('Ticket marking is closed because this game has completed.', 409);
}

// Ticket (grid never changes after creation).
$cacheSpan = EndpointProfiler::start('mark.ticket_cache');
$ticketJson = RedisCache::get('tk:' . $roomId . ':' . $user['id']);
EndpointProfiler::stop($cacheSpan);
$ticket = $ticketJson !== null ? json_decode($ticketJson, true) : null;
if (!is_array($ticket) || (int)($ticket['id'] ?? 0) < 1
    || !isset($ticket['grid']) || !is_array($ticket['grid'])) {
    $ticketStmt = EndpointProfiler::query($db(), 'mark.ticket_lookup', 'SELECT id, ticket_grid FROM tickets WHERE room_id = ? AND user_id = ? LIMIT 1', [$roomId, $user['id']]);
    $row = $ticketStmt->fetch();
    if (!$row) {
        json_error('You do not have a ticket in this room.', 404);
    }
    $grid = json_decode((string)$row['ticket_grid'], true);
    if (!is_array($grid)) {
        error_log('[mark] invalid ticket_grid JSON for ticket ' . (int)$row['id']);
        json_error('Ticket data is temporarily unavailable.', 500);
    }
    $ticket = ['id' => (int)$row['id'], 'grid' => $grid];
    RedisCache::set('tk:' . $roomId . ':' . $user['id'], json_encode($ticket), 300);
}
$ticketId = (int)$ticket['id'];

$onTicket = false;
foreach ($ticket['grid'] as $row) {
    if (!is_array($row)) {
        continue;
    }
    // JSON ticket grids may be decoded with integer or numeric-string cells
    // depending on legacy data; compare their numeric values consistently.
    foreach ($row as $cell) {
        if (is_numeric($cell) && (int)$cell === $number) {
            $onTicket = true;
            break 2;
        }
    }
}
if (!$onTicket) {
    json_error('That number is not on your ticket.', 400);
}

// Warm a trusted Redis SET of the immutable ticket numbers. The values come
// only from the server-side ticket row/cache, never from the browser payload.
$ticketNumbersKey = RedisCache::key('ticket:' . $ticketId . ':numbers');
if ($redis = RedisConn::conn()) {
    try {
        $ticketNumbers = [];
        foreach ($ticket['grid'] as $ticketRow) {
            if (is_array($ticketRow)) foreach ($ticketRow as $cell) if (is_numeric($cell) && (int)$cell > 0) $ticketNumbers[] = (string)(int)$cell;
        }
        if ($ticketNumbers) {
            $redis->sAdd($ticketNumbersKey, ...array_values(array_unique($ticketNumbers)));
            // Ticket numbers are immutable. Keep this trusted validation set while
            // the game is active; it can be removed by terminal-room cleanup.
            $redis->persist($ticketNumbersKey);
        }
    } catch (Throwable $e) {
        RedisConn::reset();
        $redis = null;
    }
}

// Has the number been called? A cached "yes" is always safe (called numbers
// are never removed). A cached "no" is never trusted: it is re-checked in
// MySQL, and a confirmed "yes" is added to the cache for everyone else.
$calledLookupSpan = EndpointProfiler::start('mark.called_number_redis_lookup');
$redis = RedisConn::conn();
$calledKey = RedisCache::key('called:' . $gameId);
$isCalled = false;
if ($redis) {
    try {
        $isCalled = (bool)$redis->sIsMember($calledKey, (string)$number);
    } catch (Throwable $e) {
        RedisConn::reset();
        $redis = null;
    }
}
EndpointProfiler::stop($calledLookupSpan);
if (!$isCalled) {
    $calledCheck = EndpointProfiler::query($db(), 'mark.called_number_check', 'SELECT 1 FROM called_numbers WHERE game_id = ? AND number = ? LIMIT 1', [$gameId, $number]);
    if (!$calledCheck->fetch()) {
        json_error('That number has not been called yet.', 400);
    }
    if ($redis) {
        try {
            $redis->sAdd($calledKey, (string)$number);
            $redis->expire($calledKey, 21600);
        } catch (Throwable $e) {
            RedisConn::reset();
        }
    }
}

// Fast path: buffer the mark in Redis; the worker batch-writes it to MySQL.
// The response is intentionally tiny: the browser already applied the tapped
// number optimistically, so returning the full ticket mark list would only add
// serialization/network work and (historically) forced a MySQL SELECT per tap.
$bufferSpan = EndpointProfiler::start('mark.redis_buffer');
$buffered = MarkBuffer::buffer($ticketId, $number, $calledKey, $ticketNumbersKey);
EndpointProfiler::stop($bufferSpan);

// A completed game may have had its disposable Redis called-number set
// cleaned up. The SQL validation above has already established that this
// number was called, and the immutable ticket grid was checked above too.
// Do not let missing terminal-game Redis state prevent players from finishing
// their manual ticket marks after the winners popup is dismissed.
if ($buffered === false) {
    $calledCheck = EndpointProfiler::query(
        $db(),
        'mark.called_number_terminal_fallback',
        'SELECT 1 FROM called_numbers WHERE game_id = ? AND number = ? LIMIT 1',
        [$gameId, $number]
    );
    if (!$calledCheck->fetch()) {
        json_error('That number has not been called yet.', 400);
    }
    EndpointProfiler::query(
        $db(),
        'mark.mysql_terminal_fallback_insert',
        'INSERT IGNORE INTO marked_numbers (ticket_id, number) VALUES (?, ?)',
        [$ticketId, $number]
    );
    MarkBuffer::invalidate($ticketId);
    $buffered = true;
}

if ($buffered === null) {
    // Synchronous durability fallback when Redis or the persistence worker is
    // unavailable. INSERT IGNORE makes retries safe; flush older pending marks
    // before returning so the fallback path does not strand this ticket's queue.
    EndpointProfiler::query($db(), 'mark.mysql_fallback_insert', 'INSERT IGNORE INTO marked_numbers (ticket_id, number) VALUES (?, ?)', [$ticketId, $number]);
    MarkBuffer::invalidate($ticketId);
    MarkBuffer::flushTicket($db(), $ticketId);
}

// Only this player's own ticket changed - wake just their other tabs.
Realtime::room($roomCodeNorm, 'ticket_marked', (int)$user['id'], ['number' => $number, 'ticket_id' => $ticketId]);
Realtime::room($roomCodeNorm, 'ticket_updated', (int)$user['id'], ['ticket_id' => $ticketId]);

json_ok(['number' => $number, 'status' => 'accepted']);
