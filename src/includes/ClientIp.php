<?php
declare(strict_types=1);

/**
 * Trusted-proxy-aware client IP resolution.
 *
 * Forwarding headers (default X-Forwarded-For) are honoured ONLY when the
 * TCP peer (REMOTE_ADDR) is inside TRUSTED_PROXIES (comma-separated IPs or
 * CIDRs, IPv4 and IPv6). With TRUSTED_PROXIES empty - the default - every
 * forwarding header is ignored, so a client can never choose its own
 * rate-limit identity.
 *
 * When the peer is trusted the header chain is walked from the RIGHT (the
 * hop our own infrastructure appended) and trusted hops are skipped; the
 * first untrusted hop is the client. Anything a client prepends to the
 * left of the real chain is therefore never consulted. A malformed chain
 * falls back to the peer address.
 */
final class ClientIp
{
    private static ?string $cached = null;

    /** @return string[] */
    public static function trustedProxies(): array
    {
        $raw = (string)getenv('TRUSTED_PROXIES');
        $out = [];
        foreach (explode(',', $raw) as $p) {
            $p = trim($p);
            if ($p !== '') {
                $out[] = $p;
            }
        }
        return $out;
    }

    public static function resolve(?array $server = null, ?array $trusted = null): string
    {
        $useCache = ($server === null && $trusted === null);
        if ($useCache && self::$cached !== null) {
            return self::$cached;
        }
        $server  ??= $_SERVER;
        $trusted ??= self::trustedProxies();

        $peer = (string)($server['REMOTE_ADDR'] ?? '');
        if (filter_var($peer, FILTER_VALIDATE_IP) === false) {
            $peer = 'unknown';
        }
        $ip = $peer;

        if ($trusted && $peer !== 'unknown' && self::inList($peer, $trusted)) {
            $hdr = strtoupper(str_replace('-', '_', (string)(getenv('TRUSTED_PROXY_HEADER') ?: 'X-Forwarded-For')));
            $val = (string)($server['HTTP_' . $hdr] ?? '');
            if ($val !== '') {
                $hops = array_map('trim', explode(',', $val));
                $client = null;
                for ($i = count($hops) - 1; $i >= 0; $i--) {
                    $h = $hops[$i];
                    if (filter_var($h, FILTER_VALIDATE_IP) === false) {
                        $client = null;      // malformed chain: do not guess
                        break;
                    }
                    if (self::inList($h, $trusted)) {
                        continue;            // one of our own proxies, keep walking left
                    }
                    $client = $h;
                    break;
                }
                if ($client !== null) {
                    $ip = $client;
                }
            }
        }
        if ($useCache) {
            self::$cached = $ip;
        }
        return $ip;
    }

    public static function resetForTests(): void
    {
        self::$cached = null;
    }

    /** @param string[] $list */
    public static function inList(string $ip, array $list): bool
    {
        foreach ($list as $entry) {
            if (self::matches($ip, $entry)) {
                return true;
            }
        }
        return false;
    }

    public static function matches(string $ip, string $entry): bool
    {
        if (strpos($entry, '/') === false) {
            $a = @inet_pton($ip);
            $b = @inet_pton($entry);
            return $a !== false && $b !== false && $a === $b;
        }
        [$net, $bits] = explode('/', $entry, 2);
        if (!ctype_digit($bits)) {
            return false;
        }
        $ipBin  = @inet_pton($ip);
        $netBin = @inet_pton($net);
        if ($ipBin === false || $netBin === false || strlen($ipBin) !== strlen($netBin)) {
            return false;
        }
        $bits = (int)$bits;
        if ($bits < 0 || $bits > strlen($ipBin) * 8) {
            return false;
        }
        $fullBytes = intdiv($bits, 8);
        if ($fullBytes > 0 && substr($ipBin, 0, $fullBytes) !== substr($netBin, 0, $fullBytes)) {
            return false;
        }
        $rem = $bits % 8;
        if ($rem === 0) {
            return true;
        }
        $mask = (0xFF << (8 - $rem)) & 0xFF;
        return ((ord($ipBin[$fullBytes]) & $mask) === (ord($netBin[$fullBytes]) & $mask));
    }
}
