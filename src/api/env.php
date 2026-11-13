<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';

/**
 * Reports ONLY the canonical environment name (dev|uat|prod). Used by the
 * load/E2E tooling to prove it is aimed at the environment it thinks it is
 * before running anything destructive. Exposes no version, host, or config.
 */
json_ok(['env' => AppEnv::name()]);
