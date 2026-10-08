import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { launch, seedHome, tid, createThread } from './support';

test('reference shell keeps title actions reachable and matches the compact neutral layout', async ({}, testInfo) => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    await createThread(page, 'Assess codebase and optimize');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(2177, 1050));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'graphite');
    await expect(tid(page, 'sidebar')).toHaveCSS('width', '344px');
    await expect(tid(page, 'titlebar')).toHaveCSS('height', '44px');
    await expect(tid(page, 'titlebar').locator('.titlebar-folder')).toBeVisible();
    const row = page.locator('.thread-row').first();
    await tid(page, 'composer-input').focus();
    await row.hover();
    await expect(row.locator('.thread-provider-line')).toBeVisible();
    await expect(row.locator('.thread-context-line')).toBeVisible();
    await tid(page, 'titlebar').hover();
    await expect(row.locator('.thread-provider-line')).toBeHidden();
    const rightEdge = async () => {
      const b = (await tid(page, 'changes-toggle').boundingBox())!;
      return Math.abs(b.x + b.width - (await page.evaluate(() => innerWidth) - 10));
    };
    await expect.poll(rightEdge).toBeLessThanOrEqual(1);
    await tid(page, 'changes-toggle').click();
    await expect.poll(rightEdge).toBeLessThanOrEqual(1);
    if (await tid(page, 'workspace').isVisible()) await tid(page, 'changes-toggle').click();
    await expect(tid(page, 'repository-overview')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('reference-shell.png'), animations: 'disabled' });
    await tid(page, 'repository-overview').getByRole('button', { name: /Changes/ }).click();
    await expect(tid(page, 'workspace')).toBeVisible();
    await tid(page, 'changes-toggle').click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 760));
    await expect(tid(page, 'repository-overview')).toBeHidden();
    await expect.poll(rightEdge).toBeLessThanOrEqual(1);
    await tid(page, 'thread-title').dblclick();
    await tid(page, 'thread-title').fill('A renamed thread');
    await page.keyboard.press('Enter');
    await expect(tid(page, 'thread-title')).toHaveValue('A renamed thread');
    await tid(page, 'sidebar-toggle').click();
    await expect(tid(page, 'sidebar')).toHaveCount(0);
    await expect.poll(rightEdge).toBeLessThanOrEqual(1);
  } finally { await app.close(); for (const dir of [home, repo]) fs.rmSync(dir, { recursive: true, force: true }); }
});
