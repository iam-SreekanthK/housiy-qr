<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';

/**
 * Called by the WebSocket gateway (never by browsers directly) with the
 * connecting browser's own cookies, to authorise a room subscription with
 * exactly the same rules as results.php: logged-in user who is the host
 * or a player of the room. Returns only the caller's own identity.
 */
$user = Auth::requireUser();
RateLimiter::enforce('ws_connect_user', 'u:' . $user['id']);
// The per-IP layer only means something when the real client address is known
// (gateway forwarded a chain AND the peer is a trusted proxy). Otherwise every
// handshake would be charged to the gateway's own address and one busy room
// could starve everyone else, so only the per-user layer applies then.
if (RateLimiter::clientIp() !== (string)($_SERVER['REMOTE_ADDR'] ?? '')) {
    RateLimiter::enforce('ws_connect_ip', RateLimiter::clientIp());
}
$room = RoomAccess::findByCode(DB::conn(), (string)($_GET['room_code'] ?? ''));
RoomAccess::requireMember(DB::conn(), $room, $user);

json_ok(['user_id' => (int)$user['id'], 'room_id' => (int)$room['id'], 'room_code' => $room['room_code']]);
