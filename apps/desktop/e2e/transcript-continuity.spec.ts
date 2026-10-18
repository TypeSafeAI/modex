import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * A reply that finishes streaming must not take away what the reader is doing with it (#277):
 * text they selected stays selected, and the control they focused keeps focus.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

// A short opening the reader can act on, then about 200 words more at the mock's 30 ms a word.
const REPLY = ["Select this sentence.", "", "```ts", "const answer = 42;", "```", "", ...Array.from({ length: 50 }, (_, i) => `Line ${i + 1} keeps streaming.`)].join("\n\n");

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  const script = path.join(home, "continuity-script.json");
  fs.writeFileSync(script, JSON.stringify([{ content: REPLY }]));
  await page.evaluate((mock_script) => window.modex!.invoke("settings:update", { mock_script }), script);
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

async function sendAndWaitForOpening(text: string): Promise<void> {
  await tid(page, "composer-input").fill(text);
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  await expect(tid(items(page, "assistant").last(), "code-block")).toBeVisible();
  await expect(currentRow(page)).toHaveAttribute("data-status", "running");
}

/** After the turn ends, past the moment the reply is parsed whole. */
async function waitUntilSettled(): Promise<void> {
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
  await page.waitForTimeout(800);
}

test("text selected in a reply while it streams stays selected after the reply finishes", async () => {
  await sendAndWaitForOpening("stream a reply to select from");
  const selected = await items(page, "assistant").last().evaluate((answer) => {
    const paragraph = [...answer.querySelectorAll("p")].find((p) => p.textContent === "Select this sentence.")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(selected).toBe("Select this sentence.");
  await waitUntilSettled();
  const after = await page.evaluate(() => {
    const selection = window.getSelection()!;
    return { text: selection.toString(), connected: selection.anchorNode?.isConnected ?? false };
  });
  expect(after).toEqual({ text: "Select this sentence.", connected: true });
});

test("a code block's Copy focused while the reply streams keeps focus after the reply finishes", async () => {
  await sendAndWaitForOpening("stream a reply with code");
  const copy = tid(items(page, "assistant").last(), "code-copy");
  await copy.focus();
  await expect(copy).toBeFocused();
  await waitUntilSettled();
  await expect(copy).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.isConnected && document.activeElement.getAttribute("data-testid"))).toBe("code-copy");
});
