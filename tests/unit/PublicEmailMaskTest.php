<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;
require_once __DIR__ . '/../../src/includes/PublicEmailMask.php';

final class PublicEmailMaskTest extends TestCase
{
    public function testParticipantClaimAndWinnerUseIdenticalMask(): void
    {
        $players = [
            ['id' => 1, 'name' => 'Sree', 'email' => 'sreekanth@example.com'],
            ['id' => 2, 'name' => 'Other', 'email' => 'other@example.com'],
        ];
        $winners = [['winner_name' => 'Sree', 'winner_email' => 'sreekanth@example.com']];
        [$maskedPlayers, $maskedWinners] = mask_room_public_people($players, $winners);
        self::assertSame($maskedPlayers[0]['email'], $maskedWinners[0]['winner_email']);
        self::assertSame('sr..th@example.com', $maskedPlayers[0]['email']);
        self::assertStringNotContainsString('sreekanth', $maskedWinners[0]['winner_email']);
    }

    public function testSameNameMaskCollisionsAreDisambiguatedConsistently(): void
    {
        $players = [
            ['id' => 1, 'name' => 'Sree', 'email' => 'sreekanth@example.com'],
            ['id' => 2, 'name' => 'Sree', 'email' => 'sreekumar@example.com'],
        ];
        $winners = [['winner_name' => 'Sree', 'winner_email' => 'sreekanth@example.com']];
        [$maskedPlayers, $maskedWinners] = mask_room_public_people($players, $winners);
        self::assertNotSame($maskedPlayers[0]['email'], $maskedPlayers[1]['email']);
        self::assertSame($maskedPlayers[0]['email'], $maskedWinners[0]['winner_email']);
    }
}
