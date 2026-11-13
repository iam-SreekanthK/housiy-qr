// @ts-check
const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false, // tests share room state across host/player pages
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['junit', { outputFile: 'ui-test-results.xml' }], ['list']] : 'list',
  use: {
    baseURL: process.env.APP_BASE_URL || 'http://127.0.0.1:8899',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
