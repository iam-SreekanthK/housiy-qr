// @ts-check
// Complete game THROUGH THE UI: one host browser + two independent player browsers.
// Drives only real page controls (landing form, Start, Call next, ticket cells, claim buttons)
// and finishes by cross-checking what the UI shows against /api/results.php.
// Runs against DEV/UAT only (it creates rooms/users). ~2-4 minutes: a full game needs up to 90 calls.
const { test, expect } = require('@playwright/test');

const PRIZES = [
  { key: 'FIRST_FIVE', label: 'First Five' }, { key: 'TOP_ROW', label: 'Top Row' },
  { key: 'MIDDLE_ROW', label: 'Middle Row' }, { key: 'BOTTOM_ROW', label: 'Bottom Row' },
  { key: 'FULL_HOUSE', label: 'Full House' },
];
const uniq = (p) => `${p}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@uitest.example.com`;

/** Reads the ticket as 27 row-major cells (3 rows x 9 cols). */
async function readTicket(page) {
  return page.locator('#ticketContainer .ticket-cell').evaluateAll((els) =>
    els.map((e) => ({ blank: e.classList.contains('blank'), marked: e.classList.contains('marked'), n: parseInt(e.textContent || '0', 10) })));
}
function eligible(cells, key, winnersText) {
  const rowOk = (r) => { const row = cells.slice(r * 9, r * 9 + 9).filter((c) => !c.blank); return row.length === 5 && row.every((c) => c.marked); };
  const marked = cells.filter((c) => !c.blank && c.marked).length;
  switch (key) {
    case 'TOP_ROW': return rowOk(0);
    case 'MIDDLE_ROW': return rowOk(1);
    case 'BOTTOM_ROW': return rowOk(2);
    case 'FIRST_FIVE': return marked >= 5;
    case 'FULL_HOUSE': return marked === 15 && PRIZES.slice(0, 4).every((p) => winnersText.includes(p.label));
    default: return false;
  }
}

test.describe('Full game via the UI', () => {
  test.setTimeout(420_000);

  test('host + 2 players play a complete game; UI and backend agree on the winners', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const ctxs = [await browser.newContext(), await browser.newContext()];
    const host = await hostCtx.newPage();
    const players = await Promise.all(ctxs.map((c) => c.newPage()));

    // ---- host creates a room (manual calling: auto-call off) ----
    await host.goto('/index.html');
    await host.fill('#nameInput', 'UI Host');
    await host.fill('#emailInput', uniq('host'));
    await host.click('[data-mode="host"]');
    await host.fill('#titleInput', `UI Game ${Date.now()}`);
    await host.fill('#maxPlayersInput', '10');
    await host.uncheck('#autoCallToggle');
    await host.click('#hostBtn');
    await host.waitForURL(/host\.html\?room=/);
    const code = (await host.locator('#roomCodeText').innerText()).trim();
    expect(code).toMatch(/^[A-Z0-9]{8}$/);
    await expect(host.locator('#roomStatusPill')).toContainText(/lobby/i);

    // ---- players join through the landing form ----
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      await p.goto('/index.html');
      await p.fill('#nameInput', `UI Player ${i + 1}`);
      await p.fill('#emailInput', uniq(`p${i}`));
      await p.fill('#roomCodeInput', code);
      await p.click('#joinBtn');
      await p.waitForURL(/player\.html\?room=/);
      await expect(p.locator('#roomTitleText')).toContainText(code);
      await expect(p.locator('#ticketContainer .ticket-cell:not(.blank)')).toHaveCount(15);   // a valid 15-number ticket
      await expect(p.locator('#claimButtons .claim-btn')).toHaveCount(5);
    }
    await expect(host.locator('#playerCount')).toHaveText(/^3$/, { timeout: 20_000 });   // host + 2 (updates live)
    await expect(host.locator('#playersList')).toContainText('UI Player 1');

    // ---- start; countdown must block calling, then enable it ----
    await host.click('#startBtn');
    await expect(host.locator('#roomStatusPill')).toContainText(/live/i, { timeout: 15_000 });
    await expect(host.locator('#nextBtn')).toBeEnabled({ timeout: 20_000 });
    for (const p of players) await expect(p.locator('#roomStatusPill')).toContainText(/live/i, { timeout: 15_000 });

    // ---- play: call, everybody taps their numbers, eligible players claim ----
    let done = false;
    for (let call = 1; call <= 90 && !done; call++) {
      await host.click('#nextBtn');
      await expect(host.locator('#calledCount')).toHaveText(String(call), { timeout: 15_000 });
      const n = (await host.locator('#currentNumberDisplay').innerText()).trim();

      await Promise.all(players.map(async (p) => {
        await expect(p.locator('#currentNumberDisplay')).toHaveText(n, { timeout: 15_000 });     // real-time delivery to the player UI
        const cell = p.locator('#ticketContainer .ticket-cell:not(.blank)', { hasText: new RegExp(`^${n}$`) });
        if (await cell.count()) {
          await cell.first().click();
          await expect(cell.first()).toHaveClass(/marked/, { timeout: 10_000 });
        }
      }));

      for (const p of players) {
        const cells = await readTicket(p);
        const winnersText = await p.locator('#winnersList').innerText();
        for (const pr of PRIZES) {
          if (winnersText.includes(pr.label) || !eligible(cells, pr.key, winnersText)) continue;
          const btn = p.locator(`.claim-btn[data-prize="${pr.key}"]`);
          if (await btn.isDisabled()) continue;
          await btn.click();
          await p.waitForTimeout(300);
        }
      }
      const status = (await host.locator('#roomStatusPill').innerText()).toLowerCase();
      if (/completed|ended/.test(status)) done = true;
      else await host.waitForTimeout(500);                                   // stay under the call-rate policy
    }
    await expect(host.locator('#roomStatusPill')).toContainText(/completed|ended/i, { timeout: 20_000 });

    // ---- final state: every prize has exactly one winner, identical on every screen ----
    for (const page of [host, ...players]) {
      const text = await page.locator('#winnersList').innerText();
      for (const pr of PRIZES) {
        const occurrences = text.split(pr.label).length - 1;
        expect(occurrences, `${pr.label} winners shown`).toBe(1);
      }
    }
    await expect(host.locator('#rematchBtn')).toBeVisible();

    // ---- UI vs backend: the persisted result must say the same thing ----
    const res = await hostCtx.request.get(`/api/results.php?room_code=${code}`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.room.status).toBe('COMPLETED');
    expect(body.winners.map((w) => w.prize_type).sort()).toEqual(PRIZES.map((p) => p.key).sort());
    expect(body.game.numbers_called_count).toBeGreaterThanOrEqual(15);

    await Promise.all([hostCtx, ...ctxs].map((c) => c.close()));
  });
});
