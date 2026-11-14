<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/AdminAuth.php';
require_once __DIR__ . '/../includes/PublicEmailMask.php';

AdminAuth::requireAdmin();
$pdo = DB::conn();

$stats = [
    'total_rooms'     => (int)$pdo->query('SELECT COUNT(*) c FROM rooms WHERE deleted_at IS NULL')->fetch()['c'],
    'lobby_rooms'     => (int)$pdo->query("SELECT COUNT(*) c FROM rooms WHERE deleted_at IS NULL AND status = 'LOBBY'")->fetch()['c'],
    'live_rooms'      => (int)$pdo->query("SELECT COUNT(*) c FROM rooms WHERE deleted_at IS NULL AND status IN ('LIVE','PAUSED')")->fetch()['c'],
    'completed_rooms' => (int)$pdo->query("SELECT COUNT(*) c FROM rooms WHERE deleted_at IS NULL AND status = 'COMPLETED'")->fetch()['c'],
    // Count account roles independently: a user can be both a host and a player.
    'total_hosts'     => (int)$pdo->query('SELECT COUNT(*) c FROM users WHERE ever_hosted = 1')->fetch()['c'],
    'total_players'   => (int)$pdo->query('SELECT COUNT(*) c FROM users WHERE ever_played = 1')->fetch()['c'],
    'total_users'     => (int)$pdo->query('SELECT COUNT(*) c FROM users WHERE ever_hosted = 1 OR ever_played = 1')->fetch()['c'],
];

$rooms = $pdo->query(
    'SELECT r.id, r.room_code, r.title, r.status, r.max_players, r.is_archived,
            r.created_at, r.started_at, r.ended_at,
            u.name AS host_name, u.email AS host_email,
            (SELECT COUNT(*) FROM room_players rp WHERE rp.room_id = r.id AND rp.is_active = 1) AS player_count
     FROM rooms r
     JOIN users u ON u.id = r.host_user_id
     WHERE r.deleted_at IS NULL
     ORDER BY r.created_at DESC
     LIMIT 200'
)->fetchAll();

$hosts = $pdo->query(
    "SELECT u.id, u.name, u.email, COUNT(r.id) AS rooms_hosted,
            MAX(r.created_at) AS last_hosted_at,
            (SELECT r2.room_code FROM rooms r2 WHERE r2.host_user_id=u.id ORDER BY r2.created_at DESC LIMIT 1) AS last_hosted_room_code,
            (SELECT r2.status FROM rooms r2 WHERE r2.host_user_id=u.id ORDER BY r2.created_at DESC LIMIT 1) AS last_hosted_status,
            (SELECT CASE WHEN r2.status='COMPLETED' AND r2.started_at IS NOT NULL AND r2.ended_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND,r2.started_at,r2.ended_at) ELSE NULL END FROM rooms r2 WHERE r2.host_user_id=u.id ORDER BY r2.created_at DESC LIMIT 1) AS last_hosted_duration_seconds,
            EXISTS(SELECT 1 FROM user_blocks ub WHERE ub.user_id=u.id OR (ub.email_normalized IS NOT NULL AND ub.email_normalized=LOWER(TRIM(u.email)))) AS is_blocked,
            (SELECT MAX(ub.updated_at) FROM user_blocks ub WHERE ub.user_id=u.id OR ub.email_normalized=LOWER(TRIM(u.email))) AS blocked_at,
            (SELECT CONCAT(ube.event_type,'|',DATE_FORMAT(ube.event_at,'%Y-%m-%d %H:%i:%s')) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email) ORDER BY ube.event_at DESC,ube.id DESC LIMIT 1) AS last_block_event,
            (SELECT COUNT(*) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email)) AS block_event_count
     FROM users u LEFT JOIN rooms r ON r.host_user_id = u.id
     WHERE u.ever_hosted = 1
     GROUP BY u.id, u.name, u.email ORDER BY rooms_hosted DESC LIMIT 200"
)->fetchAll();

$players = $pdo->query(
    "SELECT u.id, u.name, u.email, COUNT(DISTINCT CASE WHEN joined_room.host_user_id <> u.id THEN rp.id END) AS rooms_joined, MAX(CASE WHEN joined_room.host_user_id <> u.id THEN rp.joined_at END) AS last_joined_at,
            (SELECT r2.room_code FROM room_players rp2 JOIN rooms r2 ON r2.id=rp2.room_id WHERE rp2.user_id=u.id AND r2.host_user_id <> u.id ORDER BY rp2.joined_at DESC LIMIT 1) AS last_room_code,
            (SELECT r2.status FROM room_players rp2 JOIN rooms r2 ON r2.id=rp2.room_id WHERE rp2.user_id=u.id AND r2.host_user_id <> u.id ORDER BY rp2.joined_at DESC LIMIT 1) AS last_room_status,
            (SELECT CASE WHEN r2.status='COMPLETED' AND r2.started_at IS NOT NULL AND r2.ended_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND,r2.started_at,r2.ended_at) ELSE NULL END FROM room_players rp2 JOIN rooms r2 ON r2.id=rp2.room_id WHERE rp2.user_id=u.id AND r2.host_user_id <> u.id ORDER BY rp2.joined_at DESC LIMIT 1) AS last_room_duration_seconds,
            EXISTS(SELECT 1 FROM user_blocks ub WHERE ub.user_id=u.id OR (ub.email_normalized IS NOT NULL AND ub.email_normalized=LOWER(TRIM(u.email)))) AS is_blocked,
            (SELECT MAX(ub.updated_at) FROM user_blocks ub WHERE ub.user_id=u.id OR ub.email_normalized=LOWER(TRIM(u.email))) AS blocked_at,
            (SELECT CONCAT(ube.event_type,'|',DATE_FORMAT(ube.event_at,'%Y-%m-%d %H:%i:%s')) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email) ORDER BY ube.event_at DESC,ube.id DESC LIMIT 1) AS last_block_event,
            (SELECT COUNT(*) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email)) AS block_event_count
     FROM users u LEFT JOIN room_players rp ON rp.user_id = u.id LEFT JOIN rooms joined_room ON joined_room.id = rp.room_id
     WHERE u.ever_played = 1
     GROUP BY u.id, u.name, u.email ORDER BY rooms_joined DESC LIMIT 200"
)->fetchAll();

$users = $pdo->query("SELECT u.id, u.name, u.email, u.created_at, u.created_at AS joined_at,
       (SELECT rj.room_code FROM room_players rp JOIN rooms rj ON rj.id=rp.room_id WHERE rp.user_id=u.id AND rj.host_user_id<>u.id ORDER BY rp.joined_at DESC LIMIT 1) AS last_joined_room_code,
       (SELECT rh.room_code FROM rooms rh WHERE rh.host_user_id=u.id ORDER BY rh.created_at DESC LIMIT 1) AS last_hosted_room_code,
       (SELECT MAX(rp.joined_at) FROM room_players rp JOIN rooms jr ON jr.id=rp.room_id WHERE rp.user_id=u.id AND jr.host_user_id<>u.id) AS last_joined_at,
       (SELECT MAX(r.created_at) FROM rooms r WHERE r.host_user_id=u.id) AS last_hosted_at,
       EXISTS(SELECT 1 FROM user_blocks ub WHERE ub.user_id=u.id OR (ub.email_normalized IS NOT NULL AND ub.email_normalized=LOWER(TRIM(u.email)))) AS is_blocked,
            (SELECT MAX(ub.updated_at) FROM user_blocks ub WHERE ub.user_id=u.id OR ub.email_normalized=LOWER(TRIM(u.email))) AS blocked_at,
            (SELECT CONCAT(ube.event_type,'|',DATE_FORMAT(ube.event_at,'%Y-%m-%d %H:%i:%s')) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email) ORDER BY ube.event_at DESC,ube.id DESC LIMIT 1) AS last_block_event,
            (SELECT COUNT(*) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email)) AS block_event_count, CASE
       WHEN u.ever_hosted = 1 AND u.ever_played = 1 THEN 'Host + Player'
       WHEN u.ever_hosted = 1 THEN 'Host'
       ELSE 'Player'
     END AS user_type FROM users u WHERE u.ever_hosted = 1 OR u.ever_played = 1 ORDER BY u.created_at DESC LIMIT 500")->fetchAll();

// Keep the admin user directory consistent with room participant privacy.
// Same-name addresses are disambiguated case-insensitively by the shared formatter.
[$users] = mask_room_public_people($users, []);

json_ok([
    'stats' => $stats,
    'rooms' => $rooms,
    'hosts' => $hosts,
    'players' => $players,
    'users' => $users,
]);
