<?php
declare(strict_types=1);

/**
 * Canonical privacy formatter for all public room surfaces.
 * Uses the complete room participant + winner set so same-name collisions
 * are disambiguated identically in snapshots, claim events and final events.
 */
function mask_room_public_people(array $players, array $winners): array
{
    $normaliseName = static function ($name): string {
        return strtolower(trim(preg_replace('/\\s+/u', ' ', (string)$name) ?? ''));
    };
    $splitEmail = static function ($email): ?array {
        if (!is_string($email) || trim($email) === '') return null;
        $email = trim($email);
        $at = strrpos($email, '@');
        if ($at === false || $at === 0 || $at === strlen($email) - 1) return null;
        return [substr($email, 0, $at), substr($email, $at + 1)];
    };
    $baseMask = static function ($email) use ($splitEmail): ?string {
        $parts = $splitEmail($email);
        if ($parts === null) return is_string($email) && trim($email) !== '' ? '***' : null;
        [$local, $domain] = $parts;
        $length = strlen($local);
        if ($length <= 1) $masked = '*';
        elseif ($length <= 4) $masked = substr($local, 0, 1) . str_repeat('*', max(1, $length - 1));
        else $masked = substr($local, 0, 2) . '..' . substr($local, -2);
        return $masked . '@' . $domain;
    };

    $groups = [];
    foreach (array_merge($players, $winners) as $person) {
        $email = $person['email'] ?? $person['winner_email'] ?? null;
        $name = $person['name'] ?? $person['player_name'] ?? $person['winner_name'] ?? '';
        $parts = $splitEmail($email);
        $base = $baseMask($email);
        $normalName = $normaliseName($name);
        if ($parts === null || $base === null || $normalName === '') continue;
        $groups[$normalName . "\0" . strtolower($base)][] = [
            'email' => trim((string)$email), 'local' => $parts[0], 'domain' => $parts[1],
        ];
    }

    $mask = static function ($email, $name) use ($splitEmail, $baseMask, $normaliseName, $groups): ?string {
        $base = $baseMask($email);
        $parts = $splitEmail($email);
        if ($base === null || $parts === null) return $base;
        $normalName = $normaliseName($name);
        if ($normalName === '') return $base;
        $group = $groups[$normalName . "\0" . strtolower($base)] ?? [];
        $email = trim((string)$email);
        $hasCollision = false;
        foreach ($group as $other) {
            if (strcasecmp($other['email'], $email) !== 0) { $hasCollision = true; break; }
        }
        if (!$hasCollision) return $base;
        [$local, $domain] = $parts;
        $length = strlen($local);
        for ($visible = 2; $visible <= $length; $visible++) {
            $left = (int)ceil($visible / 2);
            $right = (int)floor($visible / 2);
            $candidateLocal = ($left + $right >= $length)
                ? $local
                : substr($local, 0, $left) . str_repeat('*', max(1, $length - $left - $right)) . ($right > 0 ? substr($local, -$right) : '');
            $candidate = $candidateLocal . '@' . $domain;
            $collision = false;
            foreach ($group as $other) {
                if (strcasecmp($other['email'], $email) === 0 || strcasecmp($other['domain'], $domain) !== 0) continue;
                $otherLocal = $other['local'];
                $ol = (int)ceil($visible / 2);
                $or = (int)floor($visible / 2);
                $otherCandidate = ($ol + $or >= strlen($otherLocal))
                    ? $otherLocal
                    : substr($otherLocal, 0, $ol) . str_repeat('*', max(1, strlen($otherLocal) - $ol - $or)) . ($or > 0 ? substr($otherLocal, -$or) : '');
                if (strcasecmp($candidate, $otherCandidate . '@' . $other['domain']) === 0) { $collision = true; break; }
            }
            if (!$collision) return $candidate;
        }
        $safeLocal = strlen($local) <= 1 ? '*' : substr($local, 0, -1) . '*';
        return $safeLocal . '@' . $domain;
    };

    $players = array_map(static function (array $person) use ($mask): array {
        if (array_key_exists('email', $person)) $person['email'] = $mask($person['email'], $person['name'] ?? $person['player_name'] ?? '');
        return $person;
    }, $players);
    $winners = array_map(static function (array $person) use ($mask): array {
        $name = $person['name'] ?? $person['player_name'] ?? $person['winner_name'] ?? '';
        if (array_key_exists('winner_email', $person)) $person['winner_email'] = $mask($person['winner_email'], $name);
        if (array_key_exists('email', $person)) $person['email'] = $mask($person['email'], $name);
        return $person;
    }, $winners);
    return [$players, $winners];
}
