<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/AdminAuth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/GameEngine.php';

require_post();
$admin = AdminAuth::requireAdmin();
$body = json_body();
$roomCode = (string)($body['room_code'] ?? '');

$pdo = DB::conn();
$room = RoomAccess::findByCode($pdo, $roomCode);
$game = GameEngine::getOrCreateGame($pdo, (int)$room['id']);

GameEngine::end($pdo, $room, $game, 'SUPER_ADMIN', (int)$admin['id']);

json_ok(['status' => 'COMPLETED']);
