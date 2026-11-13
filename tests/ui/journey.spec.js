// @ts-check
// Negative / guard-rail UI journeys (no game needs to run).
const { test, expect } = require('@playwright/test');

test.describe('UI guard rails', () => {
  test('joining with an unknown room code stays on the landing page and re-enables the button', async ({ page }) => {
    await page.goto('/index.html');
    await page.fill('#nameInput', 'UI Lost Player');
    await page.fill('#emailInput', `lost.${Date.now()}@uitest.example.com`);
    await page.fill('#roomCodeInput', 'ZZZZZZZZ');
    await page.click('#joinBtn');
    await expect(page.locator('#joinBtn')).toHaveText('Join Room');
    await expect(page).toHaveURL(/index\.html/);
  });

  test('joining without a room id is refused', async ({ page }) => {
    await page.goto('/index.html');
    await page.fill('#nameInput', 'UI Empty');
    await page.fill('#emailInput', `empty.${Date.now()}@uitest.example.com`);
    await page.click('#joinBtn');
    await expect(page).toHaveURL(/index\.html/);
  });

  test('host must keep at least one prize selected', async ({ page }) => {
    await page.goto('/index.html');
    await page.fill('#nameInput', 'UI NoPrize');
    await page.fill('#emailInput', `noprize.${Date.now()}@uitest.example.com`);
    await page.click('[data-mode="host"]');
    for (const cb of await page.locator('#hostPane .prize-check').all()) await cb.uncheck();
    await page.click('#hostBtn');
    await expect(page).toHaveURL(/index\.html/);
  });

  test('admin login rejects wrong credentials and stays on the login page', async ({ page }) => {
    await page.goto('/admin_login.html');
    await page.fill('#username', 'nobody');
    await page.fill('#password', 'definitely-wrong');
    await page.click('#loginBtn');
    await expect(page.locator('#loginError')).not.toBeEmpty();
    await expect(page).toHaveURL(/admin_login\.html/);
  });

  test('player page without a session does not show a ticket', async ({ page }) => {
    await page.goto('/player.html?room=ZZZZZZZZ');
    await expect(page.locator('#ticketContainer .ticket-cell:not(.blank)')).toHaveCount(0);
  });
});
