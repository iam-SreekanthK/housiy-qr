<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/GameEngine.php';
require_once __DIR__ . '/../includes/MarkBuffer.php';
require_once __DIR__ . '/../includes/RoomState.php';
require_once __DIR__ . '/../includes/FullHouse.php';

$user = Auth::requireUser();
RateLimiter::enforce('state_read', 'u:' . $user['id']);
$roomCode = strtoupper(trim((string)($_GET['room_code'] ?? '')));
if ($roomCode === '' || strlen($roomCode) > 32) {
    json_error('Invalid room code.');
}

$pdo = null;
$db = function () use (&$pdo): PDO {
    return $pdo ??= DB::conn();
};

// Room-wide data (room, game, called numbers, player count, winners) comes
// from the shared version-keyed read model: computed once per state change
// for the whole room instead of once per player per refresh.
$state = RoomState::load($db, $roomCode);
if (!isset($state['room'], $state['game']) || !is_array($state['room']) || !is_array($state['game'])) {
    error_log('[ticket] invalid room-state read model for room ' . $roomCode);
    json_error('Room state is temporarily unavailable.', 503);
}
$room = $state['room'];
$game = $state['game'];
RoomState::requireMember($db, $room, $user);

$ticket = RoomState::ticket($db, (int)$room['id'], (int)$user['id']);
if (!$ticket) {
    json_error('You have not joined this room.', 404);
}
if ((int)($ticket['id'] ?? 0) < 1 || !isset($ticket['grid']) || !is_array($ticket['grid'])) {
    error_log('[ticket] invalid ticket read model for room ' . $roomCode . ' user ' . (int)$user['id']);
    json_error('Ticket data is temporarily unavailable.', 503);
}

$autoCallSecondsRemaining = GameEngine::autoCallSecondsRemaining($room, $game, $state['last_called_at'] ?? null, $state['winners'] ?? []);
$prizesEnabled = json_decode((string)($room['prizes_enabled'] ?? '[]'), true);
$prizesEnabled = is_array($prizesEnabled) ? $prizesEnabled : [];
$fullHouseProgress = FullHouse::progress($room, $state['winners'] ?? [], (int)($state['player_count'] ?? 0));
// A prize counts as "won" (button closed for everyone) once all its winner
// slots are filled. Full House stays open for others until its last slot.
$won = array_values(array_unique(array_column($state['winners'], 'prize_type')));
if (in_array('FULL_HOUSE', $won, true) && $fullHouseProgress['remaining'] > 0) {
    $won = array_values(array_diff($won, ['FULL_HOUSE']));
}
// Winner ownership is already part of the versioned RoomState read model.
// A successful claim bumps that room version after commit, so this remains
// immediately consistent while avoiding one MySQL query per ticket refresh.
$wonByMe = [];
foreach ($state['winners'] as $winner) {
    if ((int)($winner['winner_user_id'] ?? 0) === (int)$user['id']) {
        $wonByMe[] = (string)$winner['prize_type'];
    }
}
$wonByMe = array_values(array_unique($wonByMe));

// Read Redis-pending marks BEFORE the SQL read (see MarkBuffer::union).
$markCacheStart = EndpointProfiler::start('ticket.mark_cache_read');
$markedNumbers = MarkBuffer::cached((int)$ticket['id']);
EndpointProfiler::stop($markCacheStart);
if ($markedNumbers === null) {
    // Cache miss: read authoritative MySQL rows and include accepted marks
    // still pending in Redis, then warm the short-lived cache additively.
    $markStart = EndpointProfiler::start('ticket.pending_marks');
    // Read the generation BEFORE pending marks. If a new mark arrives after
    // this point, cacheMerge refuses to cache this potentially stale SQL view.
    $markVersion = MarkBuffer::version((int)$ticket['id']);
    $pendingMarks = MarkBuffer::pending((int)$ticket['id']);
    EndpointProfiler::stop($markStart);
    $markedStmt = EndpointProfiler::query($db(), 'ticket_marked_numbers', 'SELECT number FROM marked_numbers WHERE ticket_id = ?', [$ticket['id']]);
    $markedNumbers = array_map('intval', $markedStmt->fetchAll(PDO::FETCH_COLUMN));
    $markedNumbers = MarkBuffer::union($markedNumbers, $pendingMarks);
    // Warm the short-lived cache additively. The Redis script also unions the
    // latest pending set atomically, so a mark arriving during this SQL read
    // cannot be lost from the cached view.
    if ($markVersion !== null) {
        MarkBuffer::cacheMerge((int)$ticket['id'], $markedNumbers, $markVersion);
    }
    EndpointProfiler::record('ticket.mark_cache_miss', 0.0);
} else {
    EndpointProfiler::record('ticket.mark_cache_hit', 0.0);
}

json_ok([
    'room' => [
        'room_code' => $room['room_code'],
        'title' => $room['title'],
        'status' => $room['status'],
        'prizes_enabled' => $prizesEnabled,
        'full_house_winners' => FullHouse::configured($room),
        'full_house_total' => $fullHouseProgress['total'],
        'full_house_remaining' => $fullHouseProgress['remaining'],
        'player_count' => $state['player_count'],
        'max_players' => (int)$room['max_players'],
        'auto_call_enabled' => (bool)($room['auto_call_enabled'] ?? false),
        'auto_call_interval_seconds' => $room['auto_call_interval_seconds'] !== null ? (int)$room['auto_call_interval_seconds'] : null,
        'auto_call_seconds_remaining' => $autoCallSecondsRemaining,
    ],
    'game' => [
        'status' => $game['status'],
        'current_number' => $game['current_number'] !== null ? (int)$game['current_number'] : null,
        'numbers_called_count' => (int)$game['numbers_called_count'],
        'started_at' => $game['started_at'],
        'ended_at' => $game['ended_at'],
        'server_now' => date('Y-m-d H:i:s'),
    ],
    'ticket' => [
        'id' => $ticket['id'],
        'grid' => $ticket['grid'],
    ],
    'called_numbers' => $state['called'],
    'marked_numbers' => $markedNumbers,
    'prizes_won' => $won,
    'prizes_won_by_me' => $wonByMe,
]);
