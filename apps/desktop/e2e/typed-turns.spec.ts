import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, resizeWindow, seedHome, setTheme, tid } from "./support";

/**
 * Turns from the conversation-event contract (docs/conversation-events.md) render from their own
 * fields: the final answer is the `final` message, every running item is live, only work that
 * succeeded folds, reasoning says what kind it is, and a retry shows as a new attempt. The items are
 * sent to the window as main would send them; no CLI runs.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;
let threadId: string;

const at = () => new Date().toISOString();
const origin = (attempt: string, item: string) => ({ thread: threadId, turn: "u-typed", attempt, backend: "codex", native: { runtime: "R", thread: "nt", turn: "nu", item } });
const say = (id: string, text: string, phase: string, outcome = "succeeded", attempt = "A1") => ({ id, kind: "assistant", text, phase, outcome, origin: origin(attempt, id), at: at() });
const tool = (id: string, title: string, outcome: string, attempt = "A1") => ({ id, kind: "tool", name: "shell", title, args: { command: title.slice(2) }, status: outcome === "running" ? "running" : "done", outcome,
  ...(outcome === "succeeded" ? { ok: true } : outcome === "failed" || outcome === "denied" ? { ok: false } : {}), output: "", durationMs: 1200, origin: origin(attempt, id), at: at() });
const think = (id: string, reasoning: string, text: string, status = "done") => ({ id, kind: "thinking", text, reasoning, status, outcome: status === "running" ? "running" : "succeeded", durationMs: 3000, origin: origin("A1", id), at: at() });

async function send(events: Record<string, unknown>[]): Promise<void> {
  await app.evaluate(({ BrowserWindow }, list) => {
    for (const event of list) BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", event);
  }, events);
}
const item = (event: Record<string, unknown>) => ({ type: "item", threadId, item: event });
const status = (value: string) => ({ type: "status", threadId, status: value });
/**
 * Marks the thread running the way main does before a turn streams. The window reloads a thread's
 * items from main when it starts running, so items sent before that reload finishes would be
 * replaced by main's (which never had them): wait for the reload first.
 */
async function running(): Promise<void> {
  await send([status("running")]);
  await expect(currentRow(page)).toHaveAttribute("data-status", "running");
  // A probe that is still shown after a moment was sent after the reload landed.
  for (let attempt = 0; ; attempt++) {
    const id = `probe-${Date.now()}-${attempt}`;
    await send([item({ id, kind: "notice", level: "info", text: id, at: at() })]);
    await page.waitForTimeout(150);
    if (await page.getByText(id).isVisible()) return;
    if (attempt === 20) throw new Error("the window kept reloading the running thread's items");
  }
}

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  const script = path.join(home, "typed-turns-script.json");
  fs.writeFileSync(script, JSON.stringify([{ content: "Ready." }]));
  await page.evaluate((mock_script) => window.modex!.invoke("settings:update", { mock_script }), script);
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer-input").fill("start");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
  threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("a typed turn answers with its final message, folds only work that succeeded, and labels reasoning honestly", async () => {
  await send([
    item({ id: "u-typed", kind: "user", text: "typed turn", at: at() }),
    item(think("r-summary", "summary", "Plan: check twice.")),
    item(say("c1", "Checking one.", "commentary")),
    item(tool("t1", "$ echo one", "succeeded")),
    item(tool("t2", "$ touch denied.txt", "denied")),
    item(tool("t3", "$ curl example.com", "unknown")),
    item(think("r-hidden", "unavailable", "")),
    item(say("f", "Done ha ha ha.", "final")),
    item(say("after", "One more note.", "commentary")),
    status("idle"),
  ]);
  const answer = page.locator('.turn-content > div[data-final="true"]').last();
  await expect(answer).toContainText("Done ha ha ha.");
  // Succeeded work and commentary before the answer fold; the denial and the unknown stay in view.
  await expect(items(page, "assistant").filter({ hasText: "Checking one." })).toBeHidden();
  await expect(items(page, "tool").filter({ hasText: "$ echo one" })).toBeHidden();
  await expect(items(page, "tool").filter({ hasText: "$ touch denied.txt" })).toBeVisible();
  await expect(tid(items(page, "tool").filter({ hasText: "$ touch denied.txt" }), "tool-meta")).toHaveText("denied · 1.2s");
  await expect(tid(items(page, "tool").filter({ hasText: "$ curl example.com" }), "tool-meta")).toHaveText("status unavailable · 1.2s");
  // A commentary message after the answer is not the answer.
  await expect(items(page, "assistant").filter({ hasText: "One more note." })).toHaveAttribute("data-phase", "commentary");
  // Expanding the header shows the folded work, reasoning labelled by what it is.
  await tid(page, "turn-label").last().click();
  await expect(items(page, "tool").filter({ hasText: "$ echo one" })).toBeVisible();
  await expect(tid(page.locator('[data-reasoning="summary"]'), "reasoning-tag")).toHaveText("Summary");
  const hidden = page.locator('[data-reasoning="unavailable"]');
  await expect(tid(hidden, "reasoning-tag")).toHaveText("Not shared");
  await tid(hidden, "item-toggle").click();
  await expect(tid(hidden, "item-body")).toHaveText("The model reasoned here, but its reasoning was not shared.");
});

test("every running item is live at once, and a stopped message says it stopped", async () => {
  await running();
  await send([
    item({ id: "u-live", kind: "user", text: "live turn", at: at() }),
    item({ ...tool("l-tool", "$ npm test", "running"), origin: { ...origin("L1", "l-tool"), turn: "u-live" } }),
    item({ ...say("l-say", "Running the tests", "commentary", "running"), origin: { ...origin("L1", "l-say"), turn: "u-live" } }),
  ]);
  await expect(page.locator('.turn-content > div[data-live="true"]')).toHaveCount(2);
  await send([
    item({ ...say("l-say", "Running the tests", "commentary", "interrupted"), origin: { ...origin("L1", "l-say"), turn: "u-live" } }),
    item({ ...tool("l-tool", "$ npm test", "interrupted"), origin: { ...origin("L1", "l-tool"), turn: "u-live" } }),
    status("idle"),
  ]);
  await expect(page.locator('.turn-content > div[data-live="true"]')).toHaveCount(0);
  const stopped = items(page, "assistant").filter({ hasText: "Running the tests" });
  await expect(stopped).toHaveAttribute("data-outcome", "interrupted");
  await expect(tid(stopped, "message-status")).toHaveText("Stopped before it finished");
  await expect(tid(items(page, "tool").filter({ hasText: "$ npm test" }), "tool-meta")).toHaveText("stopped · 1.2s");
});

test("a retried turn shows its new attempt, and only that attempt answers", async () => {
  await send([
    item({ id: "u-retry", kind: "user", text: "retry turn", at: at() }),
    item({ ...say("old", "Stale answer.", "final", "succeeded", "R1"), origin: { ...origin("R1", "old"), turn: "u-retry" } }),
    item({ id: "fail", kind: "notice", level: "error", text: "The turn failed.", at: at() }),
    item({ ...say("new", "Fresh answer.", "final", "succeeded", "R2"), origin: { ...origin("R2", "new"), turn: "u-retry" } }),
    status("idle"),
  ]);
  await expect(tid(page, "attempt-divider").last()).toHaveText("Attempt 2");
  await expect(page.locator('.turn-content > div[data-final="true"]').last()).toContainText("Fresh answer.");
  await expect(items(page, "assistant").filter({ hasText: "Stale answer." })).toBeHidden();
  await expect(page.getByText("The turn failed.")).toBeVisible();
});

test("scrolling up while output streams shows Jump to latest; it returns to the bottom and resumes following", async () => {
  const transcript = tid(page, "transcript");
  await send([item({ id: "u-long", kind: "user", text: "long turn", at: at() }),
    ...Array.from({ length: 40 }, (_, i) => item({ ...say(`long-${i}`, `Line ${i}\n\n${"text ".repeat(40)}`, "commentary"), origin: { ...origin("J1", `long-${i}`), turn: "u-long" } }))]);
  await expect(tid(page, "jump-latest")).toBeHidden();
  await transcript.evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event("scroll")); });
  await expect(tid(page, "jump-latest")).toBeVisible();
  // New output does not pull the reader back down.
  await send([item({ ...say("long-new", "Newest line", "commentary"), origin: { ...origin("J1", "long-new"), turn: "u-long" } })]);
  await expect.poll(() => transcript.evaluate((el) => el.scrollTop)).toBe(0);
  await tid(page, "jump-latest").click();
  await expect.poll(() => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(80);
  await expect(tid(page, "jump-latest")).toBeHidden();
  await send([item({ ...say("final-long", "All lines done.", "final"), origin: { ...origin("J1", "final-long"), turn: "u-long" } })]);
  await expect(page.getByText("All lines done.")).toBeInViewport();
});

test("typed turns stay readable in every theme at the 900×600 minimum", async ({}, testInfo) => {
  // Its own turn: an earlier test's running() reload may have replaced what was sent before it.
  const o = (attempt: string, id: string) => ({ ...origin(attempt, id), turn: "u-themes" });
  await send([
    item({ id: "u-themes", kind: "user", text: "theme turn", at: at() }),
    item({ ...say("th-old", "Superseded answer.", "final", "succeeded", "T1"), origin: o("T1", "th-old") }),
    item({ ...think("th-summary", "summary", "Plan: check the themes."), origin: o("T2", "th-summary") }),
    item({ ...tool("th-denied", "$ rm -rf build", "denied", "T2"), origin: o("T2", "th-denied") }),
    item({ ...say("th-final", "Themes checked.", "final", "succeeded", "T2"), origin: o("T2", "th-final") }),
  ]);
  await resizeWindow(app, page, 900, 600);
  const turn = page.locator(".turn-content").filter({ has: page.getByText("Themes checked.") });
  // Unfold this turn's work once it has rendered: before that, the last header is an earlier turn's.
  await expect(turn.getByText("Themes checked.")).toBeVisible();
  await tid(page, "turn-label").last().click();
  await expect(tid(page, "turn-label").last()).toHaveAttribute("aria-expanded", "true");
  for (const theme of ["graphite", "jev", "coven"] as const) {
    await setTheme(page, theme);
    await turn.scrollIntoViewIfNeeded();
    const transcript = tid(page, "transcript");
    expect(await transcript.evaluate((el) => el.scrollWidth - el.clientWidth), `${theme}: no sideways scroll`).toBeLessThanOrEqual(0);
    await expect(turn.getByText("Themes checked.")).toBeVisible();
    await expect(turn.getByText("$ rm -rf build")).toBeVisible();
    await expect(tid(turn.locator('[data-reasoning="summary"]'), "reasoning-tag")).toBeVisible();
    await expect(tid(turn, "attempt-divider")).toHaveText("Attempt 2");
    const shot = await page.screenshot({ animations: "disabled", scale: "css" });
    await testInfo.attach(`typed-turn-${theme}-900x600`, { body: shot, contentType: "image/png" });
    // MODEX_SCREENSHOTS=<dir> keeps them for review evidence.
    if (process.env.MODEX_SCREENSHOTS) fs.writeFileSync(path.join(process.env.MODEX_SCREENSHOTS, `typed-turn-${theme}-900x600.png`), shot);
  }
});
