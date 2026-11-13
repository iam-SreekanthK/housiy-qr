<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/GameEngine.php';
require_once __DIR__ . '/../includes/TicketGenerator.php';

require_post();
$body = json_body();

$name  = (string)($body['name'] ?? '');
$email = (string)($body['email'] ?? '');
$title = trim((string)($body['title'] ?? 'Housiy Room'));
$maxPlayers = (int)($body['max_players'] ?? MAX_PLAYERS_DEFAULT);
$prizes = $body['prizes'] ?? PRIZE_TYPES;
$autoCallEnabled = !empty($body['auto_call_enabled']);
$autoCallInterval = (int)($body['auto_call_interval_seconds'] ?? 5);

if (!is_array($prizes) || empty($prizes)) {
    $prizes = PRIZE_TYPES;
}
$prizes = array_values(array_intersect($prizes, PRIZE_TYPES));
if (empty($prizes)) {
    json_error('At least one prize must be enabled.');
}
if ($maxPlayers < 1 || $maxPlayers > 100) {
    $maxPlayers = MAX_PLAYERS_DEFAULT;
}
if (mb_strlen($title) === 0 || mb_strlen($title) > 150) {
    $title = 'Housiy Room';
}
if ($autoCallInterval < 3 || $autoCallInterval > 60) {
    $autoCallInterval = 5;
}

try {
    $user = Auth::identify($name, $email, Auth::OP_CREATE);
} catch (InvalidArgumentException $e) {
    json_error($e->getMessage());
}

$pdo = DB::conn();

// Generate a unique room code (retry on rare collision).
$roomCode = null;
for ($i = 0; $i < 10; $i++) {
    $candidate = generate_room_code();
    $chk = $pdo->prepare('SELECT id FROM rooms WHERE room_code = ?');
    $chk->execute([$candidate]);
    if (!$chk->fetch()) {
        $roomCode = $candidate;
        break;
    }
}
if (!$roomCode) {
    json_error('Could not allocate a room code, please try again.', 500);
}

$roomUuid = bin2hex(random_bytes(16));

$pdo->beginTransaction();
try {
    $ins = $pdo->prepare(
        'INSERT INTO rooms (room_code, room_uuid, host_user_id, title, max_players, status, prizes_enabled, auto_call_enabled, auto_call_interval_seconds)
         VALUES (?, ?, ?, ?, ?, "LOBBY", ?, ?, ?)'
    );
    $ins->execute([
        $roomCode, $roomUuid, $user['id'], $title, $maxPlayers, json_encode(array_values($prizes)),
        $autoCallEnabled ? 1 : 0, $autoCallEnabled ? $autoCallInterval : null,
    ]);
    $roomId = (int)$pdo->lastInsertId();

    GameEngine::getOrCreateGame($pdo, $roomId);

    // Automatically enroll the host as a player with their own ticket -
    // hosting and playing along are almost always both wanted, so this
    // should not require a separate manual "join my own room" step.
    $rpIns = $pdo->prepare('INSERT INTO room_players (room_id, user_id) VALUES (?, ?)');
    $rpIns->execute([$roomId, $user['id']]);

    $grid = TicketGenerator::generate();
    $tIns = $pdo->prepare('INSERT INTO tickets (room_id, user_id, ticket_grid) VALUES (?, ?, ?)');
    $tIns->execute([$roomId, $user['id'], json_encode($grid)]);

    GameEngine::log($pdo, $roomId, null, 'HOST', (int)$user['id'], 'ROOM_CREATED', ['title' => $title]);

    $pdo->commit();
} catch (Throwable $e) {
    $pdo->rollBack();
    error_log('[room_create] ' . $e->getMessage());
    json_error('Failed to create room.', 500);
}

json_ok([
    'room' => [
        'id' => $roomId,
        'room_code' => $roomCode,
        'title' => $title,
        'max_players' => $maxPlayers,
        'status' => 'LOBBY',
        'prizes_enabled' => $prizes,
        'auto_call_enabled' => $autoCallEnabled,
        'auto_call_interval_seconds' => $autoCallEnabled ? $autoCallInterval : null,
    ],
    'user' => ['id' => $user['id'], 'name' => $user['name'], 'email' => $user['email']],
]);
