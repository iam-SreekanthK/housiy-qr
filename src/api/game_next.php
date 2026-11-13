<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/GameEngine.php';

require_post();
$user = Auth::requireUser();
RateLimiter::enforce('game_next', 'u:' . $user['id']);
$body = json_body();
$roomCode = strtoupper(trim((string)($body['room_code'] ?? '')));
if ($roomCode === '' || strlen($roomCode) > 32) {
    json_error('Invalid room code.');
}

$pdo = DB::conn();
$roomLookupSpan = EndpointProfiler::start('game_next.room_lookup');
$room = RoomAccess::findByCode($pdo, $roomCode);
EndpointProfiler::stop($roomLookupSpan);
RoomAccess::requireHost($room, $user);
$gameLookupSpan = EndpointProfiler::start('game_next.game_lookup');
$game = GameEngine::getOrCreateGame($pdo, (int)$room['id']);
EndpointProfiler::stop($gameLookupSpan);

$callSpan = EndpointProfiler::start('game_next.call_next');
try {
    $result = GameEngine::callNext($pdo, $room, $game, (int)$user['id']);
    EndpointProfiler::stop($callSpan);
} catch (RuntimeException $e) {
    EndpointProfiler::stop($callSpan);
    json_error($e->getMessage(), 409);
} catch (Throwable $e) {
    EndpointProfiler::stop($callSpan);
    error_log('[game_next] ' . $e->getMessage());
    json_error('Failed to call the next number.', 500);
}

json_ok($result);
