<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/GameEngine.php';
require_once __DIR__ . '/../includes/RoomState.php';
require_once __DIR__ . '/../includes/FullHouse.php';
require_once __DIR__ . '/../includes/PublicEmailMask.php';

$user = Auth::requireUser();
RateLimiter::enforce('state_read', 'u:' . $user['id']);
$roomCode = (string)($_GET['room_code'] ?? '');

$pdo = null;
$db = function () use (&$pdo): PDO {
    return $pdo ??= DB::conn();
};

$state = RoomState::load($db, $roomCode);
$room = $state['room'];
RoomState::requireMember($db, $room, $user);

// Drive auto-call from here (see GameEngine::autoCallIfDue docblock) so the
// game keeps progressing even if the host's own tab has gone idle -
// anyone's poll (host or player) can be the one that fires the next call.
//
// When the dedicated auto-call worker is alive it owns this job, so polls
// skip the row-locking transaction entirely. If the worker is down this
// falls straight back to the original poll-driven behaviour.
$workerCheck = EndpointProfiler::start('results.worker_alive_check');
$workerAlive = Realtime::workerAlive();
EndpointProfiler::stop($workerCheck);
if (!$workerAlive) {
    $autoCallSpan = EndpointProfiler::start('results.auto_call_fallback');
    $autoCallResult = GameEngine::autoCallIfDue($db(), $room);
    EndpointProfiler::stop($autoCallSpan);

    // Most fallback polls do not have a due call. Avoid flushing Redis and
    // reloading the complete room read model unless this request actually
    // committed a number call. When a call does happen, bump the version
    // before reloading so this response reflects the committed state.
    if ($autoCallResult !== null) {
        Realtime::flush();
        $reloadSpan = EndpointProfiler::start('results.room_state_reload');
        $state = RoomState::load($db, $roomCode);
        EndpointProfiler::stop($reloadSpan);
        $room = $state['room'];
    }
}

$game = $state['game'];
$fullHouseProgress = FullHouse::progress($room, $state['winners'] ?? [], (int)($state['player_count'] ?? 0));
$autoCallSecondsRemaining = GameEngine::autoCallSecondsRemaining($room, $game, $state['last_called_at'] ?? null, $state['winners'] ?? []);

// A rematch prompt is a one-time invitation, not a property of revisiting a
// completed room. Suppress it after this user joins the new room or declines.
$rematchPromptPending = false;
$rematchRoomCode = trim((string)($room['rematch_room_code'] ?? ''));
if ($rematchRoomCode !== '') {
    $decisionStmt = $db()->prepare(
        'SELECT
            EXISTS(SELECT 1 FROM room_rematch_declines d WHERE d.room_id = ? AND d.user_id = ? AND d.rematch_room_code = ?) AS declined,
            EXISTS(SELECT 1 FROM rooms nr JOIN room_players np ON np.room_id = nr.id WHERE nr.room_code = ? AND np.user_id = ?) AS joined,
            (SELECT nr.status FROM rooms nr WHERE nr.room_code = ? LIMIT 1) AS rematch_status'
    );
    $decisionStmt->execute([
        (int)$room['id'], (int)$user['id'], $rematchRoomCode,
        $rematchRoomCode, (int)$user['id'], $rematchRoomCode
    ]);
    $decision = $decisionStmt->fetch(PDO::FETCH_ASSOC) ?: [];
    // The invitation is only actionable while the newly-created room is still
    // waiting in its lobby. Once it goes LIVE, PAUSED, COMPLETED or CANCELLED,
    // reopening the old completed room must not resurrect a stale invitation.
    $rematchPromptPending = strtoupper((string)($decision['rematch_status'] ?? '')) === 'LOBBY'
        && empty($decision['declined'])
        && empty($decision['joined']);
}

// All public game surfaces use the same room-wide mask, including collision handling.
$maskingSpan = EndpointProfiler::start('results.email_masking');
[$publicPlayers, $publicWinners] = mask_room_public_people($state['players'], $state['winners']);
EndpointProfiler::stop($maskingSpan);

json_ok([
    'room' => [
        'room_code' => $room['room_code'],
        'title' => $room['title'],
        'status' => $room['status'],
        'player_count' => $state['player_count'],
        'max_players' => (int)$room['max_players'],
        'prizes_enabled' => json_decode($room['prizes_enabled'], true),
        // Full House winner slots (1 unless the host chose more). Total is capped
        // at the player count; remaining drops as each winner is awarded.
        'full_house_winners' => FullHouse::configured($room),
        'full_house_total' => $fullHouseProgress['total'],
        'full_house_remaining' => $fullHouseProgress['remaining'],
        'auto_call_enabled' => (bool)($room['auto_call_enabled'] ?? false),
        'auto_call_interval_seconds' => $room['auto_call_interval_seconds'] !== null ? (int)$room['auto_call_interval_seconds'] : null,
        'auto_call_seconds_remaining' => $autoCallSecondsRemaining,
        'rematch_room_code' => $room['rematch_room_code'] ?? null,
        'rematch_prompt_pending' => $rematchPromptPending,
        // UTC (as stored) - the client converts these to the viewer's own
        // local time zone for display; never format dates server-side.
        'created_at' => $room['created_at'],
        'started_at' => $room['started_at'],
        'ended_at' => $room['ended_at'],
    ],
    'game' => [
        'status' => $game['status'],
        'current_number' => $game['current_number'] !== null ? (int)$game['current_number'] : null,
        'numbers_called_count' => (int)$game['numbers_called_count'],
        'started_at' => $game['started_at'],
        'ended_at' => $game['ended_at'] ?? null,
        'server_now' => date('Y-m-d H:i:s'),
    ],
    'called_numbers' => $state['called'],
    'winners' => $publicWinners,
    'players' => $publicPlayers,
]);
