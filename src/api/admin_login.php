<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../includes/AdminAuth.php';

require_post();
$body = json_body();
$username = (string)($body['username'] ?? '');
$password = (string)($body['password'] ?? '');

try {
    $admin = AdminAuth::login($username, $password);
} catch (InvalidArgumentException $e) {
    json_error($e->getMessage(), 401);
}

json_ok(['admin' => $admin]);
