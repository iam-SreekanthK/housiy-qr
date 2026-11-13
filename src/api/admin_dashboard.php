<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/AdminAuth.php';

AdminAuth::requireAdmin();
$pdo = DB::conn();

$stats = [
    'total_rooms'     => (int)$pdo->query('SELECT COUNT(*) c FROM rooms')->fetch()['c'],
    'lobby_rooms'     => (int)$pdo->query("SELECT COUNT(*) c FROM rooms WHERE status = 'LOBBY'")->fetch()['c'],
    'live_rooms'      => (int)$pdo->query("SELECT COUNT(*) c FROM rooms WHERE status IN ('LIVE','PAUSED')")->fetch()['c'],
    'completed_rooms' => (int)$pdo->query("SELECT COUNT(*) c FROM rooms WHERE status = 'COMPLETED'")->fetch()['c'],
    // Count account roles independently: a user can be both a host and a player.
    'total_hosts'     => (int)$pdo->query('SELECT COUNT(DISTINCT host_user_id) c FROM rooms')->fetch()['c'],
    'total_players'   => (int)$pdo->query(
        'SELECT COUNT(DISTINCT rp.user_id) c
         FROM room_players rp
         JOIN rooms joined_room ON joined_room.id = rp.room_id
         WHERE rp.is_active = 1 AND joined_room.host_user_id <> rp.user_id'
    )->fetch()['c'],
    'total_users'     => (int)$pdo->query(
        'SELECT COUNT(*) c FROM users u
         WHERE EXISTS (SELECT 1 FROM rooms hr WHERE hr.host_user_id = u.id)
            OR EXISTS (SELECT 1 FROM room_players rp WHERE rp.user_id = u.id AND rp.is_active = 1)'
    )->fetch()['c'],
];

$rooms = $pdo->query(
    'SELECT r.id, r.room_code, r.title, r.status, r.max_players, r.is_archived,
            r.created_at, r.started_at, r.ended_at,
            u.name AS host_name, u.email AS host_email,
            (SELECT COUNT(*) FROM room_players rp WHERE rp.room_id = r.id AND rp.is_active = 1) AS player_count
     FROM rooms r
     JOIN users u ON u.id = r.host_user_id
     ORDER BY r.created_at DESC
     LIMIT 200'
)->fetchAll();

$hosts = $pdo->query(
    "SELECT u.id, u.name, u.email, COUNT(r.id) AS rooms_hosted,
            MAX(r.created_at) AS last_hosted_at,
            (SELECT r2.room_code FROM rooms r2 WHERE r2.host_user_id=u.id ORDER BY r2.created_at DESC LIMIT 1) AS last_hosted_room_code,
            (SELECT r2.status FROM rooms r2 WHERE r2.host_user_id=u.id ORDER BY r2.created_at DESC LIMIT 1) AS last_hosted_status,
            (SELECT CASE WHEN r2.status='COMPLETED' AND r2.started_at IS NOT NULL AND r2.ended_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND,r2.started_at,r2.ended_at) ELSE NULL END FROM rooms r2 WHERE r2.host_user_id=u.id ORDER BY r2.created_at DESC LIMIT 1) AS last_hosted_duration_seconds,
            EXISTS(SELECT 1 FROM user_blocks ub WHERE ub.user_id=u.id OR (ub.email_normalized IS NOT NULL AND ub.email_normalized=LOWER(TRIM(u.email))) OR (ub.name_normalized IS NOT NULL AND ub.name_normalized=LOWER(TRIM(u.name)))) AS is_blocked
     FROM users u JOIN rooms r ON r.host_user_id = u.id
     GROUP BY u.id, u.name, u.email ORDER BY rooms_hosted DESC LIMIT 200"
)->fetchAll();

$players = $pdo->query(
    "SELECT u.id, u.name, u.email, COUNT(rp.id) AS rooms_joined, MAX(rp.joined_at) AS last_joined_at,
            (SELECT r2.room_code FROM room_players rp2 JOIN rooms r2 ON r2.id=rp2.room_id WHERE rp2.user_id=u.id AND rp2.is_active=1 AND r2.host_user_id <> u.id ORDER BY rp2.joined_at DESC LIMIT 1) AS last_room_code,
            (SELECT r2.status FROM room_players rp2 JOIN rooms r2 ON r2.id=rp2.room_id WHERE rp2.user_id=u.id AND rp2.is_active=1 AND r2.host_user_id <> u.id ORDER BY rp2.joined_at DESC LIMIT 1) AS last_room_status,
            (SELECT CASE WHEN r2.status='COMPLETED' AND r2.started_at IS NOT NULL AND r2.ended_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND,r2.started_at,r2.ended_at) ELSE NULL END FROM room_players rp2 JOIN rooms r2 ON r2.id=rp2.room_id WHERE rp2.user_id=u.id AND rp2.is_active=1 AND r2.host_user_id <> u.id ORDER BY rp2.joined_at DESC LIMIT 1) AS last_room_duration_seconds,
            EXISTS(SELECT 1 FROM user_blocks ub WHERE ub.user_id=u.id OR (ub.email_normalized IS NOT NULL AND ub.email_normalized=LOWER(TRIM(u.email))) OR (ub.name_normalized IS NOT NULL AND ub.name_normalized=LOWER(TRIM(u.name)))) AS is_blocked
     FROM users u JOIN room_players rp ON rp.user_id = u.id AND rp.is_active = 1
     JOIN rooms joined_room ON joined_room.id = rp.room_id AND joined_room.host_user_id <> u.id
     GROUP BY u.id, u.name, u.email ORDER BY rooms_joined DESC LIMIT 200"
)->fetchAll();

$users = $pdo->query("SELECT u.id, u.name, u.email, u.created_at, u.created_at AS joined_at,
       (SELECT rj.room_code FROM room_players rp JOIN rooms rj ON rj.id=rp.room_id WHERE rp.user_id=u.id AND rp.is_active=1 AND rj.host_user_id<>u.id ORDER BY rp.joined_at DESC LIMIT 1) AS last_joined_room_code,
       (SELECT rh.room_code FROM rooms rh WHERE rh.host_user_id=u.id ORDER BY rh.created_at DESC LIMIT 1) AS last_hosted_room_code,
       (SELECT MAX(rp.joined_at) FROM room_players rp JOIN rooms jr ON jr.id=rp.room_id WHERE rp.user_id=u.id AND rp.is_active=1 AND jr.host_user_id<>u.id) AS last_joined_at,
       (SELECT MAX(r.created_at) FROM rooms r WHERE r.host_user_id=u.id) AS last_hosted_at,
       EXISTS(SELECT 1 FROM user_blocks ub WHERE ub.user_id=u.id OR (ub.email_normalized IS NOT NULL AND ub.email_normalized=LOWER(TRIM(u.email))) OR (ub.name_normalized IS NOT NULL AND ub.name_normalized=LOWER(TRIM(u.name)))) AS is_blocked, CASE
       WHEN EXISTS (SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id)
        AND EXISTS (SELECT 1 FROM room_players rp JOIN rooms jr ON jr.id=rp.room_id WHERE rp.user_id=u.id AND rp.is_active=1 AND jr.host_user_id<>u.id)
         THEN 'Host + Player'
       WHEN EXISTS (SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id) THEN 'Host'
       ELSE 'Player'
     END AS user_type FROM users u WHERE EXISTS (SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id) OR EXISTS (SELECT 1 FROM room_players rp WHERE rp.user_id=u.id) ORDER BY u.created_at DESC LIMIT 500")->fetchAll();

json_ok([
    'stats' => $stats,
    'rooms' => $rooms,
    'hosts' => $hosts,
    'players' => $players,
    'users' => $users,
]);
