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
    // Keep room/player/winner history for super-admin reports; hide it from runtime access.
    $del = $pdo->prepare("UPDATE rooms SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP), is_archived = 1, status = 'CANCELLED' WHERE id = ? AND host_user_id = ? AND deleted_at IS NULL");
    $del->execute([(int)$room['id'], (int)$user['id']]);
    if ($del->rowCount() !== 1) throw new RuntimeException('Room was already deleted or could not be marked deleted.');
    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    throw $e;
}
RedisCache::del('rc:' . $roomCode);
RedisCache::set('rd:' . $roomCode, 'host', 86400);
Realtime::room($roomCode, 'room_deleted');
json_ok(['deleted' => true, 'room_code' => $roomCode, 'redirect' => 'index.html']);
