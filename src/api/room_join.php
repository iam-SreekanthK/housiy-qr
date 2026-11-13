<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../includes/RedisCache.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/TicketGenerator.php';
require_once __DIR__ . '/../includes/GameEngine.php';

require_post();
$body = json_body();

$name     = (string)($body['name'] ?? '');
$email    = (string)($body['email'] ?? '');
$roomCode = strtoupper(trim((string)($body['room_code'] ?? '')));

if ($roomCode === '') {
    json_error('Room ID is required.');
}

try {
    $user = Auth::identify($name, $email, Auth::OP_JOIN);
} catch (InvalidArgumentException $e) {
    json_error($e->getMessage());
}

$pdo = DB::conn();

$roomStmt = $pdo->prepare('SELECT * FROM rooms WHERE room_code = ? LIMIT 1');
$roomStmt->execute([$roomCode]);
$room = $roomStmt->fetch();

if (!$room) {
    json_error('Room not found. Please check the Room ID.', 404);
}
if ($room['status'] !== 'LOBBY') {
    // Allow rejoin (reconnect) if already a player in this room, even
    // after the game has started; otherwise block new joins.
    $existingStmt = $pdo->prepare('SELECT id FROM room_players WHERE room_id = ? AND user_id = ?');
    $existingStmt->execute([$room['id'], $user['id']]);
    if (!$existingStmt->fetch()) {
        json_error('This game has already started or ended. New joins are closed.', 409);
    }
}

$pdo->beginTransaction();
try {
    // Serialize joins against game start by locking the room row first.
    $lockRoomStmt = $pdo->prepare('SELECT * FROM rooms WHERE id = ? FOR UPDATE');
    $lockRoomStmt->execute([(int)$room['id']]);
    $lockedRoom = $lockRoomStmt->fetch();

    if (!$lockedRoom) {
        $pdo->rollBack();
        json_error('Room not found. Please check the Room ID.', 404);
    }

    // Re-check room status while holding the lock so a join cannot slip in
    // after the host has started the game.
    $existingStmt = $pdo->prepare('SELECT id FROM room_players WHERE room_id = ? AND user_id = ?');
    $existingStmt->execute([(int)$lockedRoom['id'], (int)$user['id']]);
    $alreadyJoined = (bool)$existingStmt->fetch();

    if ($lockedRoom['status'] !== 'LOBBY' && !$alreadyJoined) {
        $pdo->rollBack();
        json_error('This game has already started or ended. New joins are closed.', 409);
    }

    if (!$alreadyJoined) {
        $countStmt = $pdo->prepare('SELECT COUNT(*) FROM room_players WHERE room_id = ? AND is_active = 1');
        $countStmt->execute([(int)$lockedRoom['id']]);
        $current = (int)$countStmt->fetchColumn();

        if ($current >= (int)$lockedRoom['max_players']) {
            $pdo->rollBack();
            json_error('This room is full.', 409);
        }

        $ins = $pdo->prepare('INSERT INTO room_players (room_id, user_id) VALUES (?, ?)');
        $ins->execute([(int)$lockedRoom['id'], (int)$user['id']]);
    }

    // Ensure a ticket exists for this player in this room.
    $ticketStmt = $pdo->prepare('SELECT * FROM tickets WHERE room_id = ? AND user_id = ?');
    $ticketStmt->execute([(int)$lockedRoom['id'], (int)$user['id']]);
    $ticket = $ticketStmt->fetch();

    if (!$ticket) {
        $grid = TicketGenerator::generate();
        $ticketJson = json_encode($grid);
        if ($ticketJson === false) {
            throw new RuntimeException('Failed to encode ticket grid.');
        }
        $tIns = $pdo->prepare('INSERT INTO tickets (room_id, user_id, ticket_grid) VALUES (?, ?, ?)');
        $tIns->execute([(int)$lockedRoom['id'], (int)$user['id'], $ticketJson]);
        $ticket = ['id' => (int)$pdo->lastInsertId(), 'ticket_grid' => $ticketJson];
    }

    GameEngine::log($pdo, (int)$lockedRoom['id'], null, 'PLAYER', (int)$user['id'], 'PLAYER_JOINED');
    $pdo->commit();
    // Use the fresh locked room snapshot for the response and realtime event.
    $room = $lockedRoom;
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log('[room_join] ' . $e->getMessage());
    json_error('Failed to join room.', 500);
}

RedisCache::del('rx:pl:' . (int)$room['id']); // the reactions player picker must list the newcomer
Realtime::room((string)$room['room_code'], 'player_joined', null, ['user_id' => (int)$user['id'], 'player_name' => (string)$user['name']]);

json_ok([
    'room' => [
        'id' => $room['id'],
        'room_code' => $room['room_code'],
        'title' => $room['title'],
        'status' => $room['status'],
        'prizes_enabled' => json_decode($room['prizes_enabled'], true),
    ],
    'ticket' => [
        'id' => $ticket['id'],
        'grid' => json_decode($ticket['ticket_grid'], true),
    ],
    'user' => ['id' => $user['id'], 'name' => $user['name'], 'email' => $user['email']],
]);
