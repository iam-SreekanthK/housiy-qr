<?php
declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AppEnvTest extends TestCase
{
    /** @dataProvider mapping */
    public function test_every_known_spelling_maps_to_one_canonical_name(string $raw, string $expected): void
    {
        $this->assertSame($expected, AppEnv::normalize($raw));
    }

    public static function mapping(): array
    {
        return [
            ['dev', 'dev'], ['development', 'dev'], ['testing', 'dev'], ['local', 'dev'],
            ['uat', 'uat'], ['staging', 'uat'], ['stage', 'uat'],
            ['prod', 'prod'], ['production', 'prod'], [' PRODUCTION ', 'prod'],
        ];
    }

    public function test_missing_env_is_prod_never_dev(): void
    {
        $this->assertSame('prod', AppEnv::normalize(''));
        $this->assertSame('prod', AppEnv::normalize(null));
    }

    public function test_unknown_env_is_rejected(): void
    {
        $this->assertNull(AppEnv::normalize('prodd'));
        $this->assertNull(AppEnv::normalize('qa'));
        $this->assertNull(AppEnv::normalize('production; dev'));
    }
}
