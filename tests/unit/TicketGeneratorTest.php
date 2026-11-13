<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class TicketGeneratorTest extends TestCase
{
    public function test_generates_15_numbers_total(): void
    {
        $grid = TicketGenerator::generate();
        $count = 0;
        foreach ($grid as $row) {
            foreach ($row as $v) {
                if ($v !== 0) $count++;
            }
        }
        $this->assertSame(15, $count);
    }

    public function test_every_row_has_exactly_five_numbers(): void
    {
        $grid = TicketGenerator::generate();
        foreach ($grid as $row) {
            $nonZero = count(array_filter($row, fn($v) => $v !== 0));
            $this->assertSame(5, $nonZero);
        }
    }

    public function test_every_column_has_between_one_and_three_numbers(): void
    {
        $grid = TicketGenerator::generate();
        for ($c = 0; $c < 9; $c++) {
            $count = 0;
            for ($r = 0; $r < 3; $r++) {
                if ($grid[$r][$c] !== 0) $count++;
            }
            $this->assertGreaterThanOrEqual(1, $count, "Column $c has zero numbers");
            $this->assertLessThanOrEqual(3, $count, "Column $c has more than 3 numbers");
        }
    }

    public function test_numbers_fall_within_correct_column_ranges(): void
    {
        $ranges = [
            [1, 9], [10, 19], [20, 29], [30, 39], [40, 49],
            [50, 59], [60, 69], [70, 79], [80, 90],
        ];
        $grid = TicketGenerator::generate();
        for ($c = 0; $c < 9; $c++) {
            [$min, $max] = $ranges[$c];
            for ($r = 0; $r < 3; $r++) {
                $v = $grid[$r][$c];
                if ($v !== 0) {
                    $this->assertGreaterThanOrEqual($min, $v);
                    $this->assertLessThanOrEqual($max, $v);
                }
            }
        }
    }

    public function test_numbers_within_a_column_are_strictly_ascending_top_to_bottom(): void
    {
        $grid = TicketGenerator::generate();
        for ($c = 0; $c < 9; $c++) {
            $prev = 0;
            for ($r = 0; $r < 3; $r++) {
                $v = $grid[$r][$c];
                if ($v !== 0) {
                    $this->assertGreaterThan($prev, $v, "Column $c not ascending");
                    $prev = $v;
                }
            }
        }
    }

    public function test_no_duplicate_numbers_on_a_single_ticket(): void
    {
        $grid = TicketGenerator::generate();
        $nums = [];
        foreach ($grid as $row) {
            foreach ($row as $v) {
                if ($v !== 0) $nums[] = $v;
            }
        }
        $this->assertCount(count($nums), array_unique($nums));
    }

    public function test_stress_many_tickets_are_all_valid(): void
    {
        for ($i = 0; $i < 300; $i++) {
            $grid = TicketGenerator::generate();
            $rowSums = array_map(fn($row) => count(array_filter($row, fn($v) => $v !== 0)), $grid);
            $this->assertSame([5, 5, 5], $rowSums, "Failed on iteration $i");
        }
    }
}
