import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

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
  await tid(block, "code-copy").click();
  await expect(tid(block, "code-copy")).toHaveText("Copied");
  expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("export const answer = 42;");
  await expect(items(page, "tool")).toHaveCount(0);
  await expect(items(page, "approval")).toHaveCount(0);
  await expect(items(page, "user")).toHaveCount(1);
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
});
