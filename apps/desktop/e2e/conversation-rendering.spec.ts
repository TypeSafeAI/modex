import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, resizeWindow, seedHome, tid } from "./support";

/**
 * How a reply reads in the transcript (#277). This part covers its Markdown: GitHub-flavoured blocks
 * render as elements, raw HTML stays text, and nothing in a reply runs, fetches or navigates.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;
const dialogs: string[] = [];

const REPLY = [
  "## Result",
  "",
  "| File | Lines |",
  "| :--- | ---: |",
  "| a.ts | 12 |",
  "",
  "> Run the suite before pushing.",
  "",
  "- [x] parser",
  "- [ ] renderer",
  "  1. nested step",
  "",
  "```ts",
  "export const answer = 42;",
  "```",
  "",
  'Inert: <img src="https://example.com/x.png" onerror="alert(1)"> and [a script](javascript:alert(2)) and ![chart](https://example.com/c.png).',
].join("\n");

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  page.on("dialog", (dialog) => { dialogs.push(dialog.message()); void dialog.dismiss(); });
  const script = path.join(home, "rendering-script.json");
  fs.writeFileSync(script, JSON.stringify([{ content: REPLY }]));
  await page.evaluate((mock_script) => window.modex!.invoke("settings:update", { mock_script }), script);
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer-input").fill("summarize the change");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  await expect(items(page, "assistant")).toHaveCount(1);
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a reply's tables, quotes, task lists and code render as elements", async () => {
  const answer = items(page, "assistant").first();
  await expect(answer.getByRole("heading", { name: "Result" })).toBeVisible();
  const table = answer.locator("table");
  await expect(table.getByRole("columnheader")).toHaveText(["File", "Lines"]);
  await expect(table.getByRole("cell")).toHaveText(["a.ts", "12"]);
  await expect(answer.locator("blockquote")).toHaveText("Run the suite before pushing.");
  const boxes = answer.getByRole("checkbox");
  await expect(boxes).toHaveCount(2);
  await expect(boxes.nth(0)).toBeChecked();
  await expect(boxes.nth(1)).not.toBeChecked();
  await expect(boxes.nth(0)).toBeDisabled();
  await expect(answer.locator("li ol li")).toHaveText("nested step");
  await expect(answer.locator('pre.code[data-lang="ts"]')).toHaveText("export const answer = 42;");
});

test("raw HTML, script links and images in a reply stay inert", async () => {
  const answer = items(page, "assistant").first();
  await expect(answer).toContainText('<img src="https://example.com/x.png" onerror="alert(1)">');
  await expect(answer).toContainText("[a script](javascript:alert(2))");
  await expect(answer.locator("img")).toHaveCount(0);
  await expect(answer.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(answer.getByRole("link", { name: "Image: chart" })).toHaveAttribute("href", "https://example.com/c.png");
  expect(dialogs).toEqual([]);
});

test("Copy on a code block puts exactly its code on the clipboard and starts nothing", async () => {
  const answer = items(page, "assistant").first();
  const block = tid(answer, "code-block");
  await expect(block).toContainText("ts");
  // A follow-up suggestion can arrive after the turn ends and grow the composer, which moves the
  // transcript under the pointer mid-click: the likely cause of the one CI run (39112253838) where
  // Copied never showed after a 42 ms click. A missed click copies nothing, so clicking again until
  // Copied shows cannot hide a wrong copy.
  const copy = tid(block, "code-copy");
  await expect(async () => {
    await copy.click();
    await expect(copy).toHaveText("Copied", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("export const answer = 42;");
  await expect(items(page, "tool")).toHaveCount(0);
  await expect(items(page, "approval")).toHaveCount(0);
  await expect(items(page, "user")).toHaveCount(1);
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
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
