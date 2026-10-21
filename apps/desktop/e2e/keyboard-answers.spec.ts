import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * Someone answering an approval with the keyboard or VoiceOver must keep their place. The answer
 * buttons go away once pressed, and a finished turn hides its folded work, and either used to leave
 * focus on the page body (found by the CF-8 keyboard walkthrough on 2026-10-20).
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

// About 2.4 s of streaming at the desktop mock's 30 ms a word, so the answered card is still on screen.
const reply = `Writing it now. ${Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ")}`;

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  const script = path.join(home, "keyboard-script.json");
  fs.writeFileSync(script, JSON.stringify({ steps: [
    { tool_calls: [{ name: "write_file", arguments: { path: "keyboard.txt", content: "answered" } }] },
    { content: reply },
  ] }));
  await page.evaluate((script) => window.modex!.invoke("settings:update", { mock_script: script }), script);
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

async function answerFromKeyboard(button: "Approve" | "Deny") {
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await page.keyboard.type(`Write keyboard.txt, then ${button.toLowerCase()}`);
  await page.keyboard.press("Meta+Enter");
  const card = items(page, "approval").last();
  await card.getByRole("button", { name: button, exact: true }).focus();
  await page.keyboard.press("Enter");
  return card;
}

test("Approve from the keyboard moves focus to the card's answer, then to the turn's toggle when its work folds", async () => {
  const card = await answerFromKeyboard("Approve");
  await expect(tid(card, "approval-answer")).toBeFocused();
  await expect(tid(card, "approval-answer")).toHaveText("Approved");
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
  await expect(card).toBeHidden();
  await expect(tid(page, "turn-label").last()).toHaveAttribute("aria-expanded", "false");
  await expect(tid(page, "turn-label").last()).toBeFocused();
});

test("Deny from the keyboard does the same: the card's answer, then the turn's toggle once the denied card folds", async () => {
  const card = await answerFromKeyboard("Deny");
  await expect(tid(card, "approval-answer")).toBeFocused();
  await expect(tid(card, "approval-answer")).toHaveText("Denied");
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
  await expect(card).toBeHidden();
  await expect(tid(page, "turn-label").last()).toBeFocused();
});

test("a turn that finishes while the reader is in the composer leaves focus there", async () => {
  await page.keyboard.press("Meta+n");
  await page.keyboard.type("Write keyboard.txt, then approve with the mouse");
  await page.keyboard.press("Meta+Enter");
  await items(page, "approval").last().getByRole("button", { name: "Approve", exact: true }).click();
  await tid(page, "composer-input").focus();
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
  await expect(tid(page, "composer-input")).toBeFocused();
});

test("Stop from the keyboard hands focus to the composer once the turn ends", async () => {
  await page.keyboard.press("Meta+n");
  await page.keyboard.type("Write keyboard.txt, then stop");
  await page.keyboard.press("Meta+Enter");
  await expect(currentRow(page)).toHaveAttribute("data-status", /running|waiting/);
  await tid(page, "stop").focus();
  await page.keyboard.press("Enter");
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
  await expect(tid(page, "stop")).toHaveCount(0);
  await expect(tid(page, "composer-input")).toBeFocused();
});

test("Jump to latest from the keyboard hands focus to the message box at the bottom", async () => {
  // Enough finished turns for the transcript to scroll.
  for (let turn = 0; turn < 3; turn++) {
    await tid(page, "composer-input").focus();
    await page.keyboard.type(`Turn ${turn} for scrolling`);
    await page.keyboard.press("Meta+Enter");
    await items(page, "approval").last().getByRole("button", { name: "Approve", exact: true }).click();
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
  }
  await tid(page, "turn-label").last().focus();
  await expect(async () => {
    await page.keyboard.press("PageUp");
    await expect(tid(page, "jump-latest")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await tid(page, "jump-latest").focus();
  await page.keyboard.press("Enter");
  await expect(tid(page, "jump-latest")).toHaveCount(0);
  await expect(tid(page, "composer-input")).toBeFocused();
});

/** Enough finished turns for the transcript to scroll, whatever ran before (a failed test restarts the app). */
async function ensureScrollable() {
  for (let turn = 0; turn < 4 && !(await tid(page, "transcript").evaluate((el) => el.scrollHeight > el.clientHeight + 300).catch(() => false)); turn++) {
    if (!(await tid(page, "composer-input").count())) await page.keyboard.press("Meta+n");
    await tid(page, "composer-input").focus();
    await page.keyboard.type(`Turn ${turn} for scrolling`);
    await page.keyboard.press("Meta+Enter");
    await items(page, "approval").last().getByRole("button", { name: "Approve", exact: true }).click();
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
  }
}

/** Page Up until Jump to latest shows, then let the keyboard scroll finish, so a test controls what happens next. */
async function scrollUpAndSettle() {
  await ensureScrollable();
  await tid(page, "turn-label").last().focus();
  await expect(async () => {
    await page.keyboard.press("PageUp");
    await expect(tid(page, "jump-latest")).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  await expect.poll(async () => {
    const a = await tid(page, "transcript").evaluate((el) => el.scrollTop);
    await page.waitForTimeout(100);
    return a === await tid(page, "transcript").evaluate((el) => el.scrollTop);
  }).toBe(true);
}
const gap = () => tid(page, "transcript").evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);

test("after Jump to latest, the transcript stays at the bottom when the composer grows before the scroll event", async () => {
  // A follow-up chip can appear in the composer right after the jump (#347). The jump's scroll event then
  // measured a shorter view and decided the reader had left the bottom, so the button stayed.
  await scrollUpAndSettle();
  await tid(page, "jump-latest").focus();
  // The jump and the growth in one task, so the growth lands before the jump's scroll event is delivered.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement).click();
    (document.querySelector('[data-testid="composer"]') as HTMLElement).style.paddingTop = "120px";
  });
  await page.waitForTimeout(500);
  await expect(tid(page, "jump-latest")).toHaveCount(0);
  expect(await gap()).toBeLessThanOrEqual(2);
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer").evaluate((el) => { (el as HTMLElement).style.paddingTop = ""; });
});

test("a Page Up still animating when Jump to latest is pressed does not carry the view back up", async () => {
  // The keyboard scroll keeps applying its remaining distance after the page sets a new position; on a
  // slow runner the reader's Enter on Jump to latest lands mid-animation (#347).
  await ensureScrollable();
  await tid(page, "transcript").evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(tid(page, "jump-latest")).toHaveCount(0);
  await tid(page, "turn-label").last().focus();
  await page.keyboard.press("PageUp");
  await expect(tid(page, "jump-latest")).toBeVisible();
  await page.evaluate(() => (document.querySelector('[data-testid="jump-latest"]') as HTMLElement).click());
  await page.waitForTimeout(600);
  expect(await gap()).toBeLessThanOrEqual(2);
  await expect(tid(page, "jump-latest")).toHaveCount(0);
});

test("after Jump to latest, the reader scrolling up again is followed at once", async () => {
  await scrollUpAndSettle();
  await page.evaluate(() => (document.querySelector('[data-testid="jump-latest"]') as HTMLElement).click());
  await expect(tid(page, "jump-latest")).toHaveCount(0);
  await tid(page, "transcript").hover();
  await page.mouse.wheel(0, -400);
  await expect(tid(page, "jump-latest")).toBeVisible();
  expect(await gap()).toBeGreaterThan(2);
});
