<?php
declare(strict_types=1);

/**
 * Generates a standards-compliant Housie ticket:
 *  - 3 rows x 9 columns
 *  - 15 numbers total, 5 per row, 4 blanks per row
 *  - Column 1: 1-9, Column 2: 10-19, ... Column 9: 80-90 (11 numbers)
 *  - Every column has at least 1 number, at most 3
 *  - Numbers within a column read top-to-bottom in ascending order
 *
 * Note: tickets are generated independently per player (as with printed
 * paper tickets in a real hall) - it is expected and normal for numbers
 * to repeat across different players' tickets. Uniqueness is enforced
 * per-player-per-room at the DB level (one ticket row per player).
 */
final class TicketGenerator
{
    /** @var array<int,array{0:int,1:int}> column index => [min,max] */
    private const COLUMN_RANGES = [
        [1, 9], [10, 19], [20, 29], [30, 39], [40, 49],
        [50, 59], [60, 69], [70, 79], [80, 90],
    ];

    /**
     * @return array<int,array<int,int>> 3x9 grid, 0 = blank cell
     */
    public static function generate(): array
    {
        $columnCounts = self::distributeColumnCounts();
        $shape = self::buildRowShape($columnCounts);

        // grid[row][col] = 0 (blank) initially
        $grid = array_fill(0, 3, array_fill(0, 9, 0));

        foreach ($columnCounts as $col => $count) {
            if ($count === 0) {
                continue;
            }
            [$min, $max] = self::COLUMN_RANGES[$col];
            $pool = range($min, $max);
            shuffle($pool);
            $chosenNumbers = array_slice($pool, 0, $count);
            sort($chosenNumbers, SORT_NUMERIC);

            // rows (0..2) that hold a number in this column, from the shape
            $rowsForCol = [];
            for ($r = 0; $r < 3; $r++) {
                if ($shape[$r][$col] === 1) {
                    $rowsForCol[] = $r;
                }
            }
            sort($rowsForCol, SORT_NUMERIC);

            foreach ($rowsForCol as $i => $row) {
                $grid[$row][$col] = $chosenNumbers[$i];
            }
        }

        return $grid;
    }

    /**
     * Decide how many numbers (1-3) each of the 9 columns gets, summing to 15.
     * @return array<int,int> length-9 array of counts
     */
    private static function distributeColumnCounts(): array
    {
        $counts = array_fill(0, 9, 1); // every column starts with 1 (sum=9)
        $remaining = 15 - 9;           // 6 more to distribute, max +2 per column

        $columns = range(0, 8);
        while ($remaining > 0) {
            shuffle($columns);
            foreach ($columns as $col) {
                if ($remaining <= 0) {
                    break;
                }
                if ($counts[$col] < 3) {
                    $counts[$col]++;
                    $remaining--;
                }
            }
        }

        return $counts;
    }

    /**
     * Build a 3x9 boolean shape (1 = has number, 0 = blank) satisfying:
     *  - column sums == $columnCounts
     *  - row sums == 5 for every row
     * Uses randomized greedy assignment with retry (search space is tiny,
     * converges within a handful of iterations).
     *
     * @param array<int,int> $columnCounts
     * @return array<int,array<int,int>>
     */
    private static function buildRowShape(array $columnCounts): array
    {
        for ($attempt = 0; $attempt < 500; $attempt++) {
            $shape = array_fill(0, 3, array_fill(0, 9, 0));
            $rowSums = [0, 0, 0];
            $ok = true;

            $columns = range(0, 8);
            shuffle($columns);

            foreach ($columns as $col) {
                $count = $columnCounts[$col];
                // Rank rows by ascending current sum (favor emptier rows),
                // but only among rows that still have room (<5) this column
                // hasn't already used (a column can supply at most 1 number
                // per row anyway since count <= 3 <= number of rows).
                $rows = [0, 1, 2];
                shuffle($rows);
                usort($rows, fn($a, $b) => $rowSums[$a] <=> $rowSums[$b]);

                $eligible = array_values(array_filter($rows, fn($r) => $rowSums[$r] < 5));
                if (count($eligible) < $count) {
                    $ok = false;
                    break;
                }
                $chosen = array_slice($eligible, 0, $count);
                foreach ($chosen as $r) {
                    $shape[$r][$col] = 1;
                    $rowSums[$r]++;
                }
            }

            if ($ok && $rowSums === [5, 5, 5]) {
                return $shape;
            }
        }

        // Extremely unlikely fallback: deterministic valid shape (classic
        // balanced layout) if randomized search somehow fails repeatedly.
        return self::fallbackShape($columnCounts);
    }

    private static function fallbackShape(array $columnCounts): array
    {
        $shape = array_fill(0, 3, array_fill(0, 9, 0));
        $rowSums = [0, 0, 0];
        foreach (range(0, 8) as $col) {
            $count = $columnCounts[$col];
            for ($i = 0; $i < $count; $i++) {
                // pick row with smallest current sum that's under 5
                $r = array_keys($rowSums, min($rowSums))[0];
                $shape[$r][$col] = 1;
                $rowSums[$r]++;
            }
        }
        return $shape;
    }
}
