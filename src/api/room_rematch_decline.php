<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';

require_post();
$user = Auth::requireUser();
$body = json_body();
$roomCode = strtoupper(trim((string)($body['room_code'] ?? '')));
$newRoomCode = strtoupper(trim((string)($body['new_room_code'] ?? '')));
if ($roomCode === '' || $newRoomCode === '') json_error('Invalid rematch decision.', 422);
$pdo = DB::conn();
$room = RoomAccess::findByCode($pdo, $roomCode);
if (!$room || !in_array((string)$room['status'], ['COMPLETED', 'CANCELLED'], true)) {
    json_error('The original game is not completed.', 409);
}
if (!hash_equals((string)($room['rematch_room_code'] ?? ''), $newRoomCode)) {
    json_error('This rematch does not belong to the original room.', 409);
}
$member = $pdo->prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ? AND is_active = 1 LIMIT 1');
$member->execute([(int)$room['id'], (int)$user['id']]);
if (!$member->fetchColumn()) json_error('You are not a member of this room.', 403);
$stmt = $pdo->prepare('INSERT INTO room_rematch_declines (room_id, user_id, rematch_room_code) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE declined_at = VALUES(declined_at)');
$stmt->execute([(int)$room['id'], (int)$user['id'], $newRoomCode]);
json_ok(['declined' => true, 'room_code' => $roomCode, 'rematch_room_code' => $newRoomCode]);
