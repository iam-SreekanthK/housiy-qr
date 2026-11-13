<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/Reactions.php';

/**
 * Room-scoped emoji reactions.
 *
 *   GET  ?action=players   other active players (for "specific player")
 *   GET  ?action=history   this user's sent + received + room-wide reactions
 *   GET  ?action=latest    cursor baseline (so old reactions are not replayed)
 *   GET  ?action=poll&after=N   reactions newer than N visible to this user
 *   POST {room_code, emoji, target: everyone|player, recipient_id?}
 *
 * Everyone-reactions are visible to all members of the room; private ones
 * only to their sender and recipient.
 *
 * MySQL is opened lazily: with Redis up and the room warm, none of the
 * actions above run a single MySQL query (see ReactionBuffer).
 */
$method = (string)($_SERVER['REQUEST_METHOD'] ?? 'GET');
if (!in_array($method, ['GET', 'POST'], true)) {
    json_error('Method not allowed.', 405);
}

$user = Auth::requireUser();
// The frontend sends JSON, so room_code is not present in $_POST.
$requestBody = $method === 'POST' ? json_body() : [];
$roomCode = strtoupper(trim((string)($_GET['room_code'] ?? ($_POST['room_code'] ?? ($requestBody['room_code'] ?? '')))));
if ($roomCode === '') {
    json_error('Room code is required.');
}

$db = static fn(): PDO => DB::conn();
$room = Reactions::roomFor($db, $roomCode);
Reactions::requireActiveMember($db, $room, $user);
$roomId = (int)$room['id'];
$userId = (int)$user['id'];
$status = (string)$room['status'];
$endedAt = isset($room['ended_at']) && $room['ended_at'] ? strtotime((string)$room['ended_at']) : false;
$reactionGraceUntil = ($endedAt !== false && $endedAt > 0) ? ($endedAt + 10) : null;

if ($method === 'GET') {
    RateLimiter::enforce('reaction_read', 'u:' . $user['id']);
    $action = (string)($_GET['action'] ?? 'poll');
    if ($action === 'players') {
        json_ok(['players' => Reactions::players($db, $roomId, $userId)]);
    }
    if ($action === 'history') {
        // Return only this user's view: everyone-reactions + their own sent/received.
        json_ok(['history' => Reactions::historyFor($db, $roomId, $userId), 'history_count' => Reactions::countFor($db, $roomId, $userId), 'room_status' => $status, 'reaction_grace_until' => $reactionGraceUntil]);
    }
    if ($action === 'count') {
        json_ok(['history_count' => Reactions::countFor($db, $roomId, $userId), 'room_status' => $status, 'reaction_grace_until' => $reactionGraceUntil]);
    }
    if ($action === 'latest') {
        json_ok(['latest_id' => Reactions::latestFor($db, $roomId, $userId), 'room_status' => $status, 'reaction_grace_until' => $reactionGraceUntil]);
    }
    json_ok(['reactions' => Reactions::pollFor($db, $roomId, $userId, (int)($_GET['after'] ?? 0)), 'room_status' => $status, 'reaction_grace_until' => $reactionGraceUntil]);
}

if (Reactions::isClosed($status)) {
    // Permit winner-celebration reactions for ten seconds after the room's
    // authoritative completion timestamp. Client-side timers are not trusted.
    $endedAt = isset($room['ended_at']) ? strtotime((string)$room['ended_at']) : false;
    $graceActive = $endedAt !== false && $endedAt > 0 && time() <= ($endedAt + 10);
    if (!$graceActive) {
        json_error('Reactions are disabled because this game has ended.', 409);
    }
}

$emoji = (string)($requestBody['emoji'] ?? '');
if (!Reactions::isAllowedEmoji($emoji)) {
    json_error('Invalid emoji.');
}

$idempotencyKey = strtolower(trim((string)($requestBody['idempotency_key'] ?? '')));
if ($idempotencyKey !== '' && !preg_match('/^[a-f0-9]{32}$/', $idempotencyKey)) {
    json_error('Invalid idempotency key.');
}

// Fast replay path: a committed WS reaction retried over HTTP returns its original ID.
if ($idempotencyKey !== '') {
    $existingId = Reactions::findIdempotent($db, $roomId, $userId, $idempotencyKey);
    if ($existingId !== null) {
        json_ok(['id' => $existingId, 'idempotent_replay' => true]);
    }
}

// Count only new sends against the rate limit; exact retries must be replayable.
RateLimiter::enforce('reaction_send', 'u:' . $user['id']);

$audience = Reactions::audienceFor($requestBody['target'] ?? 'everyone');
$recipientId = null;
$recipientName = null;
if ($audience === Reactions::AUDIENCE_PLAYER) {
    $recipientId = (int)($requestBody['recipient_id'] ?? 0);
    $err = Reactions::recipientError($recipientId, $userId);
    if ($err !== null) {
        json_error($err);
    }
    $find = static function (array $list) use ($recipientId): ?string {
        foreach ($list as $p) {
            if ($p['id'] === $recipientId) {
                return $p['name'];
            }
        }
        return null;
    };
    $recipientName = $find(Reactions::roomPlayers($db, $roomId));
    if ($recipientName === null) { // possibly joined within the cache window
        $recipientName = $find(Reactions::roomPlayers($db, $roomId, true));
    }
    if ($recipientName === null) {
        json_error('That player is not active in this room.', 404);
    }
}

// Follow the global rate-limit switch for the reaction-specific cooldown.
// The cooldown can be bypassed only where RateLimiter::enabled() is false
// (DEV/UAT with RATE_LIMIT_ENABLED=0). It remains active in PROD.
if (
    RateLimiter::enabled()
    && !Reactions::cooldownPassed($db, $roomId, $userId)
) {
    // A concurrent duplicate may have committed while this request waited on
    // the cooldown. Recheck the durable idempotency record before rejecting.
    $existingId = $idempotencyKey !== '' ? Reactions::findIdempotent($db, $roomId, $userId, $idempotencyKey) : null;
    if ($existingId !== null) json_ok(['id' => $existingId, 'idempotent_replay' => true]);
    json_error('Please wait a moment before sending another reaction.', 429);
}

$id = Reactions::store($db, $roomId, $user, $recipientId, $recipientName, $audience, $emoji, (string)$room['room_code'], $idempotencyKey);
// Fast path: publish immediately after the MySQL transaction commits. If Redis
// is unavailable, the committed outbox row remains pending for worker retry.
try {
    // Replays return the original committed ID and must not create a second event.
    if (Reactions::lastStoreWasReplay()) {
        json_ok(['id' => $id, 'idempotent_replay' => true]);
    }
    // Publish the committed payload from request memory: no extra outbox
    // SELECT/UPDATE on the user-facing request. The worker retries and marks
    // durable outbox rows in batches; duplicate delivery is ID-deduplicated.
    if (!Reactions::publishImmediateReaction($id)) {
        error_log('[reactions] immediate publish unavailable; durable outbox will retry');
    }
} catch (Throwable $e) {
    error_log('[reactions] immediate publish deferred to durable outbox: ' . $e->getMessage());
}
json_ok(['id' => $id, 'idempotent_replay' => false]);
