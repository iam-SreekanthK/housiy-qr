<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/RateLimiter.php';

final class AdminAuth
{
    public static function login(string $username, string $password): array
    {
        app_session_start();
        $pdo = DB::conn();
        $ip = RateLimiter::clientIp();
        $userKey = strtolower(trim($username));

        // Charge BEFORE the (expensive, bcrypt) check, atomically in Redis, so
        // a burst of parallel guesses cannot all slip through a check-then-
        // record gap. Fails CLOSED (503) if Redis is down. Two independent
        // counters: per client IP and per target username (the latter stops
        // a distributed guesser; the trade-off is that someone who knows the
        // admin username can lock it out for one window - see docs).
        RateLimiter::enforce('admin_login_ip', $ip);
        RateLimiter::enforce('admin_login_user', $userKey);

        $stmt = $pdo->prepare('SELECT * FROM admin_users WHERE username = ? AND is_active = 1 LIMIT 1');
        $stmt->execute([trim($username)]);
        $admin = $stmt->fetch();

        // Constant-shape check even when user not found, to reduce
        // username-enumeration timing signal.
        $hash = $admin['password_hash'] ?? '$2y$10$invalidsaltinvalidsaltinvalidsalte';
        $ok = password_verify($password, $hash);

        if (!$admin || !$ok) {
            throw new InvalidArgumentException('Invalid username or password.');
        }

        // Successful login clears this IP's / username's attempt counters.
        RateLimiter::reset('admin_login_ip', $ip);
        RateLimiter::reset('admin_login_user', $userKey);

        // Regenerate the session ID on privilege escalation so a session
        // ID an attacker fixated before login (e.g. via a shared/public
        // machine or a crafted link) cannot be reused to inherit the
        // now-authenticated admin session. Keep the session data, just
        // rotate the identifier and drop the old session from storage.
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_regenerate_id(true);
        }

        $_SESSION['admin_id'] = (int)$admin['id'];
        $_SESSION['admin_username'] = $admin['username'];

        $upd = $pdo->prepare('UPDATE admin_users SET last_login_at = NOW() WHERE id = ?');
        $upd->execute([$admin['id']]);

        return ['id' => $admin['id'], 'username' => $admin['username'], 'display_name' => $admin['display_name']];
    }

    public static function currentAdmin(): ?array
    {
        app_session_start();
        if (empty($_SESSION['admin_id'])) {
            return null;
        }
        return ['id' => $_SESSION['admin_id'], 'username' => $_SESSION['admin_username'] ?? ''];
    }

    public static function requireAdmin(): array
    {
        $admin = self::currentAdmin();
        if (!$admin) {
            json_error('Admin authentication required.', 401);
        }
        return $admin;
    }

    public static function logout(): void
    {
        app_session_start();
        unset($_SESSION['admin_id'], $_SESSION['admin_username']);
        // Fully tear down the session on logout too, rather than just
        // unsetting the two admin keys, so nothing about the prior
        // authenticated session (ID included) survives for reuse.
        if (session_status() === PHP_SESSION_ACTIVE) {
            $_SESSION = [];
            session_regenerate_id(true);
        }
    }
}
