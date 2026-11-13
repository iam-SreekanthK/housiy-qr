<?php
declare(strict_types=1);

require_once __DIR__ . '/../config/db.php';

/**
 * Validates a prize claim strictly against server-side truth:
 *   - the ticket's stored 3x9 grid
 *   - the called_numbers ledger for the game (never trusts client-reported
 *     "marked numbers" for whether a number has actually been called)
 *   - the player's OWN marked_numbers (self-selected taps on their ticket) —
 *     a number only counts toward a claim once the player has tapped it
 *     themselves, even if it was already called. This mirrors physical
 *     housie: you must dab the number, not just have it called.
 *
 * First valid claim for a prize_type in a room wins (enforced via the
 * room_prize_winners unique(room_id, prize_type) constraint).
 */
final class ClaimValidator
{
    /**
     * @return array{valid: bool, reason: ?string, pending_count: int, pending_numbers: int[]}
     */
    public static function validate(string $prizeType, array $ticketGrid, array $calledNumbers, array $markedNumbers = []): array
    {
        if (!in_array($prizeType, PRIZE_TYPES, true)) {
            return self::result(false, 'Unknown prize type.');
        }

        $calledSet = array_flip($calledNumbers);
        $markedSet = array_flip($markedNumbers);

        $rowNumbers = function (int $rowIndex) use ($ticketGrid): array {
            return array_values(array_filter($ticketGrid[$rowIndex], fn($v) => $v !== 0));
        };

        $allTicketNumbers = [];
        foreach ($ticketGrid as $row) {
            foreach ($row as $v) {
                if ($v !== 0) {
                    $allTicketNumbers[] = $v;
                }
            }
        }

        switch ($prizeType) {
            case 'TOP_ROW':
                return self::checkSection($rowNumbers(0), $calledSet, $markedSet, 'Top row');

            case 'MIDDLE_ROW':
                return self::checkSection($rowNumbers(1), $calledSet, $markedSet, 'Middle row');

            case 'BOTTOM_ROW':
                return self::checkSection($rowNumbers(2), $calledSet, $markedSet, 'Bottom row');

            case 'FULL_HOUSE':
                return self::checkSection($allTicketNumbers, $calledSet, $markedSet, 'Full house');

            case 'FIRST_FIVE':
                // First Five = the player has personally marked at least 5
                // numbers on their ticket that have genuinely been called.
                $calledOnTicket = array_values(array_filter($allTicketNumbers, fn($n) => isset($calledSet[$n])));
                if (count($calledOnTicket) < 5) {
                    return self::result(false, 'Fewer than 5 numbers on this ticket have been called so far.');
                }
                $markedCalledOnTicket = array_values(array_filter($calledOnTicket, fn($n) => isset($markedSet[$n])));
                if (count($markedCalledOnTicket) < 5) {
                    $pending = 5 - count($markedCalledOnTicket);
                    return self::result(
                        false,
                        "You still have {$pending} number(s) pending — mark them on your ticket first, then claim.",
                        $pending
                    );
                }
                return self::result(true, null);

            default:
                return self::result(false, 'Unhandled prize type.');
        }
    }

    /**
     * @return array{valid: bool, reason: ?string, pending_count: int, pending_numbers: int[]}
     */
    private static function checkSection(array $numbers, array $calledSet, array $markedSet, string $label): array
    {
        if (empty($numbers)) {
            return self::result(false, "$label has no numbers to validate.");
        }

        $notCalled = array_values(array_filter($numbers, fn($n) => !isset($calledSet[$n])));
        if (!empty($notCalled)) {
            $n = $notCalled[0];
            return self::result(false, "$label is not fully called yet (number $n hasn't come up).");
        }

        $notMarked = array_values(array_filter($numbers, fn($n) => !isset($markedSet[$n])));
        if (!empty($notMarked)) {
            $count = count($notMarked);
            $list = implode(', ', $notMarked);
            $word = $count === 1 ? 'number' : 'numbers';
            return self::result(
                false,
                "$label — you still have $count $word pending ($list). Tap them on your ticket, then claim again.",
                $count,
                $notMarked
            );
        }

        return self::result(true, null);
    }

    /**
     * @param int[] $pendingNumbers
     * @return array{valid: bool, reason: ?string, pending_count: int, pending_numbers: int[]}
     */
    private static function result(bool $valid, ?string $reason, int $pendingCount = 0, array $pendingNumbers = []): array
    {
        return [
            'valid' => $valid,
            'reason' => $reason,
            'pending_count' => $pendingCount,
            'pending_numbers' => $pendingNumbers,
        ];
    }
}
