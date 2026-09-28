import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createThread, launch, seedHome, tid } from "./support";

/**
 * The embedded terminal: a real PTY per thread (main process, engine/terminal.ts) shown in a bottom
 * panel. These tests type into the real shell and read what it prints, so they cover the IPC, the
 * xterm wiring and the key routing together. Selectors are test ids and ARIA state only.
 */

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1380, 880));
  await expect(tid(page, "sidebar")).toBeVisible();
});

test.afterAll(async () => {
  await app?.close();
});

const panel = () => tid(page, "terminal-panel");
const screenText = () => tid(page, "terminal-screen").innerText();
const focusInTerminal = () => page.evaluate(() => document.activeElement?.closest('[data-testid="terminal-panel"]') != null);
/** Types a command line into the focused shell and presses Enter. */
async function run(command: string): Promise<void> {
  await expect.poll(focusInTerminal).toBe(true);
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}
/** The shell's pid, written to a file outside the repo (so the Changes panel stays clean). */
async function shellPid(tag: string): Promise<number> {
  const file = path.join(os.tmpdir(), `modex-term-${process.pid}-${tag}.pid`);
  await run(`printf '%s\\n' "$$" > '${file}'`);
  await expect.poll(() => fs.existsSync(file) && fs.readFileSync(file, "utf8").trim().length > 0).toBe(true);
  return Number(fs.readFileSync(file, "utf8").trim());
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("the title-bar button and ⌃` open a real shell in the thread's folder; hiding keeps it running", async () => {
  await createThread(page, "Terminal check");
  const toggle = tid(page, "terminal-toggle");
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(panel()).toHaveCount(0);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(panel()).toBeVisible();
  await run(`printf 'TTY=%s CWD=%s\\n' "$(test -t 0 && echo yes)" "$(pwd -P)"`);
  await expect(tid(page, "terminal-screen")).toContainText(`TTY=yes CWD=${fs.realpathSync(repo)}`);
  await run("export MODEX_TERMINAL_TEST=retained");

  // ⌃` hides it from inside the shell (and gives focus back to the composer) …
  await page.keyboard.press("Control+Backquote");
  await expect(panel()).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(tid(page, "composer-input")).toBeFocused();
  // … and shows the same shell again: its environment survived, and no ` reached the command line.
  await page.keyboard.press("Control+Backquote");
  await expect(panel()).toBeVisible();
  await run(`printf 'SESSION=%s\\n' "$MODEX_TERMINAL_TEST"`);
  await expect(tid(page, "terminal-screen")).toContainText("SESSION=retained");
  expect(await screenText()).toContain(`TTY=yes`); // replayed history from before hiding
});

test("inside the shell, ⌃C and ⌃J are the shell's, not the app's shortcuts", async () => {
  await expect(panel()).toBeVisible();
  await run("sleep 30");
  await page.keyboard.press("Control+c");
  await run(`printf 'INTERRUPTED_%s\\n' OK`);
  await expect(tid(page, "terminal-screen")).toContainText("INTERRUPTED_OK");

  const changes = tid(page, "changes-toggle");
  const before = await changes.getAttribute("aria-pressed");
  await page.keyboard.type(`printf 'CTRLJ_%s\\n' OK`);
  await page.keyboard.press("Control+j"); // ⌃J is a newline to the shell; ⌘J/⌃J elsewhere toggles Changes
  await expect(tid(page, "terminal-screen")).toContainText("CTRLJ_OK");
  await expect(changes).toHaveAttribute("aria-pressed", before!);
});

test("each thread has its own shell, and switching threads shows that thread's terminal", async () => {
  const first = (await page.locator('[data-testid="thread-row"][aria-current="true"]').getAttribute("data-thread-id"))!;
  await createThread(page, "Second terminal thread");
  await expect(panel()).toHaveCount(0);
  await page.keyboard.press("Control+Backquote");
  await expect(panel()).toBeVisible();
  await run(`printf 'OTHER=%s\\n' "\${MODEX_TERMINAL_TEST:-unset}"`);
  await expect(tid(page, "terminal-screen")).toContainText("OTHER=unset");

  await page.locator(`[data-testid="thread-row"][data-thread-id="${first}"]`).click();
  await expect(panel()).toBeVisible();
  await expect(tid(page, "terminal-screen")).toContainText("SESSION=retained");
  expect(await screenText()).not.toContain("OTHER=unset");
});

test("making the panel taller gives the shell more rows", async () => {
  await expect(panel()).toBeVisible();
  const rows = async (marker: string): Promise<number> => {
    await run(`printf '${marker}=%s\\n' "$(stty size)"`);
    await expect(tid(page, "terminal-screen")).toContainText(new RegExp(`${marker}=\\d+ \\d+`));
    return Number((await screenText()).match(new RegExp(`${marker}=(\\d+) \\d+`))![1]);
  };
  const before = await rows("BEFORE");
  const handle = tid(page, "terminal-resize");
  const height = Number(await handle.getAttribute("aria-valuenow"));
  await handle.focus();
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowUp");
  await expect(handle).toHaveAttribute("aria-valuenow", String(height + 100));
  await tid(page, "terminal-screen").click();
  await expect.poll(() => rows("AFTER"), { timeout: 10_000 }).toBeGreaterThan(before);
});

test("exit shows the code, Restart starts a fresh shell, and Close ends it", async () => {
  await expect(panel()).toBeVisible();
  await run("exit 3");
  await expect(tid(page, "terminal-exit")).toHaveText("Exited (3)");

  await tid(page, "terminal-restart").click();
  await expect(tid(page, "terminal-exit")).toHaveCount(0);
  await expect(tid(page, "terminal-screen")).not.toContainText("SESSION=retained");
  const pid = await shellPid("restart");
  expect(alive(pid)).toBe(true);

  await tid(page, "terminal-close").click();
  await expect(panel()).toHaveCount(0);
  await expect(tid(page, "terminal-toggle")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => alive(pid)).toBe(false);
});

test("deleting a worktree thread with its terminal open ends the shell and removes the worktree", async () => {
  const id = await createThread(page, "Worktree terminal", { worktree: true });
  const worktree = (await tid(page, "composer-context").getAttribute("title"))!;
  expect(fs.existsSync(worktree)).toBe(true);
  await page.keyboard.press("Control+Backquote");
  await expect(panel()).toBeVisible();
  await run(`printf 'WT=%s\\n' "$(pwd -P)"`);
  await expect(tid(page, "terminal-screen")).toContainText(`WT=${fs.realpathSync(worktree)}`);
  const pid = await shellPid("worktree");

  page.once("dialog", (d) => void d.accept());
  await tid(page, "thread-menu-toggle").click();
  await tid(page, "action-delete").click();
  // (Selection moves back to an earlier thread, whose own terminal may still be showing.)
  await expect(page.locator(`[data-testid="thread-row"][data-thread-id="${id}"]`)).toHaveCount(0);
  await expect.poll(() => alive(pid)).toBe(false);
  await expect.poll(() => fs.existsSync(worktree)).toBe(false);
});
