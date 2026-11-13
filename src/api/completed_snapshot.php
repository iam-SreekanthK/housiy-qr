<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RoomState.php';
require_once __DIR__ . '/../includes/MarkBuffer.php';

$user = Auth::requireUser();
$roomCode = strtoupper(trim((string)($_GET['room_code'] ?? '')));
if ($roomCode === '' || !preg_match('/^[A-Z0-9]{4,16}$/', $roomCode)) {
    json_error('A valid room_code is required.', 400);
}
$pdo = null;
$db = static function () use (&$pdo): PDO { return $pdo ??= DB::conn(); };
$state = RoomState::load($db, $roomCode);
$room = $state['room'];
RoomState::requireMember($db, $room, $user);
$gameStatus = strtoupper((string)($state['game']['status'] ?? ''));
$roomStatus = strtoupper((string)($room['status'] ?? ''));
if (!in_array($gameStatus, ['COMPLETED', 'ENDED', 'CANCELLED'], true)
    && !in_array($roomStatus, ['COMPLETED', 'ENDED', 'CANCELLED'], true)) {
    json_error('The game is not completed.', 409);
}
$ticket = RoomState::ticket($db, (int)$room['id'], (int)$user['id']);
if (!$ticket) json_error('You have not joined this room.', 404);
$marks = MarkBuffer::cached((int)$ticket['id']);
if ($marks === null) {
    $markVersion = MarkBuffer::version((int)$ticket['id']);
    $pending = MarkBuffer::pending((int)$ticket['id']);
    $stmt = $db()->prepare('SELECT number FROM marked_numbers WHERE ticket_id = ?');
    $stmt->execute([(int)$ticket['id']]);
    $marks = MarkBuffer::union(array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN)), $pending);
    if ($markVersion !== null) {
        MarkBuffer::cacheMerge((int)$ticket['id'], $marks, $markVersion);
    }
}
$winners = array_map(static function (array $w): array {
    return [
        'prize_type' => (string)($w['prize_type'] ?? ''),
        'winner_user_id' => (int)($w['winner_user_id'] ?? 0),
        'winner_name' => (string)($w['winner_name'] ?? ''),
        'claimed_at' => $w['claimed_at'] ?? null,
    ];
}, $state['winners']);
$players = array_map(static function (array $p): array {
    return ['id' => (int)$p['id'], 'name' => (string)$p['name'], 'is_host' => (bool)$p['is_host']];
}, $state['players']);
json_ok([
    'snapshot_version' => 1,
    'room' => [
        'room_code' => $room['room_code'], 'title' => $room['title'], 'status' => $room['status'],
        'player_count' => (int)$state['player_count'], 'max_players' => (int)$room['max_players'],
        'prizes_enabled' => json_decode((string)$room['prizes_enabled'], true) ?: [],
        'created_at' => $room['created_at'] ?? null, 'started_at' => $room['started_at'] ?? null,
        'ended_at' => $room['ended_at'] ?? null, 'rematch_room_code' => $room['rematch_room_code'] ?? null,
    ],
    'game' => [
        'status' => $state['game']['status'], 'current_number' => $state['game']['current_number'] !== null ? (int)$state['game']['current_number'] : null,
        'numbers_called_count' => (int)$state['game']['numbers_called_count'], 'started_at' => $state['game']['started_at'] ?? null,
        'ended_at' => $state['game']['ended_at'] ?? null,
    ],
    'called_numbers' => array_map('intval', $state['called']),
    'players' => $players, 'winners' => $winners,
    'ticket' => ['id' => (int)$ticket['id'], 'grid' => $ticket['grid']],
    'marked_numbers' => array_values(array_map('intval', $marks)),
]);
