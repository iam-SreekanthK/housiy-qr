<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/AdminAuth.php';
require_once __DIR__ . '/../includes/RedisCache.php';
require_once __DIR__ . '/../includes/Realtime.php';

$admin = AdminAuth::requireAdmin();
require_post();
$body = json_body();
$userId = (int)($body['user_id'] ?? 0);
$requestedEmail = strtolower(trim((string)($body['email'] ?? '')));
$requestedName = mb_strtolower(trim((string)($body['name'] ?? '')), 'UTF-8');
$blocked = !empty($body['blocked']);
$reason = trim((string)($body['reason'] ?? ''));
if ($userId < 1) json_error('A valid user is required.');

$pdo = DB::conn();
$stmt = $pdo->prepare('SELECT id, name, email, session_token FROM users WHERE id = ? LIMIT 1');
$stmt->execute([$userId]);
$user = $stmt->fetch();
if (!$user) json_error('User not found.', 404);
if (($requestedEmail !== '' && $requestedEmail !== strtolower(trim((string)$user['email']))) ||
    ($requestedName !== '' && $requestedName !== mb_strtolower(trim((string)$user['name']), 'UTF-8'))) {
    json_error('The selected user identity changed. Refresh the admin list and try again.', 409);
}

$affectedMemberships = [];
$pdo->beginTransaction();
try {
    $normalizedEmail = strtolower(trim((string)$user['email']));
    $normalizedName = mb_strtolower(trim((string)$user['name']), 'UTF-8');

    if ($blocked) {
        $wasBlockedStmt = $pdo->prepare('SELECT 1 FROM user_blocks WHERE user_id = ? LIMIT 1');
        $wasBlockedStmt->execute([$userId]);
        $wasBlocked = (bool)$wasBlockedStmt->fetchColumn();
        $sql = 'INSERT INTO user_blocks (user_id, email_normalized, name_normalized, reason, blocked_by)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE email_normalized=VALUES(email_normalized),
                  name_normalized=VALUES(name_normalized), reason=VALUES(reason),
                  blocked_by=VALUES(blocked_by), updated_at=CURRENT_TIMESTAMP';
        $pdo->prepare($sql)->execute([
            $userId, $normalizedEmail, $normalizedName,
            $reason !== '' ? mb_substr($reason, 0, 500) : null, (int)$admin['id']
        ]);

        // A block applies to exactly the selected account. Names are display
        // attributes and must never be used as account-wide block keys.
        $accounts = $pdo->prepare('SELECT id, session_token FROM users WHERE id = ? FOR UPDATE');
        $accounts->execute([$userId]);
        $accountRows = $accounts->fetchAll(PDO::FETCH_ASSOC);
        if (!$wasBlocked) {
            $audit = $pdo->prepare("INSERT INTO user_block_events (user_id,name_snapshot,email_snapshot,event_type,reason,admin_id) VALUES (?,?,?,'BLOCK',?,?)");
            foreach ($accountRows as $account) {
                $auditUser = $pdo->prepare('SELECT name,email FROM users WHERE id=?');
                $auditUser->execute([(int)$account['id']]);
                $snapshot = $auditUser->fetch(PDO::FETCH_ASSOC);
                if ($snapshot) $audit->execute([(int)$account['id'], (string)$snapshot['name'], (string)$snapshot['email'], $reason !== '' ? mb_substr($reason,0,500) : null, (int)$admin['id']]);
            }
        }
        $accountIds = array_values(array_unique(array_map(static fn($r) => (int)$r['id'], $accountRows)));

        if ($accountIds) {
            $marks = implode(',', array_fill(0, count($accountIds), '?'));
            $members = $pdo->prepare(
                "SELECT rp.room_id, rp.user_id, r.room_code
                 FROM room_players rp JOIN rooms r ON r.id = rp.room_id
                 WHERE rp.is_active = 1 AND rp.user_id IN ($marks) FOR UPDATE"
            );
            $members->execute($accountIds);
            $affectedMemberships = $members->fetchAll(PDO::FETCH_ASSOC);
            $pdo->prepare("UPDATE room_players SET is_active = 0, blocked_at = COALESCE(blocked_at, CURRENT_TIMESTAMP) WHERE user_id IN ($marks)")->execute($accountIds);

            // Rotate all matching sessions so blocked users cannot continue
            // using HTTP endpoints after their live socket receives the event.
            $rotate = $pdo->prepare('UPDATE users SET session_token = ? WHERE id = ?');
            foreach ($accountRows as $account) {
                $oldToken = (string)$account['session_token'];
                $newToken = bin2hex(random_bytes(32));
                $rotate->execute([$newToken, (int)$account['id']]);
                if ($oldToken !== '') RedisCache::del('u:' . hash('sha256', $oldToken));
                RedisCache::del('u:' . hash('sha256', $newToken));
            }
        }
    } else {
        // Record the unblock transition before deleting the current block row.
        $wasBlockedStmt = $pdo->prepare('SELECT 1 FROM user_blocks WHERE user_id = ? LIMIT 1');
        $wasBlockedStmt->execute([$userId]);
        $wasBlocked = (bool)$wasBlockedStmt->fetchColumn();
        if ($wasBlocked) {
            $accounts = $pdo->prepare('SELECT id,name,email FROM users WHERE id = ? FOR UPDATE');
            $accounts->execute([$userId]);
            $audit = $pdo->prepare("INSERT INTO user_block_events (user_id,name_snapshot,email_snapshot,event_type,reason,admin_id) VALUES (?,?,?,'UNBLOCK',?,?)");
            foreach ($accounts->fetchAll(PDO::FETCH_ASSOC) as $account) {
                $audit->execute([(int)$account['id'], (string)$account['name'], (string)$account['email'], $reason !== '' ? mb_substr($reason,0,500) : null, (int)$admin['id']]);
            }
        }
        // Remove the current access restriction; immutable audit rows remain.
        $pdo->prepare('DELETE FROM user_blocks WHERE user_id = ?')->execute([$userId]);
    }
    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    throw $e;
}

if ($blocked) {
    // Deliver a private kick to each affected player and a room-wide roster
    // change so every remaining client refreshes the active player count.
    $sent = [];
    foreach ($affectedMemberships as $membership) {
        $roomCode = strtoupper((string)$membership['room_code']);
        $memberId = (int)$membership['user_id'];
        RedisCache::del('mem:' . (int)$membership['room_id'] . ':' . $memberId);
        RedisCache::del('rx:pl:' . (int)$membership['room_id']);
        Realtime::room($roomCode, 'player_blocked', $memberId, [
            'message' => 'Your account has been blocked by the administrator.'
        ]);
        $sent[$roomCode] = (int)$membership['room_id'];
    }
    foreach ($sent as $roomCode => $roomId) {
        Realtime::room($roomCode, 'player_removed', null, ['user_id' => (int)$membership['user_id'], 'reason' => 'admin_block']);
    }
}

json_ok(['user_id' => $userId, 'blocked' => $blocked]);
