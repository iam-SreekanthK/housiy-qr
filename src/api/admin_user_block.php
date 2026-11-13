<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/AdminAuth.php';
require_once __DIR__ . '/../includes/RedisCache.php';

$admin = AdminAuth::requireAdmin();
require_post();
$body = json_body();
$userId = (int)($body['user_id'] ?? 0);
$blocked = !empty($body['blocked']);
$reason = trim((string)($body['reason'] ?? ''));
if ($userId < 1) json_error('A valid user is required.');

$pdo = DB::conn();
$stmt = $pdo->prepare('SELECT id, name, email, session_token FROM users WHERE id = ? LIMIT 1');
$stmt->execute([$userId]);
$user = $stmt->fetch();
if (!$user) json_error('User not found.', 404);

$pdo->beginTransaction();
try {
    $normalizedEmail = strtolower(trim((string)$user['email']));
    $normalizedName = mb_strtolower(trim((string)$user['name']), 'UTF-8');

    if ($blocked) {
        $sql = 'INSERT INTO user_blocks (user_id, email_normalized, name_normalized, reason, blocked_by)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE email_normalized=VALUES(email_normalized),
                  name_normalized=VALUES(name_normalized), reason=VALUES(reason),
                  blocked_by=VALUES(blocked_by), updated_at=CURRENT_TIMESTAMP';
        $pdo->prepare($sql)->execute([
            $userId, $normalizedEmail, $normalizedName,
            $reason !== '' ? mb_substr($reason, 0, 500) : null, (int)$admin['id']
        ]);

        // Revoke sessions for every account matching this blocked identity.
        $sessions = $pdo->prepare(
            'SELECT id, session_token FROM users
             WHERE LOWER(TRIM(email)) = ? OR LOWER(TRIM(name)) = ? FOR UPDATE'
        );
        $sessions->execute([$normalizedEmail, $normalizedName]);
        $rotate = $pdo->prepare('UPDATE users SET session_token = ? WHERE id = ?');
        foreach ($sessions->fetchAll() as $session) {
            $oldToken = (string)$session['session_token'];
            $newToken = bin2hex(random_bytes(32));
            $rotate->execute([$newToken, (int)$session['id']]);
            if ($oldToken !== '') RedisCache::del('u:' . hash('sha256', $oldToken));
            RedisCache::del('u:' . hash('sha256', $newToken));
        }
    } else {
        // Remove the identity-level block too, so the user can re-enter even
        // if an older block row was detached from its user_id by a cascade.
        $pdo->prepare(
            'DELETE FROM user_blocks WHERE user_id = ? OR email_normalized = ? OR name_normalized = ?'
        )->execute([$userId, $normalizedEmail, $normalizedName]);
    }
    $pdo->commit();
} catch (Throwable $e) {
    if ($pdo->inTransaction()) $pdo->rollBack();
    throw $e;
}
json_ok(['user_id' => $userId, 'blocked' => $blocked]);
