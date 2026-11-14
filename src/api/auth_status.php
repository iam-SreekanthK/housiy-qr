<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RedisCache.php';

$user = Auth::currentUser();
if (!$user) {
    json_ok(['authenticated' => false, 'blocked' => false]);
}

$pdo = DB::conn();
$stmt = $pdo->prepare(
    'SELECT 1 FROM user_blocks
     WHERE user_id = ?
        OR (email_normalized IS NOT NULL AND email_normalized = ?)
     LIMIT 1'
);
$stmt->execute([
    (int)$user['id'],
    strtolower(trim((string)$user['email'])),
]);
$blocked = (bool)$stmt->fetchColumn();

if ($blocked) {
    // Revoke this browser's stale identity cookie and cached lookup immediately.
    $token = (string)($_COOKIE[SESSION_COOKIE_NAME] ?? '');
    if ($token !== '') RedisCache::del('u:' . hash('sha256', $token));
    setcookie(SESSION_COOKIE_NAME, '', [
        'expires' => time() - 3600,
        'path' => '/',
        'secure' => AppEnv::cookieSecure(),
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    json_ok(['authenticated' => false, 'blocked' => true]);
}

json_ok(['authenticated' => true, 'blocked' => false]);
