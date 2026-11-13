<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';

$user = Auth::requireUser();
RateLimiter::enforce('state_read', 'u:' . $user['id']);
$pdo = DB::conn();

$hostedStmt = $pdo->prepare(
    'SELECT room_code, title, status, max_players, created_at, started_at, ended_at
     FROM rooms WHERE host_user_id = ? ORDER BY created_at DESC LIMIT 50'
);
$hostedStmt->execute([$user['id']]);
$hosted = $hostedStmt->fetchAll();

$joinedStmt = $pdo->prepare(
    'SELECT r.room_code, r.title, r.status, rp.joined_at,
            r.created_at, r.started_at, r.ended_at
     FROM room_players rp
     JOIN rooms r ON r.id = rp.room_id
     WHERE rp.user_id = ?
       AND r.host_user_id <> ?
     ORDER BY rp.joined_at DESC LIMIT 50'
);
// Hosts are automatically enrolled as players when a room is created so
// they receive their own ticket. That membership must not also classify
// their hosted room as a "Joined Game" in the landing-page history.
$joinedStmt->execute([$user['id'], $user['id']]);
$joined = $joinedStmt->fetchAll();

json_ok([
    'user' => ['name' => $user['name'], 'email' => $user['email']],
    'hosted_games' => $hosted,
    'joined_games' => $joined,
]);
