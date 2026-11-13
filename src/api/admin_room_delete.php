<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/AdminAuth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/GameEngine.php';
require_once __DIR__ . '/../includes/RedisCache.php';

require_post();

$admin = AdminAuth::requireAdmin();
$body = json_body();
$roomCode = trim((string)($body['room_code'] ?? ''));

if ($roomCode === '') {
    json_error('Room code is required', 400);
}

$pdo = DB::conn();
$room = RoomAccess::findByCode($pdo, $roomCode);

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

    // Related database rows are expected to cascade through foreign keys.
    $del = $pdo->prepare('DELETE FROM rooms WHERE id = ?');
    $del->execute([$roomId]);

    if ($del->rowCount() !== 1) {
        throw new RuntimeException('Room deletion did not affect exactly one row');
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
Realtime::room($normalizedRoomCode, 'room_deleted');

json_ok(['deleted' => true]);
