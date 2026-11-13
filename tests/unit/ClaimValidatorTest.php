<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClaimValidatorTest extends TestCase
{
    /** A fixed, known-valid ticket grid used across test cases. */
    private function sampleGrid(): array
    {
        return [
            [0, 11, 0, 0, 40, 53, 60, 72, 0],   // row 0 (top): 11,40,53,60,72
            [6, 0, 21, 36, 0, 54, 65, 0, 81],   // row 1 (middle): 6,21,36,54,65,81 -- 6 nums (invalid shape, but fine for isolated row tests)
            [8, 0, 0, 38, 42, 0, 0, 78, 90],    // row 2 (bottom): 8,38,42,78,90
        ];
    }

    public function test_top_row_valid_when_all_numbers_called_and_marked(): void
    {
        $grid = $this->sampleGrid();
        $called = [11, 40, 53, 60, 72, 1, 2, 3];
        $marked = [11, 40, 53, 60, 72];
        $result = ClaimValidator::validate('TOP_ROW', $grid, $called, $marked);
        $this->assertTrue($result['valid']);
    }

    public function test_top_row_invalid_when_one_number_missing_from_called(): void
    {
        $grid = $this->sampleGrid();
        $called = [11, 40, 53, 60]; // missing 72
        $marked = [11, 40, 53, 60];
        $result = ClaimValidator::validate('TOP_ROW', $grid, $called, $marked);
        $this->assertFalse($result['valid']);
        $this->assertStringContainsString('72', $result['reason']);
    }

    public function test_top_row_pending_when_called_but_player_has_not_marked_all_of_them(): void
    {
        // All 5 numbers have genuinely been called, but the player only
        // self-marked 3 of them - this must NOT validate, and should report
        // exactly how many are still pending.
        $grid = $this->sampleGrid();
        $called = [11, 40, 53, 60, 72];
        $marked = [11, 40, 53]; // missing 60, 72
        $result = ClaimValidator::validate('TOP_ROW', $grid, $called, $marked);
        $this->assertFalse($result['valid']);
        $this->assertSame(2, $result['pending_count']);
        $this->assertEqualsCanonicalizing([60, 72], $result['pending_numbers']);
    }

    public function test_bottom_row_valid_when_marked(): void
    {
        $grid = $this->sampleGrid();
        $called = [8, 38, 42, 78, 90];
        $marked = [8, 38, 42, 78, 90];
        $result = ClaimValidator::validate('BOTTOM_ROW', $grid, $called, $marked);
        $this->assertTrue($result['valid']);
    }

    public function test_full_house_requires_every_ticket_number_called_and_marked(): void
    {
        $grid = $this->sampleGrid();
        $all = [11, 40, 53, 60, 72, 6, 21, 36, 54, 65, 81, 8, 38, 42, 78, 90];
        $result = ClaimValidator::validate('FULL_HOUSE', $grid, $all, $all);
        $this->assertTrue($result['valid']);

        $missingOne = array_slice($all, 0, -1);
        $result2 = ClaimValidator::validate('FULL_HOUSE', $grid, $missingOne, $missingOne);
        $this->assertFalse($result2['valid']);

        // Fully called, but the player forgot to tap the very last number.
        $result3 = ClaimValidator::validate('FULL_HOUSE', $grid, $all, $missingOne);
        $this->assertFalse($result3['valid']);
        $this->assertSame(1, $result3['pending_count']);
    }

    public function test_first_five_valid_once_five_numbers_called_and_marked(): void
    {
        $grid = $this->sampleGrid();
        $called = [11, 40, 53, 60, 72]; // exactly 5, all on ticket (top row)
        $marked = [11, 40, 53, 60, 72];
        $result = ClaimValidator::validate('FIRST_FIVE', $grid, $called, $marked);
        $this->assertTrue($result['valid']);
    }

    public function test_first_five_invalid_with_only_four_numbers_called(): void
    {
        $grid = $this->sampleGrid();
        $called = [11, 40, 53, 60]; // only 4
        $marked = [11, 40, 53, 60];
        $result = ClaimValidator::validate('FIRST_FIVE', $grid, $called, $marked);
        $this->assertFalse($result['valid']);
    }

    public function test_first_five_pending_when_called_but_not_all_marked(): void
    {
        $grid = $this->sampleGrid();
        $called = [11, 40, 53, 60, 72]; // 5 called
        $marked = [11, 40];             // only 2 marked
        $result = ClaimValidator::validate('FIRST_FIVE', $grid, $called, $marked);
        $this->assertFalse($result['valid']);
        $this->assertSame(3, $result['pending_count']);
    }

    public function test_unknown_prize_type_rejected(): void
    {
        $grid = $this->sampleGrid();
        $result = ClaimValidator::validate('NOT_A_REAL_PRIZE', $grid, [1, 2, 3], [1, 2, 3]);
        $this->assertFalse($result['valid']);
    }

    public function test_claim_never_trusts_numbers_not_in_called_ledger(): void
    {
        // Even if the ticket "looks" complete, an empty called list must
        // never validate any row/full-house claim - this guards against a
        // client sending its own marked-numbers list instead of relying on
        // the server's called_numbers ledger.
        $grid = $this->sampleGrid();
        $result = ClaimValidator::validate('TOP_ROW', $grid, [], []);
        $this->assertFalse($result['valid']);
    }
}
