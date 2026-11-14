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
    $existingStmt = $pdo->prepare('SELECT id, is_active FROM room_players WHERE room_id = ? AND user_id = ?');
    $existingStmt->execute([$room['id'], $user['id']]);
    if (!$existingStmt->fetch() && (int)$room['host_user_id'] !== (int)$user['id']) {
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
    $existingStmt = $pdo->prepare('SELECT id, is_active FROM room_players WHERE room_id = ? AND user_id = ?');
    $existingStmt->execute([(int)$lockedRoom['id'], (int)$user['id']]);
    $existingMembership = $existingStmt->fetch(PDO::FETCH_ASSOC);
    $alreadyJoined = (bool)$existingMembership;
    // A room owner entering through the public Join Room form is still the
    // host. Never downgrade the owner to a player just because they used the
    // room-code entry point. Admin blocks are enforced earlier by Auth::identify.
    $isHost = (int)$lockedRoom['host_user_id'] === (int)$user['id'];

    if ($lockedRoom['status'] !== 'LOBBY' && !$alreadyJoined && !$isHost) {
        $pdo->rollBack();
        json_error('This game has already started or ended. New joins are closed.', 409);
    }

    if (!$alreadyJoined && !$isHost) {
        $countStmt = $pdo->prepare('SELECT COUNT(*) FROM room_players WHERE room_id = ? AND is_active = 1');
        $countStmt->execute([(int)$lockedRoom['id']]);
        $current = (int)$countStmt->fetchColumn();

        if ($current >= (int)$lockedRoom['max_players']) {
            $pdo->rollBack();
            json_error('This room is full.', 409);
        }

        $ins = $pdo->prepare('INSERT INTO room_players (room_id, user_id) VALUES (?, ?)');
        $ins->execute([(int)$lockedRoom['id'], (int)$user['id']]);
    } elseif ($isHost && !$alreadyJoined) {
        // Defensive repair for older rooms whose host membership/ticket was
        // missing. Host access does not consume a second player slot.
        $pdo->prepare('INSERT INTO room_players (room_id, user_id, is_active) VALUES (?, ?, 1)')
            ->execute([(int)$lockedRoom['id'], (int)$user['id']]);
    } elseif ($alreadyJoined && (int)($existingMembership['is_active'] ?? 0) !== 1) {
        // A previously blocked/deactivated participant keeps the same ticket
        // and game history. Reactivate that membership without inserting a
        // duplicate row, including when the room is already LIVE/COMPLETED.
        $pdo->prepare('UPDATE room_players SET is_active = 1 WHERE id = ? AND room_id = ? AND user_id = ?')
            ->execute([(int)$existingMembership['id'], (int)$lockedRoom['id'], (int)$user['id']]);
    }

    // Keep lifetime role history independent of room membership lifecycle.
    $roleHistory = $pdo->prepare($isHost
        ? 'UPDATE users SET ever_hosted = 1 WHERE id = ?'
        : 'UPDATE users SET ever_played = 1 WHERE id = ?');
    $roleHistory->execute([(int)$user['id']]);

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

    GameEngine::log(
        $pdo,
        (int)$lockedRoom['id'],
        null,
        $isHost ? 'HOST' : 'PLAYER',
        (int)$user['id'],
        $isHost ? 'HOST_REJOINED' : 'PLAYER_JOINED'
    );
    $pdo->commit();
    // Use the fresh locked room snapshot for the response and realtime event.
    $room = $lockedRoom;
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log('[room_join] ' . $e->getMessage());
    json_error('Failed to join room.', 500);
}

RedisCache::del('rx:pl:' . (int)$room['id']);
RedisCache::del('mem:' . (int)$room['id'] . ':' . (int)$user['id']); // the reactions player picker must list the newcomer
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
    'role' => $isHost ? 'HOST' : 'PLAYER',
    'is_host' => $isHost,
]);
