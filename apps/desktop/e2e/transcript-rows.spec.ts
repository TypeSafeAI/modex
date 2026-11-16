import { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * The transcript as one quiet column: a turn is one element, its status is a small line with a dot while
 * it is live, work is a list of 34 px rows with an icon tile, an answered approval is a receipt row, reply
 * actions show for the turn pointed at, and Jump to latest is a square icon button that keeps its name.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

const at = "2026-11-16T10:00:00.000Z";
const long = Array.from({ length: 60 }, (_, i) => `Paragraph ${i}. ${"text ".repeat(30)}`).join("\n\n");
const row = (id: string) => page.locator(`[data-testid="thread-row"][data-thread-id="${id}"]`);
const height = async (locator: Locator) => Math.round((await locator.boundingBox())!.height);

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.threads = ["rows-saved", "rows-two-turns"].map((id) => ({ id, projectId: "p1", title: id, createdAt: at, updatedAt: at, cwd: repo, backend: "mock", model: "mock", mode: "chat", plan: false, status: "idle" }));
  fs.writeFileSync(statePath, JSON.stringify(state));
  // A turn that never answered: its work stays in view. The approval was saved mid-delivery.
  fs.writeFileSync(path.join(home, "app/threads/rows-saved.json"), JSON.stringify([
    { id: "u", kind: "user", text: "Run the checks", at },
    { id: "command", kind: "tool", name: "shell", title: "$ npm test", args: { command: "npm test" }, output: "ok", status: "done", ok: true, at },
    { id: "mystery", kind: "tool", name: "mystery_tool", title: "mystery_tool", args: {}, status: "done", ok: true, at },
    { id: "stopped", kind: "approval", question: "Allow the first push?", answer: "no", withdrawn: "stopped", at },
    { id: "sending", kind: "approval", question: "Allow the deploy?", detail: "deploy --prod", answer: "yes", delivery: "sending", at },
  ]));
  fs.writeFileSync(path.join(home, "app/threads/rows-two-turns.json"), JSON.stringify([
    { id: "u1", kind: "user", text: "First question", at },
    { id: "a1", kind: "assistant", text: long, at },
    { id: "u2", kind: "user", text: "Second question", at },
    { id: "a2", kind: "assistant", text: "Second answer.", at },
  ]));
  ({ app, page } = await launch(home));
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("saved work reads as rows: a verb for a command, an icon for every tool, and receipts for closed approvals", async () => {
  await row("rows-saved").click();
  const command = items(page, "tool").filter({ hasText: "$ npm test" });
  await expect(tid(command, "tool-verb")).toHaveText("Ran");
  await expect(tid(command, "tool-summary")).toHaveText("$ npm test");
  await expect(tid(command, "item-toggle")).toHaveAttribute("aria-label", "Done: $ npm test");
  expect(await height(tid(command, "item-toggle"))).toBe(34);
  const tile = command.locator(".tool-icon");
  expect(await tile.boundingBox()).toMatchObject({ width: 22, height: 22 });
  await expect(tile.locator("svg")).toHaveAttribute("data-icon", "terminal");
  // A tool the app has no picture for keeps its summary, with the generic icon and no verb.
  const mystery = items(page, "tool").filter({ hasText: "mystery_tool" });
  await expect(tid(mystery, "tool-verb")).toHaveCount(0);
  await expect(mystery.locator(".tool-icon svg")).toHaveAttribute("data-icon", "shapes");

  // A request that closed unanswered is a neutral row with the reason, never "Denied".
  const stopped = items(page, "approval").first();
  await expect(stopped).toHaveClass(/approval-receipt/);
  await expect(stopped).toHaveClass(/\bneutral\b/);
  await expect(tid(stopped, "approval-answer")).toHaveText("Not answered — the turn was stopped");
  await expect(stopped.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  // An answer saved mid-delivery is uncertain after a restart: a warning row that never reads as answered.
  const uncertain = items(page, "approval").last();
  await expect(uncertain).toHaveClass(/\bwarn\b/);
  await expect(uncertain).toHaveAttribute("data-answered", "false");
  await expect(tid(uncertain, "approval-answer")).toHaveText("Delivery uncertain — not resent");
  await expect(tid(uncertain, "answer-note")).toHaveText("Modex stopped before it could confirm the agent received this answer.");
  expect(await height(uncertain.locator(".receipt-head"))).toBe(34);
  // The row opens to the request it answered.
  const toggle = tid(uncertain, "item-toggle");
  await expect(toggle).toHaveAccessibleName("Request details");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(tid(uncertain, "item-body")).toContainText("Allow the deploy?");
  await expect(tid(uncertain, "item-body")).toContainText("deploy --prod");
});

test("reply actions show for the newest turn, and for an older one only when it is pointed at or holds focus", async () => {
  await row("rows-two-turns").click();
  const turns = tid(page, "turn");
  await expect(turns).toHaveCount(2);
  await expect(items(page, "assistant").last()).toContainText("Second answer.");
  const older = tid(turns.first(), "message-actions");
  const newest = tid(turns.last(), "message-actions");
  await expect(newest).toHaveCSS("opacity", "1");
  await expect(older).toHaveCSS("opacity", "0");
  await tid(turns.first(), "item-text").hover();
  await expect(older).toHaveCSS("opacity", "1");
  await row("rows-two-turns").hover();
  await expect(older).toHaveCSS("opacity", "0");
  // Keyboard only: the actions are still in the tab order, and show once one of them has focus.
  await tid(older, "message-copy").focus();
  await expect(older).toHaveCSS("opacity", "1");
});

test("Jump to latest is a square icon button that keeps its name and returns to the bottom", async () => {
  await row("rows-two-turns").click();
  const transcript = tid(page, "transcript");
  await expect(items(page, "assistant").last()).toContainText("Second answer.");
  await transcript.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  const jump = tid(page, "jump-latest");
  await expect(jump).toBeVisible();
  expect(await jump.boundingBox()).toMatchObject({ width: 32, height: 32 });
  await expect(jump).toHaveAccessibleName("Jump to latest");
  await expect(jump.locator("svg")).toHaveAttribute("data-icon", "arrow-down");
  await jump.click();
  await expect(jump).toHaveCount(0);
  expect(await transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(80);
});

test("a live turn is one element with a status dot; answering turns the approval into a receipt row", async () => {
  await page.keyboard.press("Meta+n");
  await tid(page, "composer-input").fill("Add a contributing guide");
  await page.keyboard.press("Meta+Enter");
  const card = items(page, "approval").first();
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(currentRow(page)).toHaveAttribute("data-status", "waiting");
  // One element holds the message, the status line and the work.
  const turn = tid(page, "turn");
  await expect(turn).toHaveCount(1);
  await expect(turn).toHaveAttribute("data-live", "true");
  await expect(turn.locator('[data-testid="item"][data-item-kind="user"]')).toHaveCount(1);
  await expect(turn.locator('[data-testid="item"][data-item-kind="approval"]')).toHaveCount(1);
  // Waiting on the person: the dot is steady, and the label says what it waits for.
  const header = tid(turn, "turn-header");
  await expect(header).toHaveClass(/\bwaiting\b/);
  await expect(header.locator(".turn-dot")).toHaveCount(1);
  await expect(header.locator(".turn-dot")).toHaveCSS("animation-name", "none");
  await expect(tid(header, "turn-label")).toHaveText(/^Waiting for approval · \d+s$/);

  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(tid(card, "approval-answer")).toHaveText("Approved");
  await expect(card).toHaveClass(/approval-receipt/);
  await expect(card).toHaveClass(/\ballowed\b/);
  // Main records that this window gave the answer; the row says so.
  await expect(tid(card, "receipt-meta")).toHaveText("by you");
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toHaveCount(0);
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
  // Finished: no dot, and the status line is the toggle for the folded work.
  await expect(turn).toHaveAttribute("data-live", "false");
  await expect(header).not.toHaveClass(/\bwaiting\b/);
  await expect(header.locator(".turn-dot")).toHaveCount(0);
  const label = tid(header, "turn-label");
  await expect(label).toHaveText(/^Worked for \d+s$/);
  await expect(label).toHaveAttribute("aria-expanded", "false");
  await expect(card).toBeHidden();
  await label.click();
  await expect(card).toBeVisible();
  expect(await height(card.locator(".receipt-head"))).toBe(34);
  await tid(card, "item-toggle").click();
  await expect(tid(card, "item-body")).toContainText("Allow add CONTRIBUTING.md?");
});
