<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/FullHouse.php';
require_once __DIR__ . '/../includes/AdminAuth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/PublicEmailMask.php';

AdminAuth::requireAdmin();
$pdo = DB::conn();

$roomCode = (string)($_GET['room_code'] ?? '');
$room = RoomAccess::findByCode($pdo, $roomCode, true);

$gameStmt = $pdo->prepare('SELECT * FROM games WHERE room_id = ? LIMIT 1');
$gameStmt->execute([$room['id']]);
$game = $gameStmt->fetch() ?: null;

$calledCountStmt = $pdo->prepare('SELECT COUNT(*) c FROM called_numbers WHERE game_id = ?');
$calledCountStmt->execute([$game ? $game['id'] : 0]);
$calledCount = $game ? (int)$calledCountStmt->fetch()['c'] : 0;

$hostStmt = $pdo->prepare('SELECT name, email FROM users WHERE id = ?');
$hostStmt->execute([$room['host_user_id']]);
$host = $hostStmt->fetch();

$playersStmt = $pdo->prepare(
    'SELECT u.name, u.email, rp.joined_at, rp.blocked_at, rp.is_active
     FROM room_players rp
     JOIN users u ON u.id = rp.user_id
     WHERE rp.room_id = ?
     ORDER BY rp.joined_at ASC'
);
$playersStmt->execute([$room['id']]);
$players = $playersStmt->fetchAll();

$reactionCountStmt = $pdo->prepare('SELECT COUNT(*) FROM room_emoji_reactions WHERE room_id = ?');
$reactionCountStmt->execute([$room['id']]);
$reactionCount = (int)$reactionCountStmt->fetchColumn();

$winnersStmt = $pdo->prepare(
    'SELECT rpw.prize_type, u.name AS winner_name, u.email AS winner_email, wc.claimed_at
     FROM room_prize_winners rpw
     JOIN winner_claims wc ON wc.id = rpw.winner_claim_id
     JOIN users u ON u.id = wc.user_id
     WHERE rpw.room_id = ?
     ORDER BY rpw.awarded_at ASC, rpw.id ASC'
);
$winnersStmt->execute([$room['id']]);
$winners = FullHouse::annotate($winnersStmt->fetchAll());

// Apply the same room-wide collision-aware masking used by the live player/host
// room pages. Include the host in the comparison set so identical names are
// disambiguated consistently in the admin room view too.
$maskSet = $players;
$maskSet[] = ['name' => (string)($host['name'] ?? ''), 'email' => (string)($host['email'] ?? '')];
[$maskedSet, $winners] = mask_room_public_people($maskSet, $winners);
$hostMasked = array_pop($maskedSet);
$players = $maskedSet;
$host['email'] = $hostMasked['email'] ?? ($host['email'] ?? null);

json_ok([
    'room' => [
        'room_code' => $room['room_code'],
        'title' => $room['title'],
        'status' => $room['status'],
        'max_players' => (int)$room['max_players'],
        'full_house_winners' => FullHouse::configured($room),
        'player_count' => count(array_filter($players, static fn($p) => (int)$p['is_active'] === 1)),
        'total_player_records' => count($players),
        'host_name' => $host['name'] ?? null,
        'host_email' => $host['email'] ?? null,
        // UTC (as stored) — the admin UI converts these to the viewer's
        // own local time zone; never format dates server-side.
        'created_at' => $room['created_at'],
        'started_at' => $room['started_at'],
        'ended_at' => $room['ended_at'],
        'deleted_at' => $room['deleted_at'] ?? null,
    ],
    'game' => [
        'status' => $game['status'] ?? null,
        'numbers_called_count' => $calledCount,
        'reactions_count' => $reactionCount,
    ],
    'players' => $players,
    'winners' => $winners,
]);
