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
