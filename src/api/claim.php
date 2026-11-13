<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/app.php';
require_once __DIR__ . '/../config/db.php';
require_once __DIR__ . '/../includes/Auth.php';
require_once __DIR__ . '/../includes/RoomAccess.php';
require_once __DIR__ . '/../includes/GameEngine.php';
require_once __DIR__ . '/../includes/ClaimValidator.php';
require_once __DIR__ . '/../includes/MarkBuffer.php';
require_once __DIR__ . '/../includes/PublicEmailMask.php';

require_post();
$user = Auth::requireUser();
RateLimiter::enforce('claim', 'u:' . $user['id']);
$body = json_body();

$roomCode  = strtoupper(trim((string)($body['room_code'] ?? '')));
$prizeType = strtoupper(trim((string)($body['prize_type'] ?? '')));

if ($roomCode === '' || strlen($roomCode) > 32) {
    json_error('Invalid room code.');
}
if (!in_array($prizeType, PRIZE_TYPES, true)) {
    json_error('Invalid prize type.');
}

$pdo = DB::conn();
$claimRoomSpan = EndpointProfiler::start('claim.room_lookup');
$room = RoomAccess::findByCode($pdo, $roomCode);
EndpointProfiler::stop($claimRoomSpan);

$prizesEnabled = json_decode((string)($room['prizes_enabled'] ?? '[]'), true);
$prizesEnabled = is_array($prizesEnabled) ? $prizesEnabled : [];
if (!in_array($prizeType, $prizesEnabled, true)) {
    json_error('This prize is not enabled for this room.', 400);
}

$claimGameSpan = EndpointProfiler::start('claim.game_lookup');
$game = GameEngine::getOrCreateGame($pdo, (int)$room['id']);
EndpointProfiler::stop($claimGameSpan);
if (!in_array($game['status'], ['RUNNING', 'PAUSED', 'ENDED'], true)) {
    json_error('Game has not started yet.', 409);
}

$ticketStmt = EndpointProfiler::query($pdo, 'claim.ticket_lookup', 'SELECT id, ticket_grid FROM tickets WHERE room_id = ? AND user_id = ? LIMIT 1', [$room['id'], $user['id']]);
$ticket = $ticketStmt->fetch();
if (!$ticket) {
    json_error('You do not have a ticket in this room.', 404);
}
$grid = json_decode((string)$ticket['ticket_grid'], true);
if (!is_array($grid)) {
    error_log('[claim] invalid ticket_grid JSON for ticket ' . (int)$ticket['id']);
    json_error('Ticket data is temporarily unavailable.', 503);
}

// Consistency barrier: persist THIS ticket's accepted-but-unflushed marks
// before the claim transaction opens, so its snapshot is guaranteed to
// include them. Only this ticket is flushed - not every player's history.
$claimPendingSpan = EndpointProfiler::start('claim.pending_marks');
// This pending-set read is the claim's mark-consistency boundary. Marks
// accepted before it are either in this snapshot or, if concurrently flushed,
// in the MySQL read below. Marks accepted afterwards belong to the next
// consistency interval and cannot be assumed by this claim.
$pendingBeforeClaim = MarkBuffer::pending((int)$ticket['id']);
EndpointProfiler::stop($claimPendingSpan);
$claimFlushSpan = EndpointProfiler::start('claim.flush_ticket_barrier');
try {
    // Avoid a second Redis read when the snapshot is empty. If it contains
    // marks, persist that ticket's pending set before opening the SQL snapshot.
    if ($pendingBeforeClaim) {
        MarkBuffer::flushTicket($pdo, (int)$ticket['id']);
    }
} catch (Throwable $e) {
    // e.g. a deadlock against the worker's own insert. Not fatal: every mark
    // read above is either now in MySQL or is unioned into the claim below.
    error_log('[claim] barrier flush failed: ' . $e->getMessage());
}
EndpointProfiler::stop($claimFlushSpan);

$claimTransactionSpan = EndpointProfiler::start('claim.transaction');
try {
    $pdo->beginTransaction();
    // Lock to prevent two simultaneous claims for the same prize racing.
    $lockStmt = EndpointProfiler::query($pdo, 'claim.room_lock', 'SELECT id FROM rooms WHERE id = ? FOR UPDATE', [$room['id']]);

    $wonStmt = EndpointProfiler::query($pdo, 'claim.prize_winner_lookup', 'SELECT id FROM room_prize_winners WHERE room_id = ? AND prize_type = ? LIMIT 1', [$room['id'], $prizeType]);
    $alreadyWon = $wonStmt->fetch();

    $calledStmt = EndpointProfiler::query($pdo, 'claim.called_numbers', 'SELECT number FROM called_numbers WHERE game_id = ?', [$game['id']]);
    $calledNumbers = array_map('intval', $calledStmt->fetchAll(PDO::FETCH_COLUMN));

    $markedStmt = EndpointProfiler::query($pdo, 'claim.marked_numbers', 'SELECT number FROM marked_numbers WHERE ticket_id = ?', [$ticket['id']]);
    $markedNumbers = array_map('intval', $markedStmt->fetchAll(PDO::FETCH_COLUMN));
    $markedNumbers = MarkBuffer::union($markedNumbers, $pendingBeforeClaim);

    // Full House can only be claimed once every other prize enabled for
    // this room has already been won. This mirrors physical housie, where
    // Full House is the closing prize — it can't jump ahead of First Five /
    // row prizes that are still in play.
    $pendingPrizeTypes = [];
    $prerequisiteReason = null;
    if ($prizeType === 'FULL_HOUSE' && !$alreadyWon) {
        $wonTypesStmt = EndpointProfiler::query($pdo, 'claim.prize_prerequisites', 'SELECT prize_type FROM room_prize_winners WHERE room_id = ?', [$room['id']]);
        $wonSet = array_flip(array_column($wonTypesStmt->fetchAll(), 'prize_type'));

        $prizeLabels = [
            'FIRST_FIVE' => 'First Five',
            'TOP_ROW'    => 'First row',
            'MIDDLE_ROW' => 'Second row',
            'BOTTOM_ROW' => 'Third row',
        ];

        foreach (['FIRST_FIVE', 'TOP_ROW', 'MIDDLE_ROW', 'BOTTOM_ROW'] as $prereq) {
            if (!in_array($prereq, $prizesEnabled, true)) {
                continue; // this room doesn't offer that prize, so nothing to wait for
            }
            if (!isset($wonSet[$prereq])) {
                $pendingPrizeTypes[] = $prereq;
            }
        }

        if (!empty($pendingPrizeTypes)) {
            $first = $prizeLabels[$pendingPrizeTypes[0]];
            $prerequisiteReason = "$first is still not completed — win it before Full House can be claimed.";
            if (count($pendingPrizeTypes) > 1) {
                $others = array_map(fn($p) => $prizeLabels[$p], array_slice($pendingPrizeTypes, 1));
                $prerequisiteReason .= ' Also pending: ' . implode(', ', $others) . '.';
            }
        }
    }

    if ($prerequisiteReason !== null) {
        $validation = [
            'valid' => false,
            'reason' => $prerequisiteReason,
            'pending_count' => count($pendingPrizeTypes),
            'pending_numbers' => [],
            'pending_prizes' => $pendingPrizeTypes,
        ];
    } else {
        $validation = ClaimValidator::validate($prizeType, $grid, $calledNumbers, $markedNumbers);
    }

    $isValid = $validation['valid'] && !$alreadyWon;
    $reason = $alreadyWon
        ? 'This prize has already been won by another player.'
        : $validation['reason'];

    EndpointProfiler::query($pdo, 'claim.insert',
        'INSERT INTO winner_claims (room_id, game_id, ticket_id, user_id, prize_type, is_valid, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?)', [
        $room['id'], $game['id'], $ticket['id'], $user['id'], $prizeType,
        $isValid ? 1 : 0, $reason,
    ]);
    $claimId = (int)$pdo->lastInsertId();

    if ($isValid) {
        EndpointProfiler::query($pdo, 'claim.award_insert',
            'INSERT INTO room_prize_winners (room_id, prize_type, winner_claim_id) VALUES (?, ?, ?)',
            [$room['id'], $prizeType, $claimId]
        );
        GameEngine::log($pdo, (int)$room['id'], (int)$game['id'], 'PLAYER', (int)$user['id'], 'PRIZE_WON', ['prize_type' => $prizeType]);

        // A claim just landed — check whether every prize enabled for this
        // room now has a winner (covers Full House as the natural closing
        // prize, but also rooms that don't offer Full House at all, where
        // the last row/First-Five claim should end things the same way).
        GameEngine::checkAndAutoEnd($pdo, $room, $game);
    } else {
        GameEngine::log($pdo, (int)$room['id'], (int)$game['id'], 'PLAYER', (int)$user['id'], 'CLAIM_REJECTED', ['prize_type' => $prizeType, 'reason' => $reason]);
    }

    $pdo->commit();
    EndpointProfiler::stop($claimTransactionSpan);
} catch (Throwable $e) {
    EndpointProfiler::stop($claimTransactionSpan);
    if ($pdo->inTransaction()) $pdo->rollBack();
    error_log('[claim] ' . $e->getMessage());
    json_error('Failed to process claim.', 500);
}

if ($isValid) {
    // Build the same room-wide participant + winner context used by results.php.
    // This ensures collision-aware masks are byte-for-byte consistent in the
    // participant list, claim banner and winner displays.
    $maskPlayersStmt = $pdo->prepare(
        'SELECT u.id, u.name, u.email FROM room_players rp JOIN users u ON u.id = rp.user_id
         WHERE rp.room_id = ? AND rp.is_active = 1 ORDER BY rp.joined_at ASC'
    );
    $maskPlayersStmt->execute([(int)$room['id']]);
    $maskPlayers = $maskPlayersStmt->fetchAll(PDO::FETCH_ASSOC);
    $maskWinnersStmt = $pdo->prepare(
        'SELECT rpw.prize_type, wc.user_id AS winner_user_id, u.name AS winner_name, u.email AS winner_email, wc.claimed_at
         FROM room_prize_winners rpw JOIN winner_claims wc ON wc.id = rpw.winner_claim_id
         JOIN users u ON u.id = wc.user_id WHERE rpw.room_id = ?'
    );
    $maskWinnersStmt->execute([(int)$room['id']]);
    $maskWinners = $maskWinnersStmt->fetchAll(PDO::FETCH_ASSOC);
    [$maskPlayers, $maskWinners] = mask_room_public_people($maskPlayers, $maskWinners);
    $maskedEmail = '';
    foreach ($maskPlayers as $maskedPlayer) {
        if ((int)$maskedPlayer['id'] === (int)$user['id']) { $maskedEmail = (string)($maskedPlayer['email'] ?? ''); break; }
    }
    $claimEvent = ['prize_type' => $prizeType, 'winner_name' => (string)$user['name'], 'winner_email' => $maskedEmail];
    // Publish exactly one canonical room-wide winner event. Publishing both
    // prize_claimed and prize_won caused two WebSocket deliveries for the same
    // claim; older clients could speak the same winner announcement twice.
    Realtime::room((string)$room['room_code'], 'prize_won', null, $claimEvent);
}

if (!$isValid) {
    json_response([
        'success' => false,
        'valid' => false,
        'reason' => $reason,
        'pending_count' => $validation['pending_count'] ?? 0,
        'pending_numbers' => $validation['pending_numbers'] ?? [],
        'pending_prizes' => $validation['pending_prizes'] ?? [],
    ], 200);
}

json_ok(['valid' => true, 'prize_type' => $prizeType, 'winner' => $user['name']]);
