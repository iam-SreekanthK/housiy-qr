<?php
declare(strict_types=1);

// Global constants (PRIZE_TYPES, etc.) and helper functions live in
// src/config/app.php and are required by every class under test
// (e.g. ClaimValidator::validate() reads PRIZE_TYPES). Every real API
// entrypoint includes this file first, so the test bootstrap must too -
// it is NOT pulled in by the composer classmap autoloader, which only
// autoloads classes on demand, never procedural/constant files.
putenv('APP_ENV=testing');
require_once __DIR__ . '/../src/config/app.php';

$autoload = __DIR__ . '/../vendor/autoload.php';
if (file_exists($autoload)) {
    require_once $autoload;
} else {
    // Fallback if composer install hasn't been run: manually require the
    // classes under test so `phpunit` still works.
    foreach (glob(__DIR__ . '/../src/includes/*.php') as $file) {
        require_once $file;
    }
}
