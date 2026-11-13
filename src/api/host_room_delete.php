<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/GameEngine.php';
require_once __DIR__ . '/../includes/Realtime.php';
require_once __DIR__ . '/../includes/RedisCache.php';

require_post();
$user = Auth::requireUser();
RateLimiter::enforce('game_control', 'u:' . $user['id']);
$body = json_body();
$roomCode = strtoupper(trim((string)($body['room_code'] ?? '')));
if ($roomCode === '') json_error('Room code is required.', 400);
$pdo = DB::conn();
$room = RoomAccess::findByCode($pdo, $roomCode);
RoomAccess::requireHost($room, $user);
if (in_array(strtoupper((string)$room['status']), ['LIVE', 'PAUSED'], true)) {
    json_error('End the game before deleting this room.', 409);
}
$pdo->beginTransaction();
try {
    GameEngine::log($pdo, (int)$room['id'], null, 'HOST', (int)$user['id'], 'ROOM_DELETED', ['room_code' => $roomCode]);
    $del = $pdo->prepare('DELETE FROM rooms WHERE id = ? AND host_user_id = ?');
    $del->execute([(int)$room['id'], (int)$user['id']]);
    if ($del->rowCount() !== 1) throw new RuntimeException('Room deletion did not affect exactly one row.');
    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    throw $e;
}
RedisCache::del('rc:' . $roomCode);
Realtime::room($roomCode, 'room_deleted');
json_ok(['deleted' => true, 'room_code' => $roomCode, 'redirect' => 'index.html']);
