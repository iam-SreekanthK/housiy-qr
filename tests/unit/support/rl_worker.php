<?php
// Child process for RateLimiterTest: charges one policy/subject N times, prints how many were allowed.
declare(strict_types=1);
require_once __DIR__ . '/../../../src/config/app.php';
require_once __DIR__ . '/../../../src/includes/RateLimiter.php';
[, $policy, $subject, $n] = $argv;
$allowed = 0;
for ($i = 0; $i < (int)$n; $i++) {
    if (RateLimiter::hit($policy, $subject)['allowed']) {
        $allowed++;
    }
}
echo $allowed;
