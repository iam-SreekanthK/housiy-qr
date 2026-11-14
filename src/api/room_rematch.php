<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/GameEngine.php';
require_once __DIR__ . '/../includes/FullHouse.php';
require_once __DIR__ . '/../includes/TicketGenerator.php';

/**
 * Host-only: after a game ends, spin up a brand new room (same title, max
 * players, and prize set) as a "rematch". Existing players are NOT
 * auto-added — each one sees a "host started a new game, join?" prompt in
 * their own client and only joins if they explicitly opt in.
 */
require_post();
$user = Auth::requireUser();
RateLimiter::enforce('room_create_user', (string)$user['email']);
$body = json_body();
$roomCode = (string)($body['room_code'] ?? '');

$pdo = DB::conn();
$room = RoomAccess::findByCode($pdo, $roomCode);
RoomAccess::requireHost($room, $user);

if (!in_array($room['status'], ['COMPLETED', 'CANCELLED'], true)) {
    json_error('You can only start a rematch after the game has ended.', 409);
}

// If a rematch was already created for this room, just hand back that code
// instead of spawning duplicates on repeated clicks/reloads.
if (!empty($room['rematch_room_code'])) {
    json_ok(['room_code' => $room['rematch_room_code'], 'reused' => true]);
}

// Auto-call for the new room: use whatever the host chose in the rematch
// prompt if they submitted a choice, otherwise fall back to this room's
// own auto-call setting (so a rematch triggered without the prompt — e.g.
// an older client — still behaves sensibly instead of silently turning
// auto-call off).
$autoCallEnabled = array_key_exists('auto_call_enabled', $body)
    ? !empty($body['auto_call_enabled'])
    : !empty($room['auto_call_enabled']);
$autoCallInterval = (int)($body['auto_call_interval_seconds'] ?? $room['auto_call_interval_seconds'] ?? 5);
if ($autoCallInterval < 3 || $autoCallInterval > 60) {
    $autoCallInterval = 5;
}

$roomCodeNew = null;
for ($i = 0; $i < 10; $i++) {
    $candidate = generate_room_code();
    $chk = $pdo->prepare('SELECT id FROM rooms WHERE room_code = ?');
    $chk->execute([$candidate]);
    if (!$chk->fetch()) {
        $roomCodeNew = $candidate;
        break;
    }
}
if (!$roomCodeNew) {
    json_error('Could not allocate a room code, please try again.', 500);
}

$roomUuid = bin2hex(random_bytes(16));

// The rematch keeps the same Full House winner count as the original room.
$fullHouseWinners = FullHouse::configured($room);

$pdo->beginTransaction();
try {
    $ins = $pdo->prepare(
        'INSERT INTO rooms (room_code, room_uuid, host_user_id, title, max_players, status, prizes_enabled, full_house_winners, parent_room_id, auto_call_enabled, auto_call_interval_seconds)
         VALUES (?, ?, ?, ?, ?, "LOBBY", ?, ?, ?, ?, ?)'
    );
    $ins->execute([
        $roomCodeNew,
        $roomUuid,
        $room['host_user_id'],
        $room['title'],
        $room['max_players'],
        $room['prizes_enabled'],
        $fullHouseWinners,
        $room['id'],
        $autoCallEnabled ? 1 : 0,
        $autoCallEnabled ? $autoCallInterval : null,
    ]);
    $newRoomId = (int)$pdo->lastInsertId();
    $pdo->prepare('UPDATE users SET ever_hosted = 1 WHERE id = ?')->execute([(int)$user['id']]);

    GameEngine::getOrCreateGame($pdo, $newRoomId);

    // A rematch is a fresh room, but the host is still automatically enrolled
    // as a player (same behavior as room_create.php). Create the host ticket
    // in this transaction so the first host ticket.php read cannot race a
    // later self-join request and return a transient 404.
    $hostPlayer = $pdo->prepare('INSERT INTO room_players (room_id, user_id) VALUES (?, ?)');
    $hostPlayer->execute([$newRoomId, (int)$user['id']]);
    $hostGrid = TicketGenerator::generate();
    $hostTicket = $pdo->prepare('INSERT INTO tickets (room_id, user_id, ticket_grid) VALUES (?, ?, ?)');
    $hostTicket->execute([$newRoomId, (int)$user['id'], json_encode($hostGrid, JSON_THROW_ON_ERROR)]);

    $upd = $pdo->prepare('UPDATE rooms SET rematch_room_code = ? WHERE id = ?');
    $upd->execute([$roomCodeNew, $room['id']]);

    GameEngine::log($pdo, $newRoomId, null, 'HOST', (int)$user['id'], 'ROOM_CREATED', [
        'title' => $room['title'],
        'rematch_of_room_id' => (int)$room['id'],
    ]);
    GameEngine::log($pdo, (int)$room['id'], null, 'HOST', (int)$user['id'], 'REMATCH_STARTED', [
        'new_room_code' => $roomCodeNew,
    ]);

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }
    error_log('[room_rematch] ' . $e->getMessage());
    json_error('Failed to start rematch.', 500);
}

Realtime::room((string)$room['room_code'], 'rematch_created');

json_ok(['room_code' => $roomCodeNew, 'reused' => false]);
