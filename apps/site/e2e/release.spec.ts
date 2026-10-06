import { test, expect, type Page } from '@playwright/test';

const repo = 'https://github.com/TypeSafeAI/modex';
const invite = 'https://testflight.apple.com/join/Qr14JKCh';
function feed(version = '0.0.8') {
  return { release: { version, url: `${repo}/releases/tag/v${version}`, downloadUrl: `${repo}/releases/download/v${version}/Modex-${version}-arm64.dmg` },
    stats: { stars: 1234, downloads: 5678, forks: 42 }, checkedAt: '2026-10-05T20:00:00Z', stale: false };
}
async function expectVersion(page: Page, version: string) {
  await expect(page.locator('[data-release-version]')).toHaveText([`v${version}`, `v${version}`]);
  for (const a of await page.locator('[data-mac-download]').all()) await expect(a).toHaveAttribute('href', feed(version).release.downloadUrl);
  for (const a of await page.locator('[data-release-link]').all()) await expect(a).toHaveAttribute('href', feed(version).release.url);
}

test('finds a new release while the page stays open, with accurate counts and public TestFlight actions', async ({ page }) => {
  await page.clock.install();
  let latest = feed(); let calls = 0;
  await page.route('**/api/release', (route) => { calls++; return route.fulfill({ json: latest }); });
  await page.goto('/');
  await expectVersion(page, '0.0.8');
  await expect(page.getByRole('link', { name: '1,234 GitHub stars', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: '5,678 Mac downloads', exact: true })).toContainText('5.7K');
  await expect(page.locator('[data-stat="downloads"]')).toHaveAttribute('title', /not unique users/);
  await expect(page.getByRole('link', { name: '42 GitHub forks', exact: true })).toBeVisible();
  await expect(page.locator(`a[href="${invite}"]`)).toHaveCount(3);
  await expect(page.locator('body')).not.toContainText('Coming soon');
  latest = feed('0.0.9');
  await page.clock.fastForward(5 * 60_000);
  await expectVersion(page, '0.0.9');
  await page.evaluate(() => { for (let i = 0; i < 10; i++) window.dispatchEvent(new Event('focus')); });
  expect(calls).toBe(2);
  // An older CDN response cannot roll back links already seen in this page.
  latest = feed('0.0.8');
  await page.clock.fastForward(5 * 60_000);
  await expect.poll(() => calls).toBe(3);
  await expectVersion(page, '0.0.9');
});

test('offline, partial and hostile responses keep all verified fallback links usable', async ({ page }) => {
  let response: object | undefined;
  await page.route('**/api/release', (route) => response ? route.fulfill({ json: response }) : route.abort());
  for (const candidate of [undefined, { release: { version: '0.0.8' } }, { ...feed(), release: { ...feed().release, downloadUrl: 'https://example.com/untrusted.dmg' }, stats: { stars: '9999', downloads: -1 } }]) {
    response = candidate;
    await page.goto('/');
    await expectVersion(page, '0.0.8');
    await expect(page.locator('.community-stats')).toBeHidden();
    await expect(page.getByRole('link', { name: 'iPhone companion TestFlight' })).toHaveAttribute('href', invite);
  }
});

test('cached counts are labeled and zero remains a real count', async ({ page }) => {
  await page.route('**/api/release', (route) => route.fulfill({ json: { ...feed(), stats: { stars: 0, downloads: null, forks: 0 }, stale: true } }));
  await page.goto('/');
  await expect(page.getByRole('link', { name: '0 GitHub stars', exact: true })).toBeVisible();
  await expect(page.locator('[data-stat="downloads"]')).toBeHidden();
  await expect(page.locator('[data-stats-note]')).toHaveText('Last available GitHub counts');
});

test('headerless landing and all carousel steps fit the viewport, with details available on demand', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/release', (route) => route.fulfill({ json: feed() }));
  await page.goto('/');
  await expect(page.locator('body > header, #play-story, #walkthrough-dialog')).toHaveCount(0);
  for (const [width, height] of [[320, 568], [375, 667], [390, 844], [768, 1024], [1024, 768], [1440, 900], [1920, 1080], [844, 390], [667, 375]]) {
    await page.setViewportSize({ width, height });
    await expect(page.locator('.community-stats')).toBeVisible();
    expect(await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }))).toEqual({ width, height });
    const main = (await page.locator('main').boundingBox())!;
    expect(main.y).toBe(0);
    const copy = (await page.locator('.hero-copy').boundingBox())!;
    expect(copy.y).toBeGreaterThanOrEqual(main.y);
    expect(copy.y + copy.height).toBeLessThanOrEqual(main.y + main.height);
    for (const selector of ['.hero-actions .button', '.hero-actions .text-link', '[data-scene-step="0"]', '[data-scene-step="1"]', '[data-scene-step="2"]', '.site-footer']) {
      const box = (await page.locator(selector).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(height + 1);
    }
    for (let step = 0; step < 3; step++) {
      await page.locator(`[data-scene-step="${step}"]`).click();
      await expect(page.locator('.showcase')).toHaveAttribute('data-step', String(step));
      for (const selector of ['#desktop-screen', '#phone-screen']) {
        const image = (await page.locator(selector).boundingBox())!;
        expect(image.width).toBeGreaterThan(0);
        expect(image.height).toBeGreaterThan(0);
        expect(image.x).toBeGreaterThanOrEqual(0);
        expect(image.y).toBeGreaterThanOrEqual(0);
        expect(image.x + image.width).toBeLessThanOrEqual(width + 1);
        expect(image.y + image.height).toBeLessThanOrEqual(height + 1);
      }
    }
    await expect(page.locator('.site-footer').getByRole('link', { name: 'GitHub' })).toBeVisible();
    await page.getByRole('link', { name: 'About Modex', exact: true }).click();
    const details = page.getByRole('dialog', { name: 'More about Modex' });
    await expect(details).toBeVisible();
    await details.getByRole('link', { name: 'View TestFlight beta' }).scrollIntoViewIfNeeded();
    await expect(details.getByRole('link', { name: 'View TestFlight beta' })).toBeInViewport();
    await page.getByRole('button', { name: 'Close details' }).click();
    await expect(details).toBeHidden();
    await expect(page.getByRole('link', { name: 'About Modex', exact: true })).toBeFocused();
    await page.getByRole('link', { name: 'About Modex', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(details).toBeHidden();
  }
});

test('carousel loops automatically until a step is clicked or activated by keyboard', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.route('**/api/release', (route) => route.fulfill({ json: feed() }));
  for (const activation of ['click', 'keyboard']) {
    await page.goto('/');
    await expect(page.locator('.scene-description')).toHaveAttribute('aria-live', 'off');
    for (const step of [1, 2, 0, 1]) {
      await page.clock.runFor(4_000);
      await expect(page.locator('.showcase')).toHaveAttribute('data-step', String(step));
    }
    const choice = page.getByRole('button', { name: 'Keep it moving' });
    if (activation === 'click') await choice.click();
    else { await choice.focus(); await page.keyboard.press('Enter'); }
    await expect(choice).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.scene-description')).toHaveAttribute('aria-live', 'polite');
    await page.clock.runFor(16_000);
    await expect(page.locator('.showcase')).toHaveAttribute('data-step', '2');
    // Temporary interruptions must not undo the visitor's manual selection.
    await page.getByRole('link', { name: 'About Modex', exact: true }).click();
    await page.keyboard.press('Escape');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.clock.runFor(8_000);
    await expect(page.locator('.showcase')).toHaveAttribute('data-step', '2');
  }
});

test('carousel respects reduced motion and pauses while details are open', async ({ page }) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/release', (route) => route.fulfill({ json: feed() }));
  await page.goto('/');
  await page.clock.runFor(12_000);
  await expect(page.locator('.showcase')).toHaveAttribute('data-step', '0');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.clock.runFor(4_000);
  await expect(page.locator('.showcase')).toHaveAttribute('data-step', '1');
  await page.getByRole('link', { name: 'About Modex', exact: true }).click();
  await page.clock.runFor(12_000);
  await expect(page.locator('.showcase')).toHaveAttribute('data-step', '1');
  await page.keyboard.press('Escape');
  await page.clock.runFor(4_000);
  await expect(page.locator('.showcase')).toHaveAttribute('data-step', '2');
});

test('verified download and TestFlight links work without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5187');
  await expectVersion(page, '0.0.8');
  await expect(page.getByRole('link', { name: 'iPhone companion TestFlight' })).toHaveAttribute('href', invite);
  await context.close();
});
