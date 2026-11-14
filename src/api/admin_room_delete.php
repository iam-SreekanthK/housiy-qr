<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/AdminAuth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/GameEngine.php';
require_once __DIR__ . '/../includes/RedisCache.php';
require_once __DIR__ . '/../includes/Realtime.php';

require_post();

$admin = AdminAuth::requireAdmin();
$body = json_body();
$roomCode = trim((string)($body['room_code'] ?? ''));

if ($roomCode === '') {
    json_error('Room code is required', 400);
}

$pdo = DB::conn();
$room = RoomAccess::findByCode($pdo, $roomCode, true);

if (!$room) {
    json_error('Room not found', 404);
}

$roomId = (int)$room['id'];
$normalizedRoomCode = strtoupper((string)$room['room_code']);

$pdo->beginTransaction();

try {
    GameEngine::log(
        $pdo,
        $roomId,
        null,
        'SUPER_ADMIN',
        (int)$admin['id'],
        'ROOM_DELETED',
        ['room_code' => $normalizedRoomCode]
    );

    // Soft-delete instead of cascading DELETE: retain host, player, winner,
    // ticket, call and reaction rows so admin history and exports remain auditable.
    $del = $pdo->prepare("UPDATE rooms SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP), is_archived = 1, status = 'CANCELLED' WHERE id = ? AND deleted_at IS NULL");
    $del->execute([$roomId]);

    if ($del->rowCount() !== 1) {
        throw new RuntimeException('Room was already deleted or could not be marked deleted');
    }

    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) {
        $pdo->rollBack();
    }

    throw $e;
}

// External cleanup occurs after the database transaction commits.
RedisCache::del('rc:' . $normalizedRoomCode);
RedisCache::set('rd:' . $normalizedRoomCode, 'admin', 86400);
Realtime::room($normalizedRoomCode, 'room_deleted', null, ['reason' => 'admin']);

json_ok(['deleted' => true]);
