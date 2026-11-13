<?php
declare(strict_types=1);

/**
 * Multiple Full House winners.
 *
 * The host chooses (1..MAX_WINNERS) how many players can win Full House.
 * The default of 1 behaves exactly as before. Every other prize stays
 * single-winner.
 *
 *  - Stored in rooms.full_house_winners (see sql/schema.sql).
 *  - room_prize_winners may hold several FULL_HOUSE rows for a room, each
 *    with its own winner_position (1 = first to win).
 *  - A room can never have more Full House winners than it has players, so
 *    the effective slot count is min(configured, active players). That also
 *    stops a game from waiting forever for winners that cannot exist.
 *  - The game ends only when every enabled prize is won and every Full
 *    House slot is filled (GameEngine::checkAndAutoEnd).
 */
final class FullHouse
{
    public const MAX_WINNERS = 5;

    /** Clamp any input to a whole number 1..MAX_WINNERS (anything odd = 1). */
    public static function normalize($value): int
    {
        if (is_string($value)) {
            $value = trim($value);
        }
        if (!is_numeric($value)) {
            return 1;
        }
        return max(1, min(self::MAX_WINNERS, (int)$value));
    }

    /** What the host configured for a room row. */
    public static function configured(array $room): int
    {
        return self::normalize($room['full_house_winners'] ?? 1);
    }

    /** How many Full House winners this room can actually produce. */
    public static function slots(array $room, int $activePlayers): int
    {
        return max(1, min(self::configured($room), max(1, $activePlayers)));
    }

    /**
     * Adds winner_position (1-based, per prize, in award order) to winner
     * rows. Pure PHP so reads never depend on the new column existing.
     * Rows must already be in award order.
     */
    public static function annotate(array $winners): array
    {
        $seen = [];
        foreach ($winners as $i => $w) {
            $type = (string)($w['prize_type'] ?? '');
            $seen[$type] = ($seen[$type] ?? 0) + 1;
            $winners[$i]['winner_position'] = $seen[$type];
        }
        return $winners;
    }

    /**
     * Full House progress for a room from its winner rows.
     * @return array{total:int,won:int,remaining:int,won_user_ids:int[]}
     */
    public static function progress(array $room, array $winners, int $activePlayers): array
    {
        $total = self::slots($room, $activePlayers);
        $userIds = [];
        $won = 0;
        foreach ($winners as $w) {
            if ((string)($w['prize_type'] ?? '') !== 'FULL_HOUSE') continue;
            $won++;
            if (isset($w['winner_user_id'])) $userIds[] = (int)$w['winner_user_id'];
        }
        return [
            'total' => $total,
            'won' => $won,
            'remaining' => max(0, $total - $won),
            'won_user_ids' => $userIds,
        ];
    }
}
