import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, resizeWindow, seedHome, setTheme, tid } from "./support";

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

test("streaming and settling preserve the reader's focused Copy control and selected code", async () => {
  const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
  const at = new Date().toISOString();
  const prefix = "```ts\nconst stable = 42;\n```\n\n";
  await app.evaluate(({ BrowserWindow }, { threadId, at, prefix }) => {
    const send = (item: unknown) => BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", { type: "item", threadId, item });
    send({ id: "focus-user", kind: "user", text: "streaming focus fixture", at });
    send({ id: "focus-output", kind: "assistant", text: prefix + "Starting", phase: "final", outcome: "running", at, origin: { thread: threadId, turn: "focus-user", attempt: "focus-attempt", backend: "codex", native: { runtime: "fixture", item: "focus-output" } } });
  }, { threadId, at, prefix });
  const answer = items(page, "assistant").filter({ hasText: "const stable = 42;" });
  const copy = tid(answer, "code-copy");
  await copy.focus();
  await answer.locator("pre code").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  for (let i = 1; i <= 12; i++) {
    await app.evaluate(({ BrowserWindow }, { threadId, text }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", { type: "item_update", threadId, id: "focus-output", patch: { text } });
    }, { threadId, text: prefix + "Starting " + "more output ".repeat(i) });
    await expect(answer).toContainText("more output ".repeat(i).trim());
    await expect(copy).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("const stable = 42;");
  }
  // Exercise the parser's delayed settled render as well as each streaming update.
  await page.waitForTimeout(450);
  await expect(copy).toBeFocused();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("const stable = 42;");
});


test("Markdown stays usable in every theme at minimum size, with keyboard Copy and reduced motion", async ({}, testInfo) => {
  await page.reload();
  await expect(items(page, "assistant").first()).toContainText("export const answer = 42;");
  await page.emulateMedia({ reducedMotion: "reduce" });
  for (const [width, height] of [[900, 600], [1280, 900]]) {
    await resizeWindow(app, page, width!, height!);
    for (const theme of ["graphite", "jev", "coven"] as const) {
      await setTheme(page, theme);
      const answer = items(page, "assistant").first();
      const copy = tid(answer, "code-copy");
      await copy.focus();
      await page.keyboard.press("Enter");
      await expect(copy).toHaveText("Copied");
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("export const answer = 42;");
      expect(await tid(page, "transcript").evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--duration-base").trim())).toMatch(/^0(?:ms|s)$/);
      await expect(copy).toBeFocused();
      const name = `markdown-${theme}-${width}x${height}`;
      const shot = await page.screenshot();
      await testInfo.attach(name, { body: shot, contentType: "image/png" });
      if (process.env.MODEX_SCREENSHOTS) {
        fs.mkdirSync(process.env.MODEX_SCREENSHOTS, { recursive: true });
        fs.writeFileSync(path.join(process.env.MODEX_SCREENSHOTS, `${name}.png`), shot);
      }
    }
  }
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("long code scrolls inside its block at minimum size without widening the transcript", async () => {
  await resizeWindow(app, page, 900, 600);
  const threadId = (await currentRow(page).getAttribute('data-thread-id'))!;
  const code = `const longValue = "${'abcdef'.repeat(80)}";`;
  await app.evaluate(({ BrowserWindow }, { threadId, code }) => {
    BrowserWindow.getAllWindows()[0]!.webContents.send('thread:event', { type: 'item', threadId, item: { id: 'wide-code', kind: 'assistant', text: `\`\`\`ts\n${code}\n\`\`\``, at: new Date().toISOString() } });
  }, { threadId, code });
  const block = items(page, 'assistant').filter({ hasText: 'const longValue' }).locator('pre');
  await expect(block).toHaveText(code);
  expect(await block.evaluate(el => el.scrollWidth - el.clientWidth)).toBeGreaterThan(500);
  await block.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  expect(await block.evaluate(el => el.scrollLeft)).toBeGreaterThan(0);
  expect(await tid(page, 'transcript').evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});
