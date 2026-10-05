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
    await expectVersion(page, '0.0.7');
    await expect(page.locator('.community-stats')).toBeHidden();
    await expect(page.getByRole('link', { name: 'View TestFlight beta' })).toHaveAttribute('href', invite);
  }
});

test('cached counts are labeled and zero remains a real count', async ({ page }) => {
  await page.route('**/api/release', (route) => route.fulfill({ json: { ...feed(), stats: { stars: 0, downloads: null, forks: 0 }, stale: true } }));
  await page.goto('/');
  await expect(page.getByRole('link', { name: '0 GitHub stars', exact: true })).toBeVisible();
  await expect(page.locator('[data-stat="downloads"]')).toBeHidden();
  await expect(page.locator('[data-stats-note]')).toHaveText('Last available GitHub counts');
});

test('hero stats and TestFlight buttons fit mobile, and walkthrough still fills the viewport', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/release', (route) => route.fulfill({ json: feed() }));
  await page.goto('/');
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.locator('.community-stats')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator('.nav-github')).toBeVisible();
    await page.getByRole('button', { name: 'Play walkthrough', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    const bounds = await dialog.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(width - 2);
    expect(bounds!.x).toBeGreaterThanOrEqual(-1);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  }
});

test('verified download and TestFlight links work without JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:5187');
  await expectVersion(page, '0.0.7');
  await expect(page.getByRole('link', { name: 'View TestFlight beta' })).toHaveAttribute('href', invite);
  await context.close();
});
