import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * A task's plan and record (docs/task-context.md): the plan the CLI reported, in its statuses, and an
 * explicit Save to Notes that writes the turn's record into the project's notes and updates it when
 * saved again. Plan items are sent to the window as main would; the saved turn ran on the mock engine.
 */
let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;
let threadId: string;

const at = () => new Date().toISOString();

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  const script = path.join(home, "task-script.json");
  fs.writeFileSync(script, JSON.stringify([{ content: "Fixed the import." }]));
  await page.evaluate((mock_script) => window.modex!.invoke("settings:update", { mock_script }), script);
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer-input").fill("Fix the failing import");
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

test("a plan shows each step as the CLI reported it, never as verified", async () => {
  const origin = { thread: threadId, turn: "u-plan", attempt: "P1", backend: "codex", native: { runtime: "R", item: "plan" } };
  await app.evaluate(({ BrowserWindow }, events) => {
    for (const event of events) BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", event);
  }, [
    { type: "item", threadId, item: { id: "u-plan", kind: "user", text: "plan turn", at: at() } },
    { type: "item", threadId, item: { id: "p", kind: "plan", from: "codex-plan", revision: 2, explanation: "Small fix", outcome: "succeeded", origin, at: at(),
      steps: [{ text: "Read the config", status: "completed" }, { text: "Fix the import", status: "in-progress" }, { text: "Run the tests", status: "pending" }, { text: "Ship", status: "unknown" }] } },
  ]);
  const plan = items(page, "plan");
  await expect(tid(plan, "plan-meta")).toHaveText("From Codex's plan · revision 2");
  await expect(tid(plan, "plan-step")).toHaveText(["Reported done Read the config", "In progress Fix the import", "Not started Run the tests", "Status unknown Ship"]);
  await expect(plan).toContainText("Small fix");
  await expect(plan).not.toContainText(/verified/i);
});

test("Save to Notes writes the turn's record into the project's notes, and saving again updates the same note", async () => {
  const save = tid(page, "save-task-note").first();
  await save.click();
  await expect(tid(page, "task-note-saved").first()).toContainText("Saved to Notes · Task:");
  const pages = async () => (await page.evaluate(() => window.modex!.invoke("space:list", undefined))) as { id: string; title: string; markdown: string }[];
  const saved = (await pages()).filter((p) => p.title.startsWith("Task:"));
  expect(saved).toHaveLength(1);
  expect(saved[0]!.markdown).toContain("> Fix the failing import");
  expect(saved[0]!.markdown).toContain("Fixed the import.");
  expect(saved[0]!.markdown).toContain(`From modex thread ${threadId}.`);
  expect(saved[0]!.markdown).not.toContain(repo);
  await expect(save).toHaveText("Update note");
  await save.click();
  await expect(tid(page, "task-note-saved").first()).toContainText("Updated in Notes · Task:");
  expect((await pages()).filter((p) => p.title.startsWith("Task:"))).toHaveLength(1);
});

test("a turn's footer says whether a check verified its last change, and a plain answer says nothing", async () => {
  const send = (events: Record<string, unknown>[]) => app.evaluate(({ BrowserWindow }, list) => {
    for (const event of list) BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", event);
  }, events);
  const origin = (turn: string, item: string) => ({ thread: threadId, turn, attempt: `${turn}:A1`, backend: "codex", native: { runtime: "R", item } });
  const tool = (turn: string, id: string, extra: Record<string, unknown>) => ({ type: "item", threadId, item: { id, kind: "tool", args: {}, status: "done", origin: origin(turn, id), at: at(), ...extra } });
  const shell = (turn: string, id: string, command: string, outcome: string, exitCode: number) => tool(turn, id, { name: "shell", title: `$ ${command}`, exec: { command: `/bin/zsh -lc '${command}'` }, outcome, ok: outcome === "succeeded", exitCode });
  const patch = (turn: string, id: string) => tool(turn, id, { name: "apply_patch", title: "edit src/app.ts", outcome: "succeeded", ok: true });
  const answer = (turn: string, id: string, text: string) => ({ type: "item", threadId, item: { id, kind: "assistant", text, phase: "final", outcome: "succeeded", origin: origin(turn, id), at: at() } });
  await send([
    { type: "item", threadId, item: { id: "u-fixed", kind: "user", text: "Fix and test", at: at() } },
    patch("u-fixed", "e1"), shell("u-fixed", "c1", "pnpm test", "failed", 1), patch("u-fixed", "e2"), shell("u-fixed", "c2", "pnpm test", "succeeded", 0),
    answer("u-fixed", "a1", "All tests pass now."),
    { type: "item", threadId, item: { id: "u-stale", kind: "user", text: "Test, then tweak", at: at() } },
    shell("u-stale", "c3", "pnpm test", "succeeded", 0), patch("u-stale", "e3"), answer("u-stale", "a2", "Tweaked after the tests."),
    { type: "item", threadId, item: { id: "u-chat", kind: "user", text: "Where is the config?", at: at() } },
    answer("u-chat", "a3", "In config.ts."),
    { type: "status", threadId, status: "idle" },
  ]);
  const lines = tid(page, "task-verification");
  await expect(lines).toHaveCount(2);
  await expect(lines.nth(0)).toHaveAttribute("data-state", "verified");
  await expect(lines.nth(0)).toHaveText("Verified: pnpm test passed after the last change");
  await expect(lines.nth(0).locator("code")).toHaveAttribute("title", "/bin/zsh -lc 'pnpm test'");
  await expect(lines.nth(1)).toHaveAttribute("data-state", "stale");
  await expect(lines.nth(1)).toHaveText("Not verified: pnpm test ran before a later change");
});
