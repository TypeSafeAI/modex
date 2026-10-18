import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, resizeWindow, seedHome, setTheme, tid } from "./support";

/**
 * The integration path for tracker #273 (docs/conversation-fidelity.md): a request runs through the
 * real app, main process and `claude -p` adapter against a fake Claude CLI that edits a disposable
 * repository for real and counts what it executes. Assertions are on file bytes, execution counts,
 * typed outcomes and note revisions, not on success text. Not live-provider acceptance.
 */

type Variant = "golden" | "deny" | "fail" | "stop";
const BEFORE = "hello\n";
const AFTER = "hello, fidelity\n";

/** A stream-json CLI shaped like Claude Code 2.1.302: a TodoWrite plan, an Edit behind the stdio permission prompt, a check, an answer. */
function fakeClaude(repo: string, counts: string, variant: Variant): string {
  const file = path.join(repo, "greeting.txt");
  const check = variant === "fail" ? "grep -q missing greeting.txt" : "grep -q fidelity greeting.txt";
  return `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }
const emit = (x) => console.log(JSON.stringify(x));
const count = (key) => { const c = fs.existsSync(${JSON.stringify(counts)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(counts)}, 'utf8')) : {}; c[key] = (c[key] || 0) + 1; fs.writeFileSync(${JSON.stringify(counts)}, JSON.stringify(c)); };
const todos = (a, b) => emit({ type: 'assistant', message: { id: 'm-todo-' + a + b, content: [{ type: 'tool_use', id: 'todo-' + a + b, name: 'TodoWrite', input: { todos: [{ content: 'Edit greeting.txt', status: a, activeForm: 'Editing' }, { content: 'Check the file', status: b, activeForm: 'Checking' }] } }] } });
let pending = null;
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('close', () => process.exit(0));
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type === 'control_response' && pending) { const go = pending; pending = null; go(msg.response.response.behavior === 'allow'); return; }
  if (msg.type !== 'user') return;
  emit({ type: 'system', subtype: 'init', session_id: 'fidelity-session', claude_code_version: '2.1.302', model: 'fixture' });
  // Naming the thread runs in its own folder and only names it.
  if (process.cwd().includes('modex-title-')) {
    emit({ type: 'assistant', message: { id: 'm-title', content: [{ type: 'text', text: 'Fidelity greeting' }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'fidelity-session', result: 'Fidelity greeting', num_turns: 1 });
    return;
  }
  todos('in_progress', 'pending');
  emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'todo-in_progresspending', content: 'ok' }] } });
  emit({ type: 'assistant', message: { id: 'm-say', content: [{ type: 'text', text: 'Editing the greeting.' }] } });
  const edit = { file_path: ${JSON.stringify(file)}, old_string: 'hello', new_string: 'hello, fidelity' };
  emit({ type: 'assistant', message: { id: 'm-edit', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: edit }] } });
  pending = (allowed) => {
    if (!allowed) {
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'The user denied this action in Modex.', is_error: true }] } });
      emit({ type: 'assistant', message: { id: 'm-final', content: [{ type: 'text', text: 'Left the file as it was.' }] } });
      emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'fidelity-session', result: 'Left the file as it was.', num_turns: 3 });
      return;
    }
    count('edits');
    fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(AFTER)});
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'The file was updated.' }] } });
    todos('completed', 'in_progress');
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'todo-completedin_progress', content: 'ok' }] } });
    emit({ type: 'assistant', message: { id: 'm-check', content: [{ type: 'tool_use', id: 'check-1', name: 'Bash', input: { command: ${JSON.stringify(check)} } }] } });
    count('checksStarted');
    const finish = () => {
      const run = spawnSync('/bin/sh', ['-c', ${JSON.stringify(check)}], { cwd: ${JSON.stringify(repo)} });
      count('checksFinished');
      const ok = run.status === 0;
      emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'check-1', content: ok ? '' : 'exit ' + run.status, is_error: !ok }] } });
      if (ok) { todos('completed', 'completed'); emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'todo-completedcompleted', content: 'ok' }] } }); }
      const answer = ok ? 'Changed the greeting; the check passed.' : 'Changed the greeting; the check failed.';
      emit({ type: 'assistant', message: { id: 'm-final', content: [{ type: 'text', text: answer }] } });
      emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'fidelity-session', result: answer, num_turns: 6 });
    };
    if (${JSON.stringify(variant)} === 'stop') setTimeout(finish, 60000); else finish();
  };
  emit({ type: 'control_request', request_id: 'perm-1', request: { subtype: 'can_use_tool', tool_name: 'Edit', tool_use_id: 'edit-1', input: edit } });
});
`;
}

async function open(variant: Variant): Promise<{ app: ElectronApplication; page: Page; home: string; repo: string; counts: string; read: () => Record<string, number> }> {
  const { home, repo } = seedHome({ default_backend: "claude" });
  fs.writeFileSync(path.join(repo, "greeting.txt"), BEFORE);
  const counts = path.join(home, "fixture-counts.json");
  const cli = path.join(home, "claude-fidelity.cjs");
  fs.writeFileSync(cli, fakeClaude(repo, counts, variant), { mode: 0o755 });
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.claude_bin = cli;
  fs.writeFileSync(statePath, JSON.stringify(state));
  const { app, page } = await launch(home);
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer-input").fill("Change the greeting to mention fidelity and check it");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  const read = () => (fs.existsSync(counts) ? JSON.parse(fs.readFileSync(counts, "utf8")) as Record<string, number> : {});
  return { app, page, home, repo, counts, read };
}

const approval = (page: Page) => items(page, "approval").filter({ hasText: "Edit" });

/**
 * Reference captures (docs/screenshots/conversation-fidelity/): one state in every theme, at the 900×600
 * minimum and at a fixed wider viewport, each with no sideways scroll. MODEX_SCREENSHOTS=<dir> keeps them.
 * Animations stop for the shot. Durations and times differ between runs, and nothing is compared pixel for pixel.
 */
const THEMES = ["graphite", "jev", "coven"] as const;
const VIEWPORTS = [[900, 600], [1440, 900]] as const;
async function capture(run: { app: ElectronApplication; page: Page }, state: string): Promise<void> {
  const { app, page } = run;
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize());
  const theme = await page.evaluate(() => document.documentElement.dataset.theme) as typeof THEMES[number];
  for (const value of THEMES) {
    await setTheme(page, value);
    for (const [width, height] of VIEWPORTS) {
      await resizeWindow(app, page, width, height);
      const name = `${state}-${value}-${width}x${height}`;
      expect(await tid(page, "transcript").evaluate((el) => el.scrollWidth - el.clientWidth), `${name}: no sideways scroll`).toBeLessThanOrEqual(0);
      const shot = await page.screenshot({ animations: "disabled", scale: "css" });
      await test.info().attach(name, { body: shot, contentType: "image/png" });
      if (process.env.MODEX_SCREENSHOTS) fs.writeFileSync(path.join(process.env.MODEX_SCREENSHOTS, `${name}.png`), shot);
    }
  }
  await setTheme(page, theme);
  await resizeWindow(app, page, size[0]!, size[1]!);
}
const close = async (run: { app: ElectronApplication; home: string; repo: string }) => {
  await run.app.close().catch(() => {});
  fs.rmSync(run.home, { recursive: true, force: true });
  fs.rmSync(run.repo, { recursive: true, force: true });
};

test("golden path: plan, approval, a real edit and check, the answer, Save to Notes, Open, and a restart that restores without re-running", async () => {
  let run = await open("golden");
  try {
    await expect(approval(run.page)).toBeVisible();
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "waiting");
    await capture(run, "waiting");
    await approval(run.page).getByRole("button", { name: "Approve" }).click();
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
    await capture(run, "completed");
    expect(fs.readFileSync(path.join(run.repo, "greeting.txt"), "utf8")).toBe(AFTER);
    expect(run.read()).toEqual({ edits: 1, checksStarted: 1, checksFinished: 1 });
    // Typed outcomes, the reported plan and the final answer, as recorded rather than as prose says.
    await expect(tid(items(run.page, "plan"), "plan-step")).toHaveText(["Reported done Edit greeting.txt", "Reported done Check the file"]);
    await tid(run.page, "turn-label").last().click();
    await expect(tid(items(run.page, "tool").filter({ hasText: "edit" }).first(), "tool-meta")).toContainText("done");
    const check = items(run.page, "tool").filter({ hasText: "grep -q fidelity" });
    await tid(check, "item-toggle").click();
    await expect(tid(check, "tool-exit")).toHaveText("Exit code not reported");
    await expect(run.page.locator('.turn-content > div[data-final="true"]').last()).toContainText("Changed the greeting; the check passed.");
    // Save to Notes, again (same note, next revision), then Open.
    await tid(run.page, "save-task-note").last().click();
    await expect(tid(run.page, "task-note-saved").last()).toContainText("Saved to Notes · Task:");
    const notes = async () => (await run.page.evaluate(() => window.modex!.invoke("space:list", undefined))) as { id: string; title: string; markdown: string; revision: number }[];
    const first = (await notes()).find((p) => p.title.startsWith("Task:"))!;
    expect(first.markdown).toContain("- [x] Edit greeting.txt (reported done)");
    expect(first.markdown).toContain("`greeting.txt`");
    expect(first.markdown).toContain("`grep -q fidelity greeting.txt` — succeeded, exit code not reported");
    expect(first.markdown).not.toContain(run.repo);
    await tid(run.page, "save-task-note").last().click();
    await expect(tid(run.page, "task-note-saved").last()).toContainText("Updated in Notes · Task:");
    const second = (await notes()).filter((p) => p.title.startsWith("Task:"));
    expect(second.map((p) => [p.id, p.revision])).toEqual([[first.id, first.revision + 1]]);
    // Open the note: the record reads in Notes as saved.
    const threadId = (await currentRow(run.page).getAttribute("data-thread-id"))!;
    const before = await run.page.evaluate((id) => window.modex!.invoke("thread:items", { threadId: id }), threadId);
    await tid(run.page, "task-note-saved").last().getByRole("button", { name: "Open" }).click();
    await expect(run.page.getByText(`From modex thread ${threadId}.`)).toBeVisible();
    // Restart: the same items come back, and nothing runs again.
    await run.app.close();
    const relaunched = await launch(run.home);
    run = { ...run, app: relaunched.app, page: relaunched.page };
    const after = await run.page.evaluate((id) => window.modex!.invoke("thread:items", { threadId: id }), threadId);
    expect(after).toEqual(before);
    expect(run.read()).toEqual({ edits: 1, checksStarted: 1, checksFinished: 1 });
    expect(fs.readFileSync(path.join(run.repo, "greeting.txt"), "utf8")).toBe(AFTER);
    await run.page.locator(`[data-testid="thread-row"][data-thread-id="${threadId}"] button.thread-main`).click();
    await expect(run.page.locator('.turn-content > div[data-final="true"]').last()).toContainText("Changed the greeting; the check passed.");
    await capture(run, "restored");
  } finally { await close(run); }
});

test("a denial leaves the file as it was and runs nothing", async () => {
  const run = await open("deny");
  try {
    await approval(run.page).getByRole("button", { name: "Deny" }).click();
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
    expect(fs.readFileSync(path.join(run.repo, "greeting.txt"), "utf8")).toBe(BEFORE);
    expect(run.read()).toEqual({});
    await tid(run.page, "turn-label").last().click();
    await expect(tid(items(run.page, "tool").filter({ hasText: "edit" }).first(), "tool-meta")).toContainText("denied");
  } finally { await close(run); }
});

test("a failing check is a failed command, whatever the reply says", async () => {
  const run = await open("fail");
  try {
    await approval(run.page).getByRole("button", { name: "Approve" }).click();
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
    const check = items(run.page, "tool").filter({ hasText: "grep -q missing" });
    await expect(check).toBeVisible();
    await expect(tid(check, "tool-meta")).toContainText("failed");
    await expect(tid(items(run.page, "plan"), "plan-step")).toHaveText(["Reported done Edit greeting.txt", "In progress Check the file"]);
    await capture(run, "failed");
  } finally { await close(run); }
});

test("Stop while a check runs ends it as stopped; the check never reports, and nothing is retried", async () => {
  const run = await open("stop");
  try {
    await approval(run.page).getByRole("button", { name: "Approve" }).click();
    await expect.poll(() => run.read().checksStarted ?? 0).toBe(1);
    await expect(items(run.page, "tool").filter({ hasText: "grep -q fidelity" })).toBeVisible();
    await capture(run, "live");
    await tid(run.page, "stop").click();
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
    const check = items(run.page, "tool").filter({ hasText: "grep -q fidelity" });
    await expect(tid(check, "tool-meta")).toContainText("stopped");
    expect(run.read()).toEqual({ edits: 1, checksStarted: 1 });
    await expect(run.page.getByText("Stopped.")).toBeVisible();
  } finally { await close(run); }
});
