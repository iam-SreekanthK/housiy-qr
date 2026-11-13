// Visual/layout regression checks for the original vanilla HTML UI.
// This does not redesign pages or update screenshot baselines automatically.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const output = path.resolve(__dirname, '../../tests/ui/visual-results');
const pages = [
  { path: '/index.html', name: 'landing' },
  { path: '/player.html', name: 'player' },
  { path: '/admin_login.html', name: 'admin-login' },
];

test.describe('Original UI visual integrity', () => {
  test.beforeAll(() => fs.mkdirSync(output, { recursive: true }));

  for (const item of pages) {
    test(`${item.name}: stylesheets load and layout is not browser-default`, async ({ page }) => {
      const failedCss = [];
      page.on('requestfailed', req => {
        if (req.resourceType() === 'stylesheet') failedCss.push(`${req.url()} :: ${req.failure()?.errorText || 'failed'}`);
      });
      await page.setViewportSize({ width: 1365, height: 900 });
      await page.goto(item.path, { waitUntil: 'networkidle' });
      await expect(page.locator('body')).toBeVisible();

      const state = await page.evaluate(() => {
        const body = getComputedStyle(document.body);
        const css = [...document.styleSheets].map(s => s.href).filter(Boolean);
        const glass = document.querySelector('.glass:not(.navbar)');
        const brand = document.querySelector('.brand');
        const form = document.querySelector('input, button, .form-control, .btn');
        return {
          background: body.backgroundImage,
          backgroundColor: body.backgroundColor,
          font: body.fontFamily,
          css,
          glassBorderRadius: glass ? getComputedStyle(glass).borderRadius : null,
          brandFont: brand ? getComputedStyle(brand).fontFamily : null,
          controlFont: form ? getComputedStyle(form).fontFamily : null,
          viewportWidth: document.documentElement.clientWidth,
          documentWidth: document.documentElement.scrollWidth
        };
      });
      expect(failedCss, `Failed CSS requests: ${failedCss.join('; ')}`).toEqual([]);
      expect(state.css.some(url => url.includes('assets/css/style.css'))).toBeTruthy();
      expect(state.font).not.toMatch(/^"Times New Roman"|^serif$/i);
      expect(state.documentWidth).toBeLessThanOrEqual(state.viewportWidth + 2);
      if (item.name === 'admin-login') {
        await expect(page.locator('#username')).toBeVisible();
        await expect(page.locator('#password')).toBeVisible();
        await expect(page.locator('#loginBtn')).toBeVisible();
        expect(state.glassBorderRadius).not.toBe('0px');
      }
      await page.screenshot({ path: path.join(output, `${item.name}.png`), fullPage: true });
      fs.writeFileSync(path.join(output, `${item.name}.json`), JSON.stringify(state, null, 2));
    });
  }
});
