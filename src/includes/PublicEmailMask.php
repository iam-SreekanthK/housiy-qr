<?php
declare(strict_types=1);

/**
 * Canonical privacy formatter for public room surfaces and admin reports.
 *
 * Default: for a four-character local part, show first + three stars + last.
 * For longer local parts, show first two + three stars + last two.
 * For a later participant with the same normalized name and same default
 * mask, reveal the shortest middle substring that does not occur anywhere
 * in the earlier participants' hidden middle portions.
 *
 * The earlier participant's display is never changed. Repeated appearances
 * of the same email (for example in a winner list) reuse the same mask.
 */
function mask_room_public_people(array $players, array $winners): array
{
    $normaliseName = static function ($name): string {
        return strtolower(trim(preg_replace('/\s+/u', ' ', (string)$name) ?? ''));
    };

    $splitEmail = static function ($email): ?array {
        if (!is_string($email) || trim($email) === '') {
            return null;
        }
        $email = trim($email);
        $at = strrpos($email, '@');
        if ($at === false || $at === 0 || $at === strlen($email) - 1) {
            return null;
        }
        return [substr($email, 0, $at), substr($email, $at + 1)];
    };

    $baseMask = static function ($email) use ($splitEmail): ?string {
        $parts = $splitEmail($email);
        if ($parts === null) {
            return is_string($email) && trim($email) !== '' ? '***' : null;
        }
        [$local, $domain] = $parts;
        if (strlen($local) === 4) {
            return substr($local, 0, 1) . '***' . substr($local, -1) . '@' . $domain;
        }
        if (strlen($local) < 4) {
            return str_repeat('*', strlen($local)) . '@' . $domain;
        }
        return substr($local, 0, 2) . '***' . substr($local, -2) . '@' . $domain;
    };

    // Preserve join order. When timestamps are present, sort chronologically;
    // rows without timestamps retain their original relative order.
    $orderedPeople = array_merge($players, $winners);
    $decorated = [];
    foreach ($orderedPeople as $idx => $person) {
        $rawWhen = $person['joined_at'] ?? $person['created_at'] ?? $person['registered_at'] ?? null;
        $timestamp = $rawWhen ? strtotime((string)$rawWhen) : false;
        $decorated[] = [
            'idx' => $idx,
            'person' => $person,
            'when' => $timestamp === false ? null : $timestamp,
        ];
    }
    usort($decorated, static function (array $a, array $b): int {
        // If both have timestamps, chronological order is authoritative.
        if ($a['when'] !== null && $b['when'] !== null) {
            return ($a['when'] <=> $b['when']) ?: ($a['idx'] <=> $b['idx']);
        }
        // Otherwise use the source order, which callers should provide in
        // join order (players first, then winner references).
        return $a['idx'] <=> $b['idx'];
    });
    $orderedPeople = array_column($decorated, 'person');

    $seen = [];
    $resolved = [];

    foreach ($orderedPeople as $person) {
        $email = $person['email'] ?? $person['winner_email'] ?? null;
        $name = $person['name'] ?? $person['player_name'] ?? $person['winner_name'] ?? '';
        $parts = $splitEmail($email);
        $base = $baseMask($email);
        $normalName = $normaliseName($name);

        if ($parts === null || $base === null || $normalName === '') {
            continue;
        }

        $key = $normalName . "\0" . strtolower($base);
        $emailNorm = strtolower(trim((string)$email));

        // The exact same email is the same email identity; don't create a
        // different mask merely because it appears again in winners/reports.
        if (isset($resolved[$key][$emailNorm])) {
            continue;
        }

        [$local, $domain] = $parts;
        $display = $base;
        $previous = $seen[$key] ?? [];

        if ($previous) {
            // Keep the same visible edges as the base mask. Four-character
            // local parts have one visible character at each end; longer
            // local parts have two.
            $edgeLength = strlen($local) === 4 ? 1 : 2;
            $middle = strlen($local) > ($edgeLength * 2)
                ? substr($local, $edgeLength, -$edgeLength)
                : '';
            $chosen = null;

            // Search shortest substrings first. Unlike the earlier algorithm,
            // the token may come from ANY middle position and is compared
            // against ALL positions in every earlier participant's middle.
            // This handles cases where the first differing character is not
            // at the same offset in both email addresses.
            for ($length = 1; $length <= strlen($middle) && $chosen === null; $length++) {
                for ($offset = 0; $offset + $length <= strlen($middle); $offset++) {
                    $token = substr($middle, $offset, $length);
                    $tokenLower = strtolower($token);
                    $appearsEarlier = false;

                    foreach ($previous as $old) {
                        if (strcasecmp($old['domain'], $domain) !== 0) {
                            continue;
                        }
                        if (strpos(strtolower($old['middle']), $tokenLower) !== false) {
                            $appearsEarlier = true;
                            break;
                        }
                    }

                    if (!$appearsEarlier) {
                        $chosen = $token;
                        break;
                    }
                }
            }

            if ($chosen !== null) {
                $display = substr($local, 0, $edgeLength) . '**' . $chosen . '**' .
                    substr($local, -$edgeLength) . '@' . $domain;
            }
            // If no unique substring exists (including an identical email),
            // retain the safe base mask. Never reveal the full local part.
        }

        $resolved[$key][$emailNorm] = $display;
        $seen[$key][] = [
            'local' => $local,
            'middle' => strlen($local) === 4
                ? substr($local, 1, -1)
                : (strlen($local) > 4 ? substr($local, 2, -2) : ''),
            'domain' => $domain,
            'email' => $emailNorm,
        ];
    }

    $mask = static function ($email, $name) use ($baseMask, $normaliseName, $resolved): ?string {
        $base = $baseMask($email);
        if ($base === null) {
            return null;
        }
        $normalName = $normaliseName($name);
        if ($normalName === '') {
            return $base;
        }
        $key = $normalName . "\0" . strtolower($base);
        return $resolved[$key][strtolower(trim((string)$email))] ?? $base;
    };

    $players = array_map(static function (array $person) use ($mask): array {
        if (array_key_exists('email', $person)) {
            $person['email'] = $mask($person['email'], $person['name'] ?? $person['player_name'] ?? '');
        }
        return $person;
    }, $players);

    $winners = array_map(static function (array $person) use ($mask): array {
        $name = $person['name'] ?? $person['player_name'] ?? $person['winner_name'] ?? '';
        if (array_key_exists('winner_email', $person)) {
            $person['winner_email'] = $mask($person['winner_email'], $name);
        }
        if (array_key_exists('email', $person)) {
            $person['email'] = $mask($person['email'], $name);
        }
        return $person;
    }, $winners);

    return [$players, $winners];
}
