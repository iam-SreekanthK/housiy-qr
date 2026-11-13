// @ts-check
// Emoji reactions through the real UI: two browser contexts (host + player).
const { test, expect } = require('@playwright/test');

async function createRoom(browser) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/index.html');
  await page.fill('#nameInput', 'UI Reaction Host');
  await page.fill('#emailInput', `rx.host.${Date.now()}@uitest.example.com`);
  await page.click('[data-mode="host"]');
  await page.click('#hostBtn');
  await expect(page).toHaveURL(/host\.html/);
  const code = (await page.locator('#roomCodeText').innerText()).trim();
  return { ctx, page, code };
}
async function joinRoom(browser, code, name) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/index.html');
  await page.fill('#nameInput', name);
  await page.fill('#emailInput', `rx.${name.replace(/\W/g, '')}.${Date.now()}@uitest.example.com`);
  await page.fill('#roomCodeInput', code);
  await page.click('#joinBtn');
  await expect(page).toHaveURL(/player\.html/);
  return { ctx, page };
}

test.describe('Emoji reactions', () => {
  test('player sends a reaction to everyone and the host sees it float, with history on both sides', async ({ browser }) => {
    const host = await createRoom(browser);
    const player = await joinRoom(browser, host.code, 'UI Reaction Player');

    await expect(player.page.locator('#reactionTrigger')).toBeVisible();
    await player.page.click('#reactionTrigger');
    await expect(player.page.locator('#reactionModal')).toHaveClass(/open/);
    await player.page.click('#reactionEmojiGrid [data-emoji="🔥"]');
    await player.page.click('#reactionSend');
    await expect(player.page.locator('#reactionModal')).not.toHaveClass(/open/);

    await expect(host.page.locator('.reaction-float-emoji', { hasText: '🔥' })).toBeVisible({ timeout: 8000 });
    await expect(host.page.locator('.reaction-float-name').first()).toHaveText('UI Reaction Player');

    await player.page.click('#reactionHistoryToggle');
    await expect(player.page.locator('#reactionHistoryList .reaction-history-item.sent')).toContainText('To everyone');
    await host.page.click('#reactionHistoryToggle');
    await expect(host.page.locator('#reactionHistoryList .reaction-history-item.received')).toContainText('From UI Reaction Player');
    await expect(host.page.locator('#reactionHistoryCount')).toHaveText('1');
    await host.ctx.close(); await player.ctx.close();
  });

  test('a private reaction reaches only its recipient and needs a chosen player', async ({ browser }) => {
    const host = await createRoom(browser);
    const a = await joinRoom(browser, host.code, 'UI Asha');
    const b = await joinRoom(browser, host.code, 'UI Ravi');

    await a.page.click('#reactionTrigger');
    await a.page.click('[data-reaction-target="player"]');
    await expect(a.page.locator('#reactionSend')).toBeDisabled();
    await a.page.selectOption('#reactionPlayerSelect', { label: 'UI Ravi' });
    await expect(a.page.locator('#reactionSend')).toBeEnabled();
    await a.page.click('#reactionEmojiGrid [data-emoji="😍"]');
    await a.page.click('#reactionSend');

    await expect(b.page.locator('.reaction-float-emoji', { hasText: '😍' })).toBeVisible({ timeout: 8000 });
    await host.page.waitForTimeout(2500);
    await expect(host.page.locator('.reaction-float-emoji', { hasText: '😍' })).toHaveCount(0);
    await host.ctx.close(); await a.ctx.close(); await b.ctx.close();
  });

  test('reactions lock for everyone once the game has ended', async ({ browser }) => {
    const host = await createRoom(browser);
    const player = await joinRoom(browser, host.code, 'UI Late Reactor');
    await host.page.click('#startBtn');
    await expect(host.page.locator('#endBtn')).toBeEnabled({ timeout: 10_000 });
    host.page.once('dialog', (d) => d.accept()); // window.confirm(...) before ending
    await host.page.click('#endBtn');
    await expect(player.page.locator('#reactionTrigger')).toBeDisabled({ timeout: 15_000 });
    await expect(player.page.locator('#reactionTrigger')).toHaveAttribute('title', /ended/i);
    await host.ctx.close(); await player.ctx.close();
  });

  test('the landing and admin pages have no reaction button', async ({ page }) => {
    for (const url of ['/index.html', '/admin_login.html']) {
      await page.goto(url);
      await expect(page.locator('#reactionTrigger')).toHaveCount(0);
    }
  });
});
