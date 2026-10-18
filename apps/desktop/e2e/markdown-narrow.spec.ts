import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, resizeWindow, seedHome, tid } from "./support";

/**
 * Markdown at the 900x600 minimum (#277): with the Review panel open the transcript is about 265 px
 * wide. A wide table and a long code line scroll inside their own boxes, and no table column is
 * squeezed to a word, in every theme.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

const WIDE = [
  "| Path | Change | Detail |",
  "| --- | --- | --- |",
  "| apps/desktop/src/renderer/components/transcript/CodeBlock.tsx | added | " + "a long cell that keeps going ".repeat(8) + "|",
  "",
  "```ts",
  "export const aVeryLongLineOfCode = [" + Array.from({ length: 30 }, (_, i) => `"item-${i}"`).join(", ") + "];",
  "```",
].join("\n");

test("a reply's tables and code stay readable in every theme at the 900×600 minimum", async ({}, testInfo) => {
  const script = path.join(home, "wide-script.json");
  fs.writeFileSync(script, JSON.stringify([{ content: WIDE }]));
  await page.evaluate((mock_script) => window.modex!.invoke("settings:update", { mock_script }), script);
  const replies = await items(page, "assistant").count();
  await tid(page, "composer-input").fill("show the wide table");
  await page.keyboard.press("Meta+Enter");
  // Wait for this reply itself, then for the turn to end: the thread was already idle before it.
  await expect(items(page, "assistant")).toHaveCount(replies + 1, { timeout: 20_000 });
  await expect(items(page, "assistant").last()).toContainText("aVeryLongLineOfCode");
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
  const answer = items(page, "assistant").last();
  await expect(answer.locator("table")).toBeVisible();
  await resizeWindow(app, page, 900, 600);
  for (const theme of ["graphite", "jev", "coven"]) {
    await page.evaluate((value) => window.modex!.invoke("settings:update", { theme: value }), theme);
    await answer.scrollIntoViewIfNeeded();
    // The page never scrolls sideways: a wide table and a long code line scroll inside their own boxes.
    expect(await tid(page, "transcript").evaluate((el) => el.scrollWidth - el.clientWidth), `${theme}: no sideways page scroll`).toBeLessThanOrEqual(0);
    expect(await answer.locator(".md-table").evaluate((el) => el.scrollWidth > el.clientWidth), `${theme}: the table scrolls in its box`).toBe(true);
    // No column is squeezed to a word: before cells had a minimum width, Detail measured 58 px and its row 1,009 px tall.
    const narrowest = await answer.locator("td").evaluateAll((cells) => Math.min(...cells.map((c) => c.getBoundingClientRect().width / parseFloat(getComputedStyle(c).fontSize))));
    expect(narrowest, `${theme}: every cell is at least about ten characters wide`).toBeGreaterThanOrEqual(9.5);
    expect(await answer.locator("pre.code").evaluate((el) => el.scrollWidth > el.clientWidth), `${theme}: the code scrolls in its box`).toBe(true);
    await expect(tid(answer, "code-copy")).toBeVisible();
    await answer.locator("table").evaluate((table) => table.scrollIntoView({ block: "start" }));
    const shot = await page.screenshot();
    await testInfo.attach(`markdown-${theme}-900x600`, { body: shot, contentType: "image/png" });
    // MODEX_SCREENSHOTS=<dir> keeps them for review evidence.
    if (process.env.MODEX_SCREENSHOTS) fs.writeFileSync(path.join(process.env.MODEX_SCREENSHOTS, `markdown-${theme}-900x600.png`), shot);
  }
});
