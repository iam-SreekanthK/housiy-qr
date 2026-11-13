<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/GameEngine.php';

require_post();
$user = Auth::requireUser();
RateLimiter::enforce('game_control', 'u:' . $user['id']);
$body = json_body();
$roomCode = (string)($body['room_code'] ?? '');

$pdo = DB::conn();
$room = RoomAccess::findByCode($pdo, $roomCode);
RoomAccess::requireHost($room, $user);
$game = GameEngine::getOrCreateGame($pdo, (int)$room['id']);

try {
    GameEngine::resume($pdo, $room, $game, (int)$user['id']);
} catch (RuntimeException $e) {
    json_error($e->getMessage(), 409);
}

json_ok(['status' => 'RUNNING']);
