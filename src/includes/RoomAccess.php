<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/RedisCache.php';

final class RoomAccess
{
    public static function findByCode(PDO $pdo, string $roomCode, bool $includeDeleted = false): array
    {
        $sql = 'SELECT * FROM rooms WHERE room_code = ?' . ($includeDeleted ? '' : ' AND deleted_at IS NULL') . ' LIMIT 1';
        $stmt = $pdo->prepare($sql);
        $stmt->execute([strtoupper(trim($roomCode))]);
        $room = $stmt->fetch();
        if (!$room) {
            $deletedBy = RedisCache::get('rd:' . strtoupper(trim($roomCode)));
            if ($deletedBy === 'admin') json_error('This room has been deleted by the administrator.', 404);
            if ($deletedBy === 'host') json_error('This room has been deleted by the host.', 404);
            json_error('Room not found.', 404);
        }
        return $room;
    }

    public static function findById(PDO $pdo, int $roomId, bool $includeDeleted = false): array
    {
        $sql = 'SELECT * FROM rooms WHERE id = ?' . ($includeDeleted ? '' : ' AND deleted_at IS NULL') . ' LIMIT 1';
        $stmt = $pdo->prepare($sql);
        $stmt->execute([$roomId]);
        $room = $stmt->fetch();
        if (!$room) {
            json_error('Room not found.', 404);
        }
        return $room;
    }

    /** Verify the current user is the host of the room, or terminate. */
    public static function requireHost(array $room, array $user): void
    {
        if ((int)$room['host_user_id'] !== (int)$user['id']) {
            json_error('Only the host of this room can perform this action.', 403);
        }
    }

    /**
     * Verify the current user is either the host of this room or has
     * joined it as a player, or terminate. Use this for any endpoint that
     * returns room-scoped data (player lists, emails, winners) — being
     * logged in as *some* user is not the same as belonging to *this*
     * room, and room_code alone must not be treated as sufficient proof
     * of access.
     */
    public static function requireMember(PDO $pdo, array $room, array $user): void
    {
        if ((int)$room['host_user_id'] === (int)$user['id']) {
            return;
        }
        $stmt = $pdo->prepare('SELECT 1 FROM room_players WHERE room_id = ? AND user_id = ? AND is_active = 1 LIMIT 1');
        $stmt->execute([$room['id'], $user['id']]);
        if (!$stmt->fetch()) {
            json_error('You do not have access to this room.', 403);
        }
    }
}
