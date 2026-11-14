<?php
declare(strict_types=1);
require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/FullHouse.php';
require_once __DIR__ . '/../includes/AdminAuth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/PublicEmailMask.php';
$admin = AdminAuth::requireAdmin();
RateLimiter::enforce('expensive', 'admin:' . $admin['id']);
$pdo = DB::conn();
$maskEmails = (string)($_GET['mask_emails'] ?? '1') !== '0';
function mask_export_email($email, bool $mask): string {
  $email = trim((string)($email ?? ''));
  if (!$mask || $email === '') return $email;
  $existingAt = strrpos($email, '@');
  if ($existingAt !== false && (str_contains(substr($email, 0, $existingAt), '*') || str_contains(substr($email, 0, $existingAt), '..'))) return $email;
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

function xls_mask_rows_intelligently(array $headers, array $rows): array {
  if (!$GLOBALS['maskEmails'] || !$rows) return $rows;
  // Room-detail exports pre-mask the player/winner group together so that
  // duplicate names are disambiguated consistently across sections. Do not
  // feed those already-masked values through the formatter a second time.
  foreach ($headers as $emailIndex => $header) {
    if (stripos((string)$header, 'email') === false) continue;
    foreach ($rows as $row) {
      $value = (string)($row[$emailIndex] ?? '');
      $at = strrpos($value, '@');
      if ($at !== false && (str_contains(substr($value, 0, $at), '*') || str_contains(substr($value, 0, $at), '..'))) {
        return $rows;
      }
    }
  }
  $nameIndex = null; $emailIndex = null;
  foreach ($headers as $i => $header) {
    $h = strtolower(trim((string)$header));
    if ($nameIndex === null && in_array($h, ['name','host','player','winner','host name','player name','winner name'], true)) $nameIndex = $i;
    if ($emailIndex === null && str_contains($h, 'email')) $emailIndex = $i;
  }
  if ($nameIndex === null || $emailIndex === null) return $rows;
  $people = [];
  foreach ($rows as $row) $people[] = ['name' => (string)($row[$nameIndex] ?? ''), 'email' => (string)($row[$emailIndex] ?? '')];
  [$people] = mask_room_public_people($people, []);
  foreach ($rows as $i => &$row) $row[$emailIndex] = $people[$i]['email'] ?? $row[$emailIndex];
  unset($row);
  return $rows;
}

function xls_table(string $title, array $headers, array $rows): string {
  $rows = xls_mask_rows_intelligently($headers, $rows);
  $html = '<h2>' . htmlspecialchars($title, ENT_QUOTES, 'UTF-8') . '</h2><table border="1"><thead><tr>';
  foreach ($headers as $h) $html .= '<th>' . htmlspecialchars($h, ENT_QUOTES, 'UTF-8') . '</th>';
  $html .= '</tr></thead><tbody>';
  foreach ($rows as $row) {
    $html .= '<tr>';
    foreach ($row as $i => $v) {
      $header = (string)($headers[$i] ?? '');
      if (stripos($header, 'email') !== false) {
        $v = mask_export_email($v, $GLOBALS['maskEmails']);
      } elseif (preg_match('/(created|started|ended|deleted|completed|claimed|joined|last hosted|last joined|date|time)/i', $header)) {
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
  $room = RoomAccess::findByCode($pdo, $roomCode, true);
  $host = $pdo->prepare('SELECT name,email FROM users WHERE id=?'); $host->execute([$room['host_user_id']]); $h = $host->fetch() ?: [];
  $reactionQ=$pdo->prepare('SELECT COUNT(*) FROM room_emoji_reactions WHERE room_id=?'); $reactionQ->execute([$room['id']]); $reactionCount=(int)$reactionQ->fetchColumn();
  $duration='—';
  if (!empty($room['started_at']) && !empty($room['ended_at'])) { $secs=max(0,strtotime($room['ended_at'].' UTC')-strtotime($room['started_at'].' UTC')); $duration=intdiv($secs,3600).'h '.intdiv($secs%3600,60).'m '.($secs%60).'s'; }
  $q=$pdo->prepare('SELECT rpw.prize_type,u.name,u.email,wc.claimed_at FROM room_prize_winners rpw JOIN winner_claims wc ON wc.id=rpw.winner_claim_id JOIN users u ON u.id=wc.user_id WHERE rpw.room_id=? ORDER BY rpw.awarded_at, rpw.id'); $q->execute([$room['id']]);
  $fhConfigured = FullHouse::configured($room);
  $winnerRows = [];
  foreach (FullHouse::annotate($q->fetchAll(PDO::FETCH_ASSOC)) as $w) {
    $prizeLabel = $w['prize_type'] . ($w['prize_type'] === 'FULL_HOUSE' && $fhConfigured > 1 ? ' #' . (int)$w['winner_position'] . ' of ' . $fhConfigured : '');
    $winnerRows[] = [$prizeLabel, $w['name'], $w['email'], $w['claimed_at']];
  }
  $q=$pdo->prepare('SELECT u.name,u.email,rp.joined_at,rp.is_active,rp.blocked_at FROM room_players rp JOIN users u ON u.id=rp.user_id WHERE rp.room_id=? ORDER BY rp.joined_at'); $q->execute([$room['id']]);
  $roomPlayers = $q->fetchAll(PDO::FETCH_ASSOC);
  $maskPeople = $roomPlayers;
  if ($maskEmails) {
    $maskPeople[] = ['name' => (string)($h['name'] ?? ''), 'email' => (string)($h['email'] ?? '')];
    $maskWinners = array_map(static fn($w) => ['winner_name' => $w['name'], 'winner_email' => $w['email']], FullHouse::annotate((function() use ($pdo, $room) { $q=$pdo->prepare('SELECT rpw.prize_type,u.name,u.email,wc.claimed_at FROM room_prize_winners rpw JOIN winner_claims wc ON wc.id=rpw.winner_claim_id JOIN users u ON u.id=wc.user_id WHERE rpw.room_id=? ORDER BY rpw.awarded_at, rpw.id'); $q->execute([$room['id']]); return $q->fetchAll(PDO::FETCH_ASSOC); })()));
    [$maskPeople, $maskWinners] = mask_room_public_people($maskPeople, $maskWinners);
    $maskedHost = array_pop($maskPeople);
    $h['email'] = $maskedHost['email'] ?? ($h['email'] ?? '');
    foreach ($maskWinners as $i => $mw) { if (isset($winnerRows[$i])) $winnerRows[$i][2] = $mw['winner_email'] ?? $winnerRows[$i][2]; }
  }
  $html .= xls_table('Room details', ['Room Code','Title','Status','Host','Host Email','Max Players','Created','Started','Ended','Deleted At','Duration','Reactions Count'], [[ $room['room_code'] ?? $roomCode, $room['title'] ?? '', (!empty($room['deleted_at']) ? 'Deleted' : ($room['status'] ?? '')), $h['name'] ?? '', $h['email'] ?? '', $room['max_players'] ?? '', $room['created_at'] ?? '', $room['started_at'] ?? '', $room['ended_at'] ?? '', $room['deleted_at'] ?? '', $duration, $reactionCount ]]);
  $html .= xls_table('Winners', ['Prize','Winner','Email','Claimed At'], $winnerRows);
  $playerRows = [];
  foreach ($maskPeople as $player) {
    $playerName = (string)$player['name'];
    if (!empty($player['blocked_at'])) $playerName .= ' (Blocked: ' . xls_time_ist($player['blocked_at']) . ')';
    $playerRows[] = [$player['name'], $player['email'], $player['joined_at'], (int)$player['is_active'] === 1 ? 'Active' : 'Inactive', $player['blocked_at']];
  }
  $html .= xls_table('Players in room (' . count($playerRows) . ')', ['Player Name','Email','Joined Date','Current Status','Blocked At'], $playerRows);
  $filename='housiy_room_' . preg_replace('/[^A-Za-z0-9_-]/','',strtoupper($roomCode));
} elseif ($view === 'hosts') {
  $rows=$pdo->query("SELECT u.name,u.email,COUNT(r.id),MAX(r.created_at),(SELECT MAX(ub.updated_at) FROM user_blocks ub WHERE ub.user_id=u.id OR ub.email_normalized=LOWER(TRIM(u.email))),(CASE WHEN EXISTS(SELECT 1 FROM user_blocks ub WHERE ub.user_id=u.id OR ub.email_normalized=LOWER(TRIM(u.email))) THEN 'Blocked' ELSE 'Active' END),(SELECT CONCAT(ube.event_type,' ',DATE_FORMAT(ube.event_at,'%Y-%m-%d %H:%i:%s')) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email) ORDER BY ube.event_at DESC,ube.id DESC LIMIT 1),(SELECT COUNT(*) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email)) FROM users u LEFT JOIN rooms r ON r.host_user_id=u.id WHERE u.ever_hosted=1 GROUP BY u.id,u.name,u.email ORDER BY COUNT(r.id) DESC")->fetchAll(PDO::FETCH_NUM);
  $html .= xls_table('Hosts', ['Host','Email','Rooms Hosted','Last Hosted','Last Block Timestamp','Current Status','Last Block Event','Block Events'], $rows);
} elseif ($view === 'players') {
  $rows=$pdo->query("SELECT u.name,u.email,(SELECT r2.room_code FROM room_players rp2 JOIN rooms r2 ON r2.id=rp2.room_id WHERE rp2.user_id=u.id AND r2.host_user_id<>u.id ORDER BY rp2.joined_at DESC LIMIT 1),(SELECT MAX(rp2.joined_at) FROM room_players rp2 JOIN rooms r2 ON r2.id=rp2.room_id WHERE rp2.user_id=u.id AND r2.host_user_id<>u.id),(SELECT MAX(ub.updated_at) FROM user_blocks ub WHERE ub.user_id=u.id OR ub.email_normalized=LOWER(TRIM(u.email))),(CASE WHEN EXISTS(SELECT 1 FROM user_blocks ub WHERE ub.user_id=u.id OR ub.email_normalized=LOWER(TRIM(u.email))) THEN 'Blocked' ELSE 'Active' END),(SELECT CONCAT(ube.event_type,' ',DATE_FORMAT(ube.event_at,'%Y-%m-%d %H:%i:%s')) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email) ORDER BY ube.event_at DESC,ube.id DESC LIMIT 1),(SELECT COUNT(*) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email)) FROM users u WHERE u.ever_played=1 ORDER BY u.created_at DESC")->fetchAll(PDO::FETCH_NUM);
  $html .= xls_table('Players', ['Player','Email','Last Joined Room ID','Joined Date','Last Block Timestamp','Current Status','Last Block Event','Block Events'], $rows);
} elseif ($view === 'users') {
  $rows=$pdo->query("SELECT u.name,u.email,CASE WHEN u.ever_hosted=1 AND u.ever_played=1 THEN 'Host + Player' WHEN u.ever_hosted=1 THEN 'Host' ELSE 'Player' END,u.created_at,(SELECT MAX(ub.updated_at) FROM user_blocks ub WHERE ub.user_id=u.id OR ub.email_normalized=LOWER(TRIM(u.email))),(CASE WHEN EXISTS(SELECT 1 FROM user_blocks ub WHERE ub.user_id=u.id OR ub.email_normalized=LOWER(TRIM(u.email))) THEN 'Blocked' ELSE 'Active' END),(SELECT CONCAT(ube.event_type,' ',DATE_FORMAT(ube.event_at,'%Y-%m-%d %H:%i:%s')) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email) ORDER BY ube.event_at DESC,ube.id DESC LIMIT 1),(SELECT COUNT(*) FROM user_block_events ube WHERE ube.user_id=u.id OR LOWER(ube.email_snapshot)=LOWER(u.email)) FROM users u WHERE u.ever_hosted=1 OR u.ever_played=1 ORDER BY u.created_at DESC")->fetchAll(PDO::FETCH_NUM);
  $html .= xls_table('Users', ['Name','Email','User Type','Joined Date','Last Block Timestamp','Current Status','Last Block Event','Block Events'], $rows);
} else {
  $sql="SELECT r.room_code,r.title,CASE WHEN r.deleted_at IS NOT NULL THEN 'DELETED' ELSE r.status END,u.name,u.email,(SELECT COUNT(*) FROM room_players rp WHERE rp.room_id=r.id AND rp.is_active=1),r.created_at,r.started_at,r.ended_at,r.deleted_at FROM rooms r JOIN users u ON u.id=r.host_user_id"; $args=[];
  if (in_array($status,['LOBBY','LIVE','PAUSED','COMPLETED'],true)) { if ($status==='LIVE') $sql .= " WHERE r.deleted_at IS NULL AND r.status IN ('LIVE','PAUSED')"; else { $sql .= ' WHERE r.deleted_at IS NULL AND r.status=?'; $args[]=$status; } }
  $sql.=' ORDER BY r.created_at DESC'; $q=$pdo->prepare($sql);$q->execute($args);
  $roomRows=$q->fetchAll(PDO::FETCH_NUM);
  foreach ($roomRows as &$rr) { $secs=(!empty($rr[7]) && !empty($rr[8])) ? max(0,strtotime($rr[8].' UTC')-strtotime($rr[7].' UTC')) : null; $rr[]=$secs===null?'—':(intdiv($secs,3600).'h '.intdiv($secs%3600,60).'m '.($secs%60).'s'); } unset($rr);
  $html .= xls_table('Rooms', ['Room ID','Title','Status','Host','Host Email','Players','Created Date','Started At','Completed At','Deleted At','Duration'], $roomRows);
}
$html .= '</body></html>';
header('Content-Type: application/vnd.ms-excel; charset=utf-8');
header('Content-Disposition: attachment; filename="' . $filename . '_' . date('Ymd_His') . '.xls"');
header('Cache-Control: no-store');
echo $html;
