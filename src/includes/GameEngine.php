<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/Realtime.php';
require_once __DIR__ . '/RedisCache.php';
require_once __DIR__ . '/PublicEmailMask.php';
require_once __DIR__ . '/FullHouse.php';

final class GameEngine
{
    /** Seconds to hold before the very first number of a game is called,
     *  counted from games.started_at. Gives every client (host + all
     *  players) time to show a synchronized "5, 4, 3, 2, 1" countdown
     *  overlay before anything actually gets called. Only gates the
     *  first call of a game — resuming after a pause is unaffected. */
    private const START_COUNTDOWN_SECONDS = 6;

    /** After a prize is awarded, every client shows the drop-down winner
     *  alert (about 4.5s) and speaks "<name> won <prize>!". Number calling
     *  is paused server-side for this many seconds, counted from the latest
     *  award, so nobody misses a called number's voice behind the winner
     *  announcement. Each new award restarts the window, so back-to-back
     *  winners are covered too. Applies to auto-call and manual Call Next. */
    private const WINNER_ANNOUNCE_HOLD_SECONDS = 5;

    /** Seconds of winner-announcement hold still left for a room (0 = none).
     *  Uses MySQL's own clock for both sides of the comparison. */
    public static function winnerHoldRemainingSeconds(PDO $pdo, int $roomId): int
    {
        $stmt = $pdo->prepare(
            'SELECT TIMESTAMPDIFF(SECOND, MAX(awarded_at), NOW()) FROM room_prize_winners WHERE room_id = ?'
        );
        $stmt->execute([$roomId]);
        $elapsed = $stmt->fetchColumn();
        if ($elapsed === false || $elapsed === null) {
            return 0; // no prize awarded yet
        }
        return max(0, self::WINNER_ANNOUNCE_HOLD_SECONDS - max(0, (int)$elapsed));
    }


    /** Fetch (or lazily create) the games row for a room. */
    public static function getOrCreateGame(PDO $pdo, int $roomId): array
    {
        $stmt = $pdo->prepare('SELECT * FROM games WHERE room_id = ? LIMIT 1');
        $stmt->execute([$roomId]);
        $game = $stmt->fetch();
        if ($game) {
            return $game;
        }
        $ins = $pdo->prepare('INSERT INTO games (room_id, status) VALUES (?, "NOT_STARTED")');
        $ins->execute([$roomId]);
        $stmt->execute([$roomId]);
        return $stmt->fetch();
    }

    /**
     * Start the game: room must be in LOBBY with >=1 player, transitions
     * room -> LIVE and game -> RUNNING. Locks out further joins.
     */
    public static function start(PDO $pdo, array $room, array $game, int $hostUserId): array
    {
        $pdo->beginTransaction();
        try {
            // Lock the room row first. room_join.php takes the same lock, so
            // joins and game start are serialized and cannot race each other.
            $roomStmt = $pdo->prepare('SELECT * FROM rooms WHERE id = ? FOR UPDATE');
            $roomStmt->execute([(int)$room['id']]);
            $lockedRoom = $roomStmt->fetch();

            if (!$lockedRoom || $lockedRoom['status'] !== 'LOBBY') {
                throw new RuntimeException('Game can only be started from the lobby.');
            }

            $countStmt = $pdo->prepare(
                'SELECT COUNT(*) FROM room_players WHERE room_id = ? AND is_active = 1'
            );
            $countStmt->execute([(int)$lockedRoom['id']]);
            if ((int)$countStmt->fetchColumn() === 0) {
                throw new RuntimeException('Cannot start a game with no players.');
            }

            $roomUpdate = $pdo->prepare(
                'UPDATE rooms SET status = "LIVE", started_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 6 SECOND) WHERE id = ? AND status = "LOBBY"'
            );
            $roomUpdate->execute([(int)$lockedRoom['id']]);
            if ($roomUpdate->rowCount() !== 1) {
                throw new RuntimeException('Game can only be started from the lobby.');
            }

            $gameUpdate = $pdo->prepare(
                'UPDATE games SET status = "RUNNING", started_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 6 SECOND) WHERE id = ?'
            );
            $gameUpdate->execute([(int)$game['id']]);
            self::log($pdo, (int)$lockedRoom['id'], (int)$game['id'], 'HOST', $hostUserId, 'GAME_STARTED');
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        Realtime::room((string)$lockedRoom['room_code'], 'game_started');

        return ['room_status' => 'LIVE', 'game_status' => 'RUNNING'];
    }

    public static function pause(PDO $pdo, array $room, array $game, int $hostUserId): void
    {
        if ($game['status'] !== 'RUNNING') {
            throw new RuntimeException('Game is not currently running.');
        }
        $pdo->prepare('UPDATE games SET status = "PAUSED" WHERE id = ?')->execute([$game['id']]);
        $pdo->prepare('UPDATE rooms SET status = "PAUSED" WHERE id = ?')->execute([$room['id']]);
        self::log($pdo, $room['id'], $game['id'], 'HOST', $hostUserId, 'GAME_PAUSED');
        Realtime::room((string)$room['room_code'], 'game_paused');
    }

    public static function resume(PDO $pdo, array $room, array $game, int $hostUserId): void
    {
        if ($game['status'] !== 'PAUSED') {
            throw new RuntimeException('Game is not currently paused.');
        }
        $pdo->prepare('UPDATE games SET status = "RUNNING" WHERE id = ?')->execute([$game['id']]);
        $pdo->prepare('UPDATE rooms SET status = "LIVE" WHERE id = ?')->execute([$room['id']]);
        self::log($pdo, $room['id'], $game['id'], 'HOST', $hostUserId, 'GAME_RESUMED');
        Realtime::room((string)$room['room_code'], 'game_resumed');
    }

    /**
     * Call the next random, not-yet-called number (1-90). Atomic via
     * transaction + unique constraints on called_numbers to guard against
     * double-calls from concurrent requests.
     */
    public static function callNext(PDO $pdo, array $room, array $game, int $hostUserId): array
    {
        if ($game['status'] !== 'RUNNING') {
            throw new RuntimeException('Game must be running to call the next number.');
        }

        $pdo->beginTransaction();
        try {
            // Lock the game row to serialize concurrent "next" calls.
            $lockStmt = $pdo->prepare('SELECT * FROM games WHERE id = ? FOR UPDATE');
            $lockStmt->execute([$game['id']]);
            $game = $lockStmt->fetch();

            if ($game['numbers_called_count'] >= 90) {
                $pdo->rollBack();
                throw new RuntimeException('All 90 numbers have already been called.');
            }

            // A prize was just awarded: wait for the winner alert + voice to
            // finish on every device before calling another number.
            $holdLeft = self::winnerHoldRemainingSeconds($pdo, (int)$room['id']);
            if ($holdLeft > 0) {
                $pdo->rollBack();
                throw new RuntimeException('Winner announcement in progress. Try again in ' . $holdLeft . 's.');
            }

            // First number of the game: hold until the start countdown
            // (shown on every client) has actually finished, so numbers
            // never get called out from under the "5,4,3,2,1" overlay.
            if ((int)$game['numbers_called_count'] === 0 && $game['started_at']) {
                $sinceStartStmt = $pdo->prepare('SELECT TIMESTAMPDIFF(SECOND, ?, NOW()) AS elapsed');
                $sinceStartStmt->execute([$game['started_at']]);
                $sinceStart = (int)$sinceStartStmt->fetchColumn();
                if ($sinceStart < 0) {
                    $pdo->rollBack();
                    throw new RuntimeException('Game is still starting.');
                }
            }


            $calledStmt = $pdo->prepare('SELECT number FROM called_numbers WHERE game_id = ?');
            $calledStmt->execute([$game['id']]);
            $called = array_map('intval', array_column($calledStmt->fetchAll(), 'number'));

            $remaining = array_values(array_diff(range(1, 90), $called));
            if (empty($remaining)) {
                $pdo->rollBack();
                throw new RuntimeException('All 90 numbers have already been called.');
            }
            $next = $remaining[random_int(0, count($remaining) - 1)];
            $sequence = $game['numbers_called_count'] + 1;

            $ins = $pdo->prepare(
                'INSERT INTO called_numbers (game_id, number, sequence_no) VALUES (?, ?, ?)'
            );
            $ins->execute([$game['id'], $next, $sequence]);

            $isLast = $sequence >= 90;
            $upd = $pdo->prepare(
                'UPDATE games SET current_number = ?, numbers_called_count = ? WHERE id = ?'
            );
            $upd->execute([
                $next,
                $sequence,
                $game['id'],
            ]);
            // Note: reaching 90/90 no longer force-ends the game here. The
            // "Call Next" button already disables itself once
            // numbers_called_count hits 90 (see nextBtn in page-host.js),
            // but the game itself stays RUNNING until checkAndAutoEnd()
            // sees every enabled prize actually claimed, or the host
            // presses "End Game". This is what keeps the final winners
            // popup from firing just because the number pool ran out with
            // prizes still unclaimed.

            self::log($pdo, $room['id'], $game['id'], 'HOST', $hostUserId, 'NUMBER_CALLED', ['number' => $next, 'sequence' => $sequence]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        // Warm the monotonic called-number set only AFTER MySQL commits. Mark
        // requests can then validate called numbers from Redis without one
        // SELECT per tap. Redis is only an accelerator: if this write fails,
        // mark.php falls back to the authoritative called_numbers table.
        self::cacheCalledNumber((int)$game['id'], $next);
        Realtime::room((string)$room['room_code'], 'number_called', null, [
            'number' => $next, 'call_sequence' => $sequence,
            'auto_call_enabled' => !empty($room['auto_call_enabled']),
            'auto_call_interval_seconds' => (int)($room['auto_call_interval_seconds'] ?? 0),
        ]);

        if ($isLast) {
            self::checkAndAutoEnd($pdo, $room, ['id' => $game['id']]);
        }

        return ['number' => $next, 'sequence' => $sequence, 'game_ended' => $isLast];
    }

    public static function end(PDO $pdo, array $room, array $game, string $actorType, ?int $actorUserId): void
    {
        $pdo->prepare('UPDATE games SET status = "ENDED", ended_at = NOW() WHERE id = ?')->execute([$game['id']]);
        $pdo->prepare('UPDATE rooms SET status = "COMPLETED", ended_at = NOW(), is_archived = 1 WHERE id = ?')
            ->execute([$room['id']]);
        self::log($pdo, $room['id'], $game['id'], $actorType, $actorUserId, 'GAME_ENDED');

        // Include the committed final winners snapshot in the same room-wide
        // GAME_FINISHED signal. Realtime signals are flushed after the caller's
        // transaction commits, so every browser receives one authoritative list
        // and can open the final winners card from the same event (not from
        // independently-timed results.php requests).
        $winnersStmt = $pdo->prepare(
            'SELECT rpw.prize_type, u.name AS winner_name, u.email AS winner_email, wc.claimed_at
             FROM room_prize_winners rpw
             JOIN winner_claims wc ON wc.id = rpw.winner_claim_id
             JOIN users u ON u.id = wc.user_id
             WHERE rpw.room_id = ? ORDER BY wc.claimed_at ASC, rpw.prize_type ASC, rpw.id ASC'
        );
        $winnersStmt->execute([(int)$room['id']]);
        $winners = FullHouse::annotate($winnersStmt->fetchAll(PDO::FETCH_ASSOC));
        // Use the canonical participant + winner masking context for the final card.
        $maskPlayersStmt = $pdo->prepare(
            'SELECT u.id, u.name, u.email FROM room_players rp JOIN users u ON u.id = rp.user_id
             WHERE rp.room_id = ? AND rp.is_active = 1 ORDER BY rp.joined_at ASC'
        );
        $maskPlayersStmt->execute([(int)$room['id']]);
        [$unusedMaskedPlayers, $winners] = mask_room_public_people($maskPlayersStmt->fetchAll(PDO::FETCH_ASSOC), $winners);
        Realtime::room((string)$room['room_code'], 'game_ended', null, [
            'final_winners' => $winners,
            'final' => true,
        ]);
    }

    /**
     * Ends the game automatically, but only once every prize enabled for
     * this room has actually been claimed by a player — never just because
     * the number pool ran out. Safe to call after any number-call or any
     * claim; it's a no-op unless the room's prize list is fully covered.
     *
     * This is what the final winners popup timing (host/player JS, gated on
     * game status flipping to ENDED) ultimately depends on: as long as this
     * method hasn't fired, the game stays RUNNING and the popup can't
     * appear — it only shows once every prize is claimed, or the host
     * explicitly clicks "End Game" (which calls end() directly, bypassing
     * this check by design).
     *
     * $game only needs an 'id' key here — callers that already hold the
     * full row (e.g. claim.php) can pass it as-is; callNext()/
     * autoCallIfDue() pass a minimal ['id' => ...] since they call this
     * after their own transaction has already committed.
     */
    public static function checkAndAutoEnd(PDO $pdo, array $room, array $game): bool
    {
        // Re-fetch fresh room + game state — callers may be calling this
        // right after their own commit, so don't trust any stale copy of
        // $room/$game they might be holding.
        $roomStmt = $pdo->prepare('SELECT * FROM rooms WHERE id = ?');
        $roomStmt->execute([$room['id']]);
        $freshRoom = $roomStmt->fetch();
        if (!$freshRoom || in_array($freshRoom['status'], ['COMPLETED', 'CANCELLED'], true)) {
            return false; // already ended (or cancelled) — nothing to do
        }

        $gameStmt = $pdo->prepare('SELECT * FROM games WHERE id = ?');
        $gameStmt->execute([$game['id']]);
        $freshGame = $gameStmt->fetch();
        if (!$freshGame || $freshGame['status'] === 'ENDED') {
            return false;
        }

        $prizesEnabled = json_decode($freshRoom['prizes_enabled'], true) ?: [];
        if (empty($prizesEnabled)) {
            return false; // room has no prizes configured — only a manual End Game applies
        }

        $wonStmt = $pdo->prepare('SELECT DISTINCT prize_type FROM room_prize_winners WHERE room_id = ?');
        $wonStmt->execute([$freshRoom['id']]);
        $wonSet = array_flip(array_column($wonStmt->fetchAll(), 'prize_type'));

        foreach ($prizesEnabled as $prizeType) {
            if (!isset($wonSet[$prizeType])) {
                return false; // at least one enabled prize is still unclaimed
            }
        }

        // Several Full House winners: keep playing until every slot is filled
        // (slots = the host's choice, capped at the number of players).
        if (in_array('FULL_HOUSE', $prizesEnabled, true) && FullHouse::configured($freshRoom) > 1) {
            $activeStmt = $pdo->prepare('SELECT COUNT(*) FROM room_players WHERE room_id = ? AND is_active = 1');
            $activeStmt->execute([$freshRoom['id']]);
            $slots = FullHouse::slots($freshRoom, (int)$activeStmt->fetchColumn());
            $fhWonStmt = $pdo->prepare('SELECT COUNT(*) FROM room_prize_winners WHERE room_id = ? AND prize_type = "FULL_HOUSE"');
            $fhWonStmt->execute([$freshRoom['id']]);
            if ((int)$fhWonStmt->fetchColumn() < $slots) {
                return false; // Full House still has winners to come
            }
        }

        // Every enabled prize has a winner — the game is genuinely over.
        self::end($pdo, $freshRoom, $freshGame, 'SYSTEM', null);
        return true;
    }

    /**
     * Auto-call is driven from here rather than from the host's browser.
     * The host's tab counting ticks in a setInterval() only works while
     * that tab is open, focused, and not throttled/frozen by the browser
     * (which happens quickly once a tab goes idle/backgrounded) — so
     * relying on the host's client to fire the "call next" request meant
     * the game silently stalled whenever the host stepped away.
     *
     * Instead, this runs on every results.php poll (from the host OR any
     * player), so as long as *someone's* page is open, numbers keep being
     * called on schedule. It's fully time-gated against the real
     * called_at / started_at timestamps (not a tick counter), and the
     * games-row lock makes concurrent callers from many players' browsers
     * safe — only one call is ever made per due interval.
     *
     * Returns the same shape as callNext() when a number was called, or
     * null if it wasn't due yet / auto-call isn't active for this room.
     */
    public static function autoCallIfDue(PDO $pdo, array $room): ?array
    {
        if (empty($room['auto_call_enabled'])) {
            return null;
        }
        $intervalSeconds = (int)($room['auto_call_interval_seconds'] ?? 0);
        if ($intervalSeconds <= 0) {
            return null;
        }

        $pdo->beginTransaction();
        try {
            // Lock the game row so concurrent pollers (host + every
            // player) can't both decide a call is "due" at once.
            $lockStmt = $pdo->prepare('SELECT * FROM games WHERE room_id = ? FOR UPDATE');
            $lockStmt->execute([$room['id']]);
            $game = $lockStmt->fetch();

            if (!$game || $game['status'] !== 'RUNNING' || (int)$game['numbers_called_count'] >= 90) {
                $pdo->rollBack();
                return null;
            }

            $lastCalledStmt = $pdo->prepare('SELECT called_at FROM called_numbers WHERE game_id = ? ORDER BY sequence_no DESC LIMIT 1');
            $lastCalledStmt->execute([$game['id']]);
            $lastCalledAt = $lastCalledStmt->fetchColumn();
            $referenceTime = $lastCalledAt ?: $game['started_at'];
            if (!$referenceTime) {
                $pdo->rollBack();
                return null;
            }

            $elapsedStmt = $pdo->prepare('SELECT TIMESTAMPDIFF(SECOND, ?, NOW()) AS elapsed');
            $elapsedStmt->execute([$referenceTime]);
            $elapsed = (int)$elapsedStmt->fetchColumn();

            // On the very first call, don't let a short configured
            // interval (min 3s) cut the start countdown overlay short —
            // require at least START_COUNTDOWN_SECONDS to have passed too.
            $requiredSeconds = $lastCalledAt ? $intervalSeconds : 0;

            if ($elapsed < $requiredSeconds) {
                $pdo->rollBack();
                return null;
            }

            // Pause number generation while a winner alert/voice is playing.
            // Checked only once a call is actually due, so idle ticks stay
            // cheap. The call fires on the first tick after the hold ends.
            if (self::winnerHoldRemainingSeconds($pdo, (int)$room['id']) > 0) {
                $pdo->rollBack();
                return null;
            }

            $calledStmt = $pdo->prepare('SELECT number FROM called_numbers WHERE game_id = ?');
            $calledStmt->execute([$game['id']]);
            $called = array_map('intval', array_column($calledStmt->fetchAll(), 'number'));

            $remaining = array_values(array_diff(range(1, 90), $called));
            if (empty($remaining)) {
                $pdo->rollBack();
                return null;
            }
            $next = $remaining[random_int(0, count($remaining) - 1)];
            $sequence = (int)$game['numbers_called_count'] + 1;

            $ins = $pdo->prepare('INSERT INTO called_numbers (game_id, number, sequence_no) VALUES (?, ?, ?)');
            $ins->execute([$game['id'], $next, $sequence]);

            $isLast = $sequence >= 90;
            $upd = $pdo->prepare(
                'UPDATE games SET current_number = ?, numbers_called_count = ? WHERE id = ?'
            );
            $upd->execute([
                $next,
                $sequence,
                $game['id'],
            ]);
            // See the matching note in callNext(): 90/90 no longer force-
            // ends the game by itself — checkAndAutoEnd() (called below,
            // after commit) decides that based on which prizes are
            // actually claimed.

            self::log($pdo, (int)$room['id'], (int)$game['id'], 'SYSTEM', null, 'NUMBER_CALLED', ['number' => $next, 'sequence' => $sequence, 'auto' => true]);
            $pdo->commit();

            // Keep manual and automatic calls on the same fast path for marks.
            self::cacheCalledNumber((int)$game['id'], $next);
            Realtime::room((string)$room['room_code'], 'number_called', null, [
                'number' => $next, 'call_sequence' => $sequence,
                'auto_call_enabled' => !empty($room['auto_call_enabled']),
                'auto_call_interval_seconds' => (int)($room['auto_call_interval_seconds'] ?? 0),
            ]);

            if ($isLast) {
                self::checkAndAutoEnd($pdo, $room, ['id' => $game['id']]);
            }

            return ['number' => $next, 'sequence' => $sequence, 'game_ended' => $isLast];
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            error_log('[auto-call] ' . $e->getMessage());
            return null;
        }
    }

    /**
     * Add a committed number to the game's monotonic Redis set. The set is
     * never authoritative and can be rebuilt from MySQL after expiry/restart.
     */
    private static function cacheCalledNumber(int $gameId, int $number): void
    {
        try {
            $redis = RedisConn::conn();
            if (!$redis) {
                return;
            }
            $key = RedisCache::key('called:' . $gameId);
            $redis->sAdd($key, (string)$number);
            $redis->expire($key, 21600);
        } catch (Throwable $e) {
            RedisConn::reset();
            error_log('[game] called-number cache update failed: ' . $e->getMessage());
        }
    }

    /** Read-only companion to autoCallIfDue(): how many seconds until the
     *  next auto-call is due, for display (host + player status badges).
     *  Returns null whenever auto-call isn't actively counting down (not
     *  enabled, no interval set, game not RUNNING, or already at 90). */
    public static function autoCallSecondsRemaining(array $room, array $game, ?string $lastCalledAt, array $winners = []): ?int
    {
        if (empty($room['auto_call_enabled'])) {
            return null;
        }
        $intervalSeconds = (int)($room['auto_call_interval_seconds'] ?? 0);
        if ($intervalSeconds <= 0) {
            return null;
        }
        if ($game['status'] !== 'RUNNING' || (int)$game['numbers_called_count'] >= 90) {
            return null;
        }

        // Use timestamps already present in the shared, versioned room-state
        // cache. This avoids opening MySQL and running a countdown query for
        // every results/ticket poll. Database timestamps are stored in UTC.
        $referenceAt = $lastCalledAt ?: ($game['started_at'] ?? null);
        if (!$referenceAt) {
            return null;
        }

        try {
            $utc = new DateTimeZone('UTC');
            $reference = new DateTimeImmutable((string)$referenceAt, $utc);
            $now = new DateTimeImmutable('now', $utc);
            $elapsed = $now->getTimestamp() - $reference->getTimestamp();
        } catch (Throwable $e) {
            error_log('[auto-call-countdown] invalid timestamp: ' . $e->getMessage());
            return null;
        }

        $requiredSeconds = $lastCalledAt
            ? $intervalSeconds
            : 0;

        $remaining = max(0, $requiredSeconds - $elapsed);

        // Winner-announcement hold (see WINNER_ANNOUNCE_HOLD_SECONDS): the
        // countdown cannot reach 0 before the hold has ended. Uses the
        // winners already in the room-state read model (claimed_at is written
        // in the same transaction as the award), so no extra query.
        $latestClaim = null;
        foreach ($winners as $w) {
            $claimedAt = $w['claimed_at'] ?? null;
            if ($claimedAt && ($latestClaim === null || (string)$claimedAt > $latestClaim)) {
                $latestClaim = (string)$claimedAt;
            }
        }
        if ($latestClaim !== null) {
            try {
                $claimTs = (new DateTimeImmutable($latestClaim, $utc))->getTimestamp();
                $holdLeft = self::WINNER_ANNOUNCE_HOLD_SECONDS - max(0, $now->getTimestamp() - $claimTs);
                if ($holdLeft > $remaining) {
                    $remaining = $holdLeft;
                }
            } catch (Throwable $e) {
                // Display only; the server-side gate above is authoritative.
            }
        }

        return $remaining;
    }

    public static function log(PDO $pdo, ?int $roomId, ?int $gameId, string $actorType, ?int $actorUserId, string $action, array $details = []): void
    {
        $stmt = $pdo->prepare(
            'INSERT INTO game_logs (room_id, game_id, actor_type, actor_user_id, action, details) VALUES (?, ?, ?, ?, ?, ?)'
        );
        $stmt->execute([$roomId, $gameId, $actorType, $actorUserId, $action, json_encode($details)]);
    }
}
