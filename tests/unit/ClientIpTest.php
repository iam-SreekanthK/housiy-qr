<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClientIpTest extends TestCase
{
    private function srv(string $peer, ?string $xff = null): array
    {
        $s = ['REMOTE_ADDR' => $peer];
        if ($xff !== null) {
            $s['HTTP_X_FORWARDED_FOR'] = $xff;
        }
        return $s;
    }

    public function test_forwarding_headers_ignored_when_no_trusted_proxy_configured(): void
    {
        $this->assertSame('172.18.0.1', ClientIp::resolve($this->srv('172.18.0.1', '203.0.113.9'), []));
    }

    public function test_forwarding_headers_ignored_from_untrusted_peer(): void
    {
        $this->assertSame('198.51.100.7', ClientIp::resolve($this->srv('198.51.100.7', '1.2.3.4'), ['10.0.0.0/8']));
    }

    public function test_trusted_peer_header_is_used(): void
    {
        $this->assertSame('203.0.113.9', ClientIp::resolve($this->srv('10.1.2.3', '203.0.113.9'), ['10.0.0.0/8']));
    }

    public function test_client_cannot_spoof_by_prepending_to_chain(): void
    {
        // Attacker sends "X-Forwarded-For: 1.2.3.4"; our trusted LB appends the real peer.
        $ip = ClientIp::resolve($this->srv('10.0.0.5', '1.2.3.4, 203.0.113.50'), ['10.0.0.0/8']);
        $this->assertSame('203.0.113.50', $ip);
    }

    public function test_multiple_trusted_hops_are_skipped(): void
    {
        $ip = ClientIp::resolve($this->srv('10.0.0.5', '203.0.113.50, 10.0.0.9'), ['10.0.0.0/8']);
        $this->assertSame('203.0.113.50', $ip);
    }

    public function test_malformed_chain_falls_back_to_peer(): void
    {
        $this->assertSame('10.0.0.5', ClientIp::resolve($this->srv('10.0.0.5', 'not-an-ip, also-bad'), ['10.0.0.0/8']));
        $this->assertSame('10.0.0.5', ClientIp::resolve($this->srv('10.0.0.5', "1.2.3.4'; DROP TABLE users;--"), ['10.0.0.0/8']));
    }

    public function test_ipv6_cidr(): void
    {
        $this->assertTrue(ClientIp::matches('2001:db8::1', '2001:db8::/32'));
        $this->assertFalse(ClientIp::matches('2001:db9::1', '2001:db8::/32'));
        $this->assertTrue(ClientIp::matches('10.1.2.3', '10.1.2.3'));
        $this->assertFalse(ClientIp::matches('10.1.2.4', '10.1.2.3'));
        $this->assertTrue(ClientIp::matches('172.18.0.1', '172.16.0.0/12'));
        $this->assertFalse(ClientIp::matches('172.32.0.1', '172.16.0.0/12'));
        $this->assertFalse(ClientIp::matches('10.0.0.1', 'garbage/12'));
        $this->assertFalse(ClientIp::matches('10.0.0.1', '10.0.0.0/99'));
    }

    public function test_invalid_peer_is_unknown(): void
    {
        $this->assertSame('unknown', ClientIp::resolve(['REMOTE_ADDR' => 'zzz'], ['10.0.0.0/8']));
    }
}
