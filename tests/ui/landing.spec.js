// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Landing page', () => {
  test('shows identity form and mode tabs', async ({ page }) => {
    await page.goto('/index.html');
    await expect(page.locator('#nameInput')).toBeVisible();
    await expect(page.locator('#emailInput')).toBeVisible();
    await expect(page.locator('#joinPane')).toBeVisible();
    await expect(page.locator('#hostPane')).toBeHidden();

    await page.click('[data-mode="host"]');
    await expect(page.locator('#hostPane')).toBeVisible();
    await expect(page.locator('#joinPane')).toBeHidden();
  });

  test('does not request private game history on a first landing-page visit', async ({ page }) => {
    const historyRequests = [];
    page.on('request', request => {
      if (request.url().includes('/api/history.php')) historyRequests.push(request.url());
    });
    // Cached identity alone is not proof of a live PHP authentication session.
    await page.addInitScript(() => localStorage.setItem('housiy_identity', JSON.stringify({ name: 'Returning Name', email: 'returning@example.com' })));
    await page.goto('/index.html');
    await page.waitForTimeout(300);
    await expect(page.locator('#loadHistoryBtn')).toHaveCount(0);
    await expect(page.locator('#historyCard')).toBeHidden();
    expect(historyRequests).toHaveLength(0);
  });

  test('blocks room creation without name/email', async ({ page }) => {
    await page.goto('/index.html');
    await page.click('[data-mode="host"]');
    await page.click('#hostBtn');
    await expect(page.locator('#identityError')).toContainText('name and email');
  });

  test('host can create a room and lands on host dashboard', async ({ page }) => {
    await page.goto('/index.html');
    await page.fill('#nameInput', 'UI Test Host');
    await page.fill('#emailInput', `uitest.host.${Date.now()}@example.com`);
    await page.click('[data-mode="host"]');
    await page.fill('#titleInput', 'UI Test Room');
    await page.click('#hostBtn');

    await page.waitForURL(/host\.html\?room=/);
    await expect(page.locator('#roomCodeText')).not.toHaveText('—');
  });

  test('keeps hosted rooms out of Joined Games while showing rooms joined as a player', async ({ browser }) => {
    const userContext = await browser.newContext();
    const userPage = await userContext.newPage();
    const suffix = Date.now();
    const userName = 'History Classification User';
    const userEmail = `history.classification.${suffix}@example.com`;

    // This account creates a room and must see it only under Hosted Games.
    await userPage.goto('/index.html');
    await userPage.fill('#nameInput', userName);
    await userPage.fill('#emailInput', userEmail);
    await userPage.click('[data-mode="host"]');
    await userPage.fill('#titleInput', 'History Hosted Room');
    await userPage.click('#hostBtn');
    await userPage.waitForURL(/host\.html\?room=/);
    const hostedCode = new URL(userPage.url()).searchParams.get('room');

    // Returning home immediately after room creation must show hosted history.
    await userPage.goto('/index.html');
    await expect(userPage.locator('#historyCard')).toBeVisible({ timeout: 5000 });
    await expect(userPage.locator('#hostedList')).toContainText('History Hosted Room');
    await expect(userPage.locator('#hostedList')).toContainText(hostedCode);

    // A different account creates a room for the first account to join.
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await otherPage.goto('/index.html');
    await otherPage.fill('#nameInput', 'History Other Host');
    await otherPage.fill('#emailInput', `history.other.${suffix}@example.com`);
    await otherPage.click('[data-mode="host"]');
    await otherPage.fill('#titleInput', 'History Joined Room');
    await otherPage.click('#hostBtn');
    await otherPage.waitForURL(/host\.html\?room=/);
    const joinedCode = new URL(otherPage.url()).searchParams.get('room');

    await userPage.goto('/index.html');
    await userPage.fill('#nameInput', userName);
    await userPage.fill('#emailInput', userEmail);
    await userPage.fill('#roomCodeInput', joinedCode);
    await userPage.click('#joinBtn');
    await userPage.waitForURL(/player\.html\?room=/);

    // Returning home with the authenticated session automatically loads history.
    await userPage.goto('/index.html');
    await expect(userPage.locator('#historyCard')).toBeVisible({ timeout: 5000 });
    await expect(userPage.locator('#hostedList')).toContainText('History Hosted Room');
    await expect(userPage.locator('#hostedList')).toContainText(hostedCode);
    await userPage.click('[data-htab="joined"]');
    await expect(userPage.locator('#joinedList')).toContainText('History Joined Room');
    await expect(userPage.locator('#joinedList')).toContainText(joinedCode);
    await expect(userPage.locator('#joinedList')).not.toContainText('History Hosted Room');
    await expect(userPage.locator('#joinedList')).not.toContainText(hostedCode);

    await userContext.close();
    await otherContext.close();
  });

});

test.describe('Host dashboard', () => {
  test('start button is enabled in lobby, disabled after game starts', async ({ page }) => {
    await page.goto('/index.html');
    await page.fill('#nameInput', 'UI Test Host 2');
    await page.fill('#emailInput', `uitest.host2.${Date.now()}@example.com`);
    await page.click('[data-mode="host"]');
    await page.click('#hostBtn');
    await page.waitForURL(/host\.html\?room=/);

    await expect(page.locator('#startBtn')).toBeEnabled({ timeout: 5000 });
    await page.click('#startBtn');
    await expect(page.locator('#startBtn')).toBeDisabled({ timeout: 5000 });
    // The server rejects manual calls during the 5-second start countdown
    // (GameEngine::START_COUNTDOWN_SECONDS) and the host UI keeps "Call Next
    // Number" disabled for exactly that long. So it must still be disabled
    // right after Start, and become enabled once the countdown is over -
    // which takes longer than the old 5s timeout by construction.
    await expect(page.locator('#nextBtn')).toBeDisabled();
    await expect(page.locator('#nextBtn')).toBeEnabled({ timeout: 15_000 });
  });

  test('mobile host Next control unlocks automatically after the start countdown', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/index.html');
    await page.fill('#nameInput', 'Mobile UI Host');
    await page.fill('#emailInput', `mobile.host.${Date.now()}@example.com`);
    await page.click('[data-mode="host"]');
    await page.click('#hostBtn');
    await page.waitForURL(/host\.html\?room=/);

    await page.click('#startBtn');
    await expect(page.locator('#nextBtn')).toBeDisabled();
    await expect(page.locator('#nextBtn')).toBeEnabled({ timeout: 15_000 });
    // The control must not require a refresh or pause/resume action.
    await expect(page.locator('#pauseResumeBtn')).toBeEnabled();
  });
});

test.describe('Player join flow', () => {
  test('player sees their ticket after joining', async ({ browser }) => {
    const hostContext = await browser.newContext();
    const hostPage = await hostContext.newPage();
    await hostPage.goto('/index.html');
    await hostPage.fill('#nameInput', 'UI Flow Host');
    await hostPage.fill('#emailInput', `uiflow.host.${Date.now()}@example.com`);
    await hostPage.click('[data-mode="host"]');
    await hostPage.click('#hostBtn');
    await hostPage.waitForURL(/host\.html\?room=/);
    const roomCode = await hostPage.locator('#roomCodeText').textContent();

    const playerContext = await browser.newContext();
    const playerPage = await playerContext.newPage();
    await playerPage.goto('/index.html');
    await playerPage.fill('#nameInput', 'UI Flow Player');
    await playerPage.fill('#emailInput', `uiflow.player.${Date.now()}@example.com`);
    await playerPage.fill('#roomCodeInput', roomCode.trim());
    await playerPage.click('#joinBtn');

    await playerPage.waitForURL(/player\.html\?room=/);
    await expect(playerPage.locator('.housiy-ticket-grid .ticket-cell')).toHaveCount(27); // 3x9 grid

    await hostContext.close();
    await playerContext.close();
  });
});
