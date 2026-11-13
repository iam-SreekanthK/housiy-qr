<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../includes/AdminAuth.php';

require_post();
AdminAuth::logout();
json_ok();
