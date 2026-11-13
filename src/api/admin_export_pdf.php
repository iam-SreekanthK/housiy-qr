<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/AdminAuth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';

$admin = AdminAuth::requireAdmin();
RateLimiter::enforce('expensive', 'admin:' . $admin['id']);
$pdo = DB::conn();

$maskEmails = (string)($_GET['mask_emails'] ?? '1') !== '0';
function mask_report_email($email): string {
    global $maskEmails;
    $email = trim((string)($email ?? ''));
    if (!$maskEmails || $email === '') return $email;
    $at = strrpos($email, '@');
    if ($at === false || $at === 0 || $at === strlen($email) - 1) return '***';
    $local = substr($email, 0, $at); $domain = substr($email, $at + 1); $length = strlen($local);
    if ($length <= 1) $masked = '*';
    elseif ($length <= 4) $masked = substr($local, 0, 1) . str_repeat('*', max(1, $length - 1));
    else $masked = substr($local, 0, 2) . '..' . substr($local, -2);
    return $masked . '@' . $domain;
}

function h($value): string { return htmlspecialchars((string)$value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
function report_time($value): string {
    if (!$value) return '—';
    try {
        // Database timestamps are stored as UTC; reports always display India Standard Time.
        return (new DateTimeImmutable((string)$value, new DateTimeZone('UTC')))
            ->setTimezone(new DateTimeZone('Asia/Kolkata'))->format('Y-m-d H:i:s') . ' IST';
    } catch (Throwable $e) { return (string)$value; }
}
function report_status(string $status): string {
    return match (strtoupper($status)) { 'LOBBY'=>'Not Started', 'LIVE'=>'Live', 'PAUSED'=>'Paused', 'COMPLETED'=>'Completed', default=>ucfirst(strtolower($status)) };
}
function report_duration($start, $end, string $status): string {
    if (!$start) return strtoupper($status)==='LOBBY' ? 'Not Started' : (in_array(strtoupper($status), ['LIVE','PAUSED'], true) ? 'Live' : '—');
    if (!$end) return in_array(strtoupper($status), ['LIVE','PAUSED'], true) ? 'Live' : '—';
    $utc = new DateTimeZone('UTC');
    $seconds=max(0, (new DateTimeImmutable((string)$end, $utc))->getTimestamp()-(new DateTimeImmutable((string)$start, $utc))->getTimestamp());
    return intdiv($seconds,60).'m '.($seconds%60).'s';
}

$view = strtolower((string)($_GET['view'] ?? 'rooms'));
$status = strtoupper((string)($_GET['status'] ?? ''));
$roomCode = trim((string)($_GET['room_code'] ?? ''));
if ($roomCode === '' && in_array($view, ['rooms','hosts','players','users'], true)) {
    if ($view === 'rooms') {
        $sql='SELECT r.room_code,r.title,r.status,u.name host_name,u.email host_email,(SELECT COUNT(*) FROM room_players rp WHERE rp.room_id=r.id AND rp.is_active=1) player_count,r.created_at FROM rooms r JOIN users u ON u.id=r.host_user_id';
        if (in_array($status,['LOBBY','LIVE','PAUSED','COMPLETED'],true)) $sql .= $status==='LIVE' ? " WHERE r.status IN ('LIVE','PAUSED')" : ' WHERE r.status=' . $pdo->quote($status);
        $sql.=' ORDER BY r.created_at DESC'; $rows=$pdo->query($sql)->fetchAll();
        $headers=['Room','Title','Status','Host','Host Email','Players','Created']; $keys=['room_code','title','status','host_name','host_email','player_count','created_at'];
    } elseif ($view==='hosts') {
        $rows=$pdo->query('SELECT u.name,u.email,COUNT(r.id) rooms_hosted,MAX(r.created_at) last_hosted_at FROM users u JOIN rooms r ON r.host_user_id=u.id GROUP BY u.id,u.name,u.email ORDER BY rooms_hosted DESC')->fetchAll(); $headers=['Name','Email','Rooms Hosted','Last Hosted']; $keys=['name','email','rooms_hosted','last_hosted_at'];
    } elseif ($view==='players') {
        $rows=$pdo->query('SELECT u.name,u.email,COUNT(rp.id) rooms_joined,MAX(rp.joined_at) last_joined_at FROM users u JOIN room_players rp ON rp.user_id=u.id WHERE NOT EXISTS (SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id) GROUP BY u.id,u.name,u.email ORDER BY rooms_joined DESC')->fetchAll(); $headers=['Name','Email','Rooms Joined','Last Joined']; $keys=['name','email','rooms_joined','last_joined_at'];
    } else {
        $rows=$pdo->query("SELECT u.name,u.email,u.created_at,CASE WHEN EXISTS(SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id) THEN 'Host' WHEN EXISTS(SELECT 1 FROM room_players rp WHERE rp.user_id=u.id) THEN 'Player' ELSE 'Player' END user_type FROM users u WHERE EXISTS(SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id) OR EXISTS(SELECT 1 FROM room_players rp WHERE rp.user_id=u.id) ORDER BY u.created_at DESC")->fetchAll(); $headers=['Name','Email','User Type','Created']; $keys=['name','email','user_type','created_at'];
    }
    header('Content-Type: text/html; charset=utf-8');
    echo '<!doctype html><html><head><meta charset="utf-8"><title>Housiy '.h(ucfirst($view)).' Report</title><style>body{font-family:Arial,sans-serif;padding:24px;color:#171717}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border:1px solid #bbb;padding:7px;text-align:left}th{background:#222;color:white}tr:nth-child(even){background:#f5f5f5}@media print{.no-print{display:none}}</style></head><body><button class="no-print" data-print>Print / Save as PDF</button><script src="/assets/js/print-report.js"></script><h1>Housiy — '.h($view === 'users' ? 'Total Users (Hosts + Players)' : ucfirst($view)).' Report</h1><p>Generated '.h((new DateTimeImmutable("now",new DateTimeZone("Asia/Kolkata")))->format("Y-m-d H:i:s")).' IST · Records: '.count($rows).'</p><table><thead><tr>';
    foreach($headers as $head) echo '<th>'.h($head).'</th>';
    echo '</tr></thead><tbody>';
    foreach($rows as $row){
        echo '<tr>';
        foreach($keys as $key){
            $v=$row[$key]??'';
            if (str_contains($key, 'email')) $v=mask_report_email($v);
            elseif (str_contains($key,'_at') || $key==='created_at') $v=report_time($v);
            echo '<td>'.h($v).'</td>';
        }
        echo '</tr>';
    }
    echo '</tbody></table></body></html>'; exit;
}
if ($roomCode !== '') {
    $room = RoomAccess::findByCode($pdo, $roomCode);
    $hostStmt = $pdo->prepare('SELECT name AS host_name, email AS host_email FROM users WHERE id = ?');
    $hostStmt->execute([$room['host_user_id']]);
    $host = $hostStmt->fetch() ?: [];
    $room['host_name'] = $host['host_name'] ?? '';
    $room['host_email'] = $host['host_email'] ?? '';
    $gameStmt = $pdo->prepare('SELECT id FROM games WHERE room_id = ? LIMIT 1');
    $gameStmt->execute([$room['id']]);
    $game = $gameStmt->fetch();
    $calledCountStmt = $pdo->prepare('SELECT COUNT(*) FROM called_numbers WHERE game_id = ?');
    $calledCountStmt->execute([$game['id'] ?? 0]);
    $calledCount = (int)$calledCountStmt->fetchColumn();
    $reactionCountStmt = $pdo->prepare('SELECT COUNT(*) FROM room_emoji_reactions WHERE room_id = ?');
    $reactionCountStmt->execute([$room['id']]);
    $reactionCount = (int)$reactionCountStmt->fetchColumn();
    $playersStmt = $pdo->prepare(
        'SELECT u.name, u.email, rp.joined_at
         FROM room_players rp JOIN users u ON u.id = rp.user_id
         WHERE rp.room_id = ? AND rp.is_active = 1
         ORDER BY rp.joined_at ASC'
    );
    $playersStmt->execute([$room['id']]);
    $players = $playersStmt->fetchAll();
    $winnersStmt = $pdo->prepare(
        'SELECT rpw.prize_type, u.name AS winner_name, u.email AS winner_email, wc.claimed_at
         FROM room_prize_winners rpw
         JOIN winner_claims wc ON wc.id = rpw.winner_claim_id
         JOIN users u ON u.id = wc.user_id
         WHERE rpw.room_id = ?
         ORDER BY rpw.awarded_at ASC'
    );
    $winnersStmt->execute([$room['id']]);
    $winners = $winnersStmt->fetchAll();

    header('Content-Type: text/html; charset=utf-8');
    ?>
    <!doctype html><html lang="en"><head><meta charset="utf-8">
    <title>Housiy Room <?= h($room['room_code']) ?> Report</title>
    <style>
      body{font-family:Arial,sans-serif;color:#171717;padding:24px}h1{font-size:22px;margin-bottom:4px}
      .meta{color:#555;font-size:12px;margin-bottom:18px}.actions{margin-bottom:18px}
      table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0 24px}
      th,td{border:1px solid #bbb;padding:7px 8px;text-align:left;overflow-wrap:anywhere}
      th{background:#222;color:white}tr:nth-child(even){background:#f5f5f5}
      h2{font-size:16px;margin:22px 0 4px}
      @media print{.no-print{display:none}body{padding:0}thead{display:table-header-group}tr{break-inside:avoid}}
    </style></head><body>
    <div class="actions no-print"><button data-print>Print / Save as PDF</button><script src="/assets/js/print-report.js"></script></div>
    <h1>Housiy — Room Report</h1>
    <div class="meta">Generated: <?= h((new DateTimeImmutable('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d H:i:s') . ' IST') ?></div>
    <p><strong>Title:</strong> <?= h($room['title']) ?> &nbsp; <strong>Status:</strong> <?= h(report_status((string)$room['status'])) ?></p>
    <table><tbody>
      <tr><th>Host</th><td><?= h($room['host_name'] ?? '—') ?></td><th>Host Email</th><td><?= h(mask_report_email($room['host_email'] ?? '—')) ?></td></tr>
      <tr><th>Players</th><td><?= count($players) ?> / <?= (int)$room['max_players'] ?></td><th>Numbers called</th><td><?= $calledCount ?> / 90</td></tr>
      <tr><th>Reactions count</th><td><?= $reactionCount ?></td><th>Room ID</th><td><?= h($room['room_code']) ?></td></tr>
      <tr><th>Created</th><td><?= h(report_time($room['created_at'])) ?></td><th>Start time</th><td><?= h(report_time($room['started_at'] ?? null)) ?></td></tr>
      <tr><th>Completed time</th><td><?= h(report_time($room['ended_at'] ?? null)) ?></td><th>Duration</th><td><?= h(report_duration($room['started_at'] ?? null, $room['ended_at'] ?? null, (string)$room['status'])) ?></td></tr>
    </tbody></table>
    <h2>Winners (<?= count($winners) ?>)</h2>
    <table><thead><tr><th>Prize Name</th><th>Winner Name</th><th>Email</th><th>Claim Time</th></tr></thead><tbody>
    <?php if (!$winners): ?><tr><td colspan="4">No winners yet.</td></tr><?php endif; ?>
    <?php foreach ($winners as $w): ?><tr><td><?= h(str_replace('_', ' ', $w['prize_type'])) ?></td><td><?= h($w['winner_name']) ?></td><td><?= h(mask_report_email($w['winner_email'])) ?></td><td><?= h(report_time($w['claimed_at'])) ?></td></tr><?php endforeach; ?>
    </tbody></table>
    <h2>Players in Room (<?= count($players) ?>)</h2>
    <table><thead><tr><th>Player Name</th><th>Email</th><th>Joined At</th></tr></thead><tbody>
    <?php if (!$players): ?><tr><td colspan="3">No players in this room.</td></tr><?php endif; ?>
    <?php foreach ($players as $p): ?><tr><td><?= h($p['name']) ?></td><td><?= h(mask_report_email($p['email'])) ?></td><td><?= h(report_time($p['joined_at'])) ?></td></tr><?php endforeach; ?>
    </tbody></table></body></html>
    <?php
    exit;
}

$title = 'Rooms';
$headers = ['Room Code','Title','Status','Host','Host Email','Players','Created','Started','Ended','Time taken'];
$rows = [];
if ($view === 'hosts') {
    $title = 'Hosts';
    $headers = ['Name','Email','Rooms Hosted','Last Hosted'];
    $rows = $pdo->query(
        'SELECT u.name,u.email,COUNT(r.id) AS rooms_hosted,MAX(r.created_at) AS last_hosted_at
         FROM users u JOIN rooms r ON r.host_user_id=u.id
         GROUP BY u.id,u.name,u.email ORDER BY rooms_hosted DESC'
    )->fetchAll();
} elseif ($view === 'players') {
    $title = 'Players';
    $headers = ['Name','Email','Rooms Joined','Last Joined'];
    $rows = $pdo->query(
        'SELECT u.name,u.email,COUNT(rp.id) AS rooms_joined,MAX(rp.joined_at) AS last_joined_at
         FROM users u JOIN room_players rp ON rp.user_id=u.id AND rp.is_active=1
         JOIN rooms joined_room ON joined_room.id=rp.room_id AND joined_room.host_user_id<>u.id
         GROUP BY u.id,u.name,u.email ORDER BY rooms_joined DESC'
    )->fetchAll();
} elseif ($view === 'users') {
    $title = 'Users';
    $headers = ['Name','Email','User Type','Joined Date'];
    $rows = $pdo->query(
        "SELECT u.name,u.email,CASE
           WHEN EXISTS(SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id)
            AND EXISTS(SELECT 1 FROM room_players rp JOIN rooms jr ON jr.id=rp.room_id WHERE rp.user_id=u.id AND rp.is_active=1 AND jr.host_user_id<>u.id) THEN 'Host + Player'
           WHEN EXISTS(SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id) THEN 'Host'
           ELSE 'Player' END AS user_type,u.created_at
         FROM users u
         WHERE EXISTS(SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id)
            OR EXISTS(SELECT 1 FROM room_players rp WHERE rp.user_id=u.id)
         ORDER BY u.created_at DESC"
    )->fetchAll();
} else {
    $title = 'Rooms';
    $sql = 'SELECT r.room_code,r.title,r.status,u.name AS host_name,u.email AS host_email,
                   (SELECT COUNT(*) FROM room_players rp WHERE rp.room_id=r.id AND rp.is_active=1) AS player_count,
                   r.created_at,r.started_at,r.ended_at
            FROM rooms r JOIN users u ON u.id=r.host_user_id';
    $args = [];
    if (in_array($status,['LOBBY','LIVE','PAUSED','COMPLETED'],true)) {
        if ($status === 'LIVE') $sql .= " WHERE r.status IN ('LIVE','PAUSED')";
        else { $sql .= ' WHERE r.status=?'; $args[]=$status; }
    }
    $sql .= ' ORDER BY r.created_at DESC';
    $q=$pdo->prepare($sql); $q->execute($args); $rooms=$q->fetchAll();
    foreach ($rooms as $r) {
        $rows[] = [
            'room_code'=>$r['room_code'], 'title'=>$r['title'], 'status'=>report_status((string)$r['status']),
            'host_name'=>$r['host_name'], 'host_email'=>mask_report_email($r['host_email']),
            'player_count'=>(int)$r['player_count'], 'created_at'=>report_time($r['created_at']),
            'started_at'=>report_time($r['started_at']), 'ended_at'=>report_time($r['ended_at']),
            'duration'=>report_duration($r['started_at'],$r['ended_at'],(string)$r['status'])
        ];
    }
}

header('Content-Type: text/html; charset=utf-8');
?>
<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Housiy <?= h($title) ?> Report</title>
<style>
body{font-family:Arial,sans-serif;color:#111;padding:24px}h1{font-size:20px;margin-bottom:4px}.meta{color:#666;font-size:12px;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;overflow-wrap:anywhere}th{background:#222;color:#fff}tr:nth-child(even){background:#f5f5f5}
@media print{.no-print{display:none}}
</style></head><body>
<button class="no-print" data-print>Print / Save as PDF</button><script src="/assets/js/print-report.js"></script>
<h1>Housiy Platform — <?= h($title) ?> Report</h1><div class="meta">Generated: <?= h((new DateTimeImmutable('now', new DateTimeZone('Asia/Kolkata')))->format('Y-m-d H:i:s') . ' IST') ?></div>
<table><thead><tr><?php foreach ($headers as $header): ?><th><?= h($header) ?></th><?php endforeach; ?></tr></thead><tbody>
<?php if (!$rows): ?><tr><td colspan="<?= count($headers) ?>">No records found.</td></tr><?php endif; ?>
<?php foreach ($rows as $row): ?><tr>
<?php foreach ($row as $key=>$value): ?>
<td><?= h((str_contains((string)$key,'email') ? mask_report_email($value) : (str_ends_with((string)$key,'_at') || in_array($key,['created_at','started_at','ended_at'],true) ? report_time($value) : $value))) ?></td>
<?php endforeach; ?>
</tr><?php endforeach; ?></tbody></table></body></html>
