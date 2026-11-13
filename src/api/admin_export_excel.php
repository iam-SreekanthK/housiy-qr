<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/FullHouse.php';
require_once __DIR__ . '/../includes/AdminAuth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
$admin = AdminAuth::requireAdmin();
RateLimiter::enforce('expensive', 'admin:' . $admin['id']);
$pdo = DB::conn();
$maskEmails = (string)($_GET['mask_emails'] ?? '1') !== '0';
function mask_export_email($email, bool $mask): string {
  $email = trim((string)($email ?? ''));
  if (!$mask || $email === '') return $email;
  $at = strrpos($email, '@');
  if ($at === false || $at === 0 || $at === strlen($email) - 1) return '***';
  $local = substr($email, 0, $at); $domain = substr($email, $at + 1); $length = strlen($local);
  if ($length <= 1) $masked = '*';
  elseif ($length <= 4) $masked = substr($local, 0, 1) . str_repeat('*', max(1, $length - 1));
  else $masked = substr($local, 0, 2) . '..' . substr($local, -2);
  return $masked . '@' . $domain;
}

function xls_cell($v): string { return '<td>' . htmlspecialchars((string)($v ?? ''), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</td>'; }
function xls_time_ist($value): string {
  if ($value === null || $value === '') return '—';
  try {
    return (new DateTimeImmutable((string)$value, new DateTimeZone('UTC')))
      ->setTimezone(new DateTimeZone('Asia/Kolkata'))
      ->format('d-m-Y H:i:s') . ' IST';
  } catch (Throwable $e) {
    return (string)$value;
  }
}
function xls_table(string $title, array $headers, array $rows): string {
  $html = '<h2>' . htmlspecialchars($title, ENT_QUOTES, 'UTF-8') . '</h2><table border="1"><thead><tr>';
  foreach ($headers as $h) $html .= '<th>' . htmlspecialchars($h, ENT_QUOTES, 'UTF-8') . '</th>';
  $html .= '</tr></thead><tbody>';
  foreach ($rows as $row) {
    $html .= '<tr>';
    foreach ($row as $i => $v) {
      $header = (string)($headers[$i] ?? '');
      if (stripos($header, 'email') !== false) {
        $v = mask_export_email($v, $GLOBALS['maskEmails']);
      } elseif (preg_match('/(created|started|ended|completed|claimed|joined|last hosted|last joined|date|time)/i', $header)) {
        $v = xls_time_ist($v);
      }
      $html .= xls_cell($v);
    }
    $html .= '</tr>';
  }
  return $html . '</tbody></table><br>';
}
$view = strtolower((string)($_GET['view'] ?? 'rooms'));
$status = strtoupper((string)($_GET['status'] ?? ''));
$roomCode = trim((string)($_GET['room_code'] ?? ''));
$html = '<!doctype html><html><head><meta charset="utf-8"></head><body>';
$filename = 'housiy_' . preg_replace('/[^a-z0-9_-]/i', '', $view ?: 'report');
if ($roomCode !== '') {
  $room = RoomAccess::findByCode($pdo, $roomCode);
  $host = $pdo->prepare('SELECT name,email FROM users WHERE id=?'); $host->execute([$room['host_user_id']]); $h = $host->fetch() ?: [];
  $reactionQ=$pdo->prepare('SELECT COUNT(*) FROM room_emoji_reactions WHERE room_id=?'); $reactionQ->execute([$room['id']]); $reactionCount=(int)$reactionQ->fetchColumn();
  $duration='—';
  if (!empty($room['started_at']) && !empty($room['ended_at'])) { $secs=max(0,strtotime($room['ended_at'].' UTC')-strtotime($room['started_at'].' UTC')); $duration=intdiv($secs,3600).'h '.intdiv($secs%3600,60).'m '.($secs%60).'s'; }
  $html .= xls_table('Room details', ['Room Code','Title','Status','Host','Host Email','Max Players','Created','Started','Ended','Duration','Reactions Count'], [[ $room['room_code'] ?? $roomCode, $room['title'] ?? '', $room['status'] ?? '', $h['name'] ?? '', $h['email'] ?? '', $room['max_players'] ?? '', $room['created_at'] ?? '', $room['started_at'] ?? '', $room['ended_at'] ?? '', $duration, $reactionCount ]]);
  $q=$pdo->prepare('SELECT rpw.prize_type,u.name,u.email,wc.claimed_at FROM room_prize_winners rpw JOIN winner_claims wc ON wc.id=rpw.winner_claim_id JOIN users u ON u.id=wc.user_id WHERE rpw.room_id=? ORDER BY rpw.awarded_at, rpw.id'); $q->execute([$room['id']]);
  $fhConfigured = FullHouse::configured($room);
  $winnerRows = [];
  foreach (FullHouse::annotate($q->fetchAll(PDO::FETCH_ASSOC)) as $w) {
    $prizeLabel = $w['prize_type'] . ($w['prize_type'] === 'FULL_HOUSE' && $fhConfigured > 1 ? ' #' . (int)$w['winner_position'] . ' of ' . $fhConfigured : '');
    $winnerRows[] = [$prizeLabel, $w['name'], $w['email'], $w['claimed_at']];
  }
  $html .= xls_table('Winners', ['Prize','Winner','Email','Claimed At'], $winnerRows);
  $q=$pdo->prepare('SELECT u.name,u.email,rp.joined_at FROM room_players rp JOIN users u ON u.id=rp.user_id WHERE rp.room_id=? ORDER BY rp.joined_at'); $q->execute([$room['id']]);
  $html .= xls_table('Players in room', ['Player','Email','Joined Date'], $q->fetchAll(PDO::FETCH_NUM));
  $filename='housiy_room_' . preg_replace('/[^A-Za-z0-9_-]/','',strtoupper($roomCode));
} elseif ($view === 'hosts') {
  $rows=$pdo->query('SELECT u.name,u.email,COUNT(r.id),MAX(r.created_at) FROM users u JOIN rooms r ON r.host_user_id=u.id GROUP BY u.id,u.name,u.email ORDER BY COUNT(r.id) DESC')->fetchAll(PDO::FETCH_NUM);
  $html .= xls_table('Hosts', ['Host','Email','Rooms Hosted','Last Hosted'], $rows);
} elseif ($view === 'players') {
  $rows=$pdo->query('SELECT u.name,u.email,(SELECT r2.room_code FROM room_players rp2 JOIN rooms r2 ON r2.id=rp2.room_id WHERE rp2.user_id=u.id ORDER BY rp2.joined_at DESC LIMIT 1),MAX(rp.joined_at) FROM users u JOIN room_players rp ON rp.user_id=u.id WHERE NOT EXISTS(SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id) GROUP BY u.id,u.name,u.email ORDER BY MAX(rp.joined_at) DESC')->fetchAll(PDO::FETCH_NUM);
  $html .= xls_table('Players', ['Player','Email','Last Joined Room ID','Joined Date'], $rows);
} elseif ($view === 'users') {
  $rows=$pdo->query("SELECT u.name,u.email,CASE WHEN EXISTS(SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id) THEN 'Host' WHEN EXISTS(SELECT 1 FROM room_players rp WHERE rp.user_id=u.id) THEN 'Player' ELSE 'Player' END,u.created_at FROM users u WHERE EXISTS(SELECT 1 FROM rooms hr WHERE hr.host_user_id=u.id) OR EXISTS(SELECT 1 FROM room_players rp WHERE rp.user_id=u.id) ORDER BY u.created_at DESC")->fetchAll(PDO::FETCH_NUM);
  $html .= xls_table('Users', ['Name','Email','User Type','Joined Date'], $rows);
} else {
  $sql='SELECT r.room_code,r.title,r.status,u.name,u.email,(SELECT COUNT(*) FROM room_players rp WHERE rp.room_id=r.id AND rp.is_active=1),r.created_at,r.started_at,r.ended_at FROM rooms r JOIN users u ON u.id=r.host_user_id'; $args=[];
  if (in_array($status,['LOBBY','LIVE','PAUSED','COMPLETED'],true)) { if ($status==='LIVE') $sql .= " WHERE r.status IN ('LIVE','PAUSED')"; else { $sql .= ' WHERE r.status=?'; $args[]=$status; } }
  $sql.=' ORDER BY r.created_at DESC'; $q=$pdo->prepare($sql);$q->execute($args);
  $roomRows=$q->fetchAll(PDO::FETCH_NUM);
  foreach ($roomRows as &$rr) { $secs=(!empty($rr[7]) && !empty($rr[8])) ? max(0,strtotime($rr[8].' UTC')-strtotime($rr[7].' UTC')) : null; $rr[]=$secs===null?'—':(intdiv($secs,3600).'h '.intdiv($secs%3600,60).'m '.($secs%60).'s'); } unset($rr);
  $html .= xls_table('Rooms', ['Room ID','Title','Status','Host','Host Email','Players','Created Date','Started At','Completed At','Duration'], $roomRows);
}
$html .= '</body></html>';
header('Content-Type: application/vnd.ms-excel; charset=utf-8');
header('Content-Disposition: attachment; filename="' . $filename . '_' . date('Ymd_His') . '.xls"');
header('Cache-Control: no-store');
echo $html;
