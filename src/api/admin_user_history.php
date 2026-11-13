<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/AdminAuth.php';

AdminAuth::requireAdmin();
$pdo = DB::conn();

$email = trim((string)($_GET['email'] ?? ''));
if ($email === '') {
    json_error('Missing email.');
}

$userStmt = $pdo->prepare('SELECT id, name, email FROM users WHERE email = ? LIMIT 1');
$userStmt->execute([$email]);
$user = $userStmt->fetch();
if (!$user) {
    json_error('User not found.');
}

// Rooms this user hosted.
$hostedStmt = $pdo->prepare(
    'SELECT r.room_code, r.title, r.status, r.created_at, r.started_at, r.ended_at,
            (SELECT COUNT(*) FROM room_players rp WHERE rp.room_id = r.id AND rp.is_active = 1) AS player_count,
            r.max_players
     FROM rooms r
     WHERE r.host_user_id = ?
     ORDER BY r.created_at DESC'
);
$hostedStmt->execute([$user['id']]);
$hosted = $hostedStmt->fetchAll();

// Rooms this user joined as a player, excluding rooms they hosted themselves.
$joinedStmt = $pdo->prepare(
    'SELECT r.room_code, r.title, r.status, r.created_at AS room_created_at,
            rp.joined_at,
            u2.name AS host_name, u2.email AS host_email
     FROM room_players rp
     JOIN rooms r ON r.id = rp.room_id
     JOIN users u2 ON u2.id = r.host_user_id
     WHERE rp.user_id = ? AND rp.is_active = 1 AND r.host_user_id <> ?
     ORDER BY rp.joined_at DESC'
);
$joinedStmt->execute([$user['id'], $user['id']]);
$joined = $joinedStmt->fetchAll();

json_ok([
    'user' => [
        'name' => $user['name'],
        'email' => $user['email'],
    ],
    'hosted' => $hosted,
    'joined' => $joined,
]);
