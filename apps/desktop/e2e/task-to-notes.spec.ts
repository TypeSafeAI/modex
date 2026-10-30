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
  // Both Codex turns did work without a plan and say so; the chat turn says nothing.
  await expect(tid(page, "task-no-plan")).toHaveCount(2);
  await expect(tid(page, "task-no-plan").first()).toHaveText("Codex reported no plan for this turn");
});

test("a turn's footer lists the files it touched, on demand, as the CLI reported them", async () => {
  const cwd = repo;
  const send = (events: Record<string, unknown>[]) => app.evaluate(({ BrowserWindow }, list) => {
    for (const event of list) BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", event);
  }, events);
  const origin = (turn: string, item: string) => ({ thread: threadId, turn, attempt: `${turn}:A1`, backend: "codex", native: { runtime: "R", item } });
  const tool = (turn: string, id: string, extra: Record<string, unknown>) => ({ type: "item", threadId, item: { id, kind: "tool", args: {}, status: "done", outcome: "succeeded", ok: true, origin: origin(turn, id), at: at(), ...extra } });
  await send([
    { type: "item", threadId, item: { id: "u-context", kind: "user", text: "Look, then fix", at: at() } },
    tool("u-context", "r1", { name: "Read", title: "read config.ts", args: { file_path: `${cwd}/src/config.ts` } }),
    tool("u-context", "s1", { name: "shell", title: "$ rg -n useEffect src", exec: { command: "rg -n useEffect src", actions: [{ kind: "search", path: "src", query: "useEffect" }] }, exitCode: 0 }),
    tool("u-context", "e1", { name: "apply_patch", title: "edit src/app.ts" }),
    tool("u-context", "o1", { name: "Read", title: "read hosts", args: { file_path: "/etc/hosts" } }),
    { type: "item", threadId, item: { id: "a-context", kind: "assistant", text: "Fixed.", phase: "final", outcome: "succeeded", origin: origin("u-context", "a-context"), at: at() } },
    { type: "status", threadId, status: "idle" },
  ]);
  // The turns that touched files have the toggle: the two verification turns above, which edited, and this one.
  // The plain answers (the first turn, the plan turn, "Where is the config?") have none.
  await expect(tid(page, "task-context-toggle")).toHaveCount(3);
  const context = tid(page, "task-context").filter({ hasText: "Files touched · 3" });
  await expect(context).toHaveCount(1);
  const toggle = tid(context, "task-context-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(tid(context, "task-context-file")).toHaveText(["src/app.ts changed", "src/config.ts read", "src searched"]);
  await expect(tid(context, "task-context-outside")).toHaveText("1 outside the project, not named");
  await expect(context).toContainText("As the CLI reported them");
});

test("a footer whose files a shell command may have changed says so and lists the command, never a guessed file", async () => {
  // CF-7 close-out observations 1 and 2: Claude rewrote a file it had read through a redirect, and Codex
  // edited one with `perl -pi`, which it parsed as an unknown action. Neither CLI named the file written.
  const cwd = repo;
  const origin = (turn: string, item: string, backend: string) => ({ thread: threadId, turn, attempt: `${turn}:A1`, backend, native: { runtime: "R", item } });
  const tool = (turn: string, backend: string, id: string, extra: Record<string, unknown>) => ({ type: "item", threadId, item: { id, kind: "tool", args: {}, status: "done", outcome: "succeeded", ok: true, origin: origin(turn, id, backend), at: at(), ...extra } });
  const redirect = "printf 'hello, live\\n' > greeting.txt && cat greeting.txt";
  const perl = "/bin/zsh -lc 'perl -pi -e s/hello/hi/ greeting.txt'";
  const before = await tid(page, "task-context-toggle").count();
  await app.evaluate(({ BrowserWindow }, list) => {
    for (const event of list) BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", event);
  }, [
    { type: "item", threadId, item: { id: "u-redirect", kind: "user", text: "Say hello, live", at: at() } },
    tool("u-redirect", "claude", "rr1", { name: "Read", title: "read greeting.txt", args: { file_path: `${cwd}/greeting.txt` } }),
    tool("u-redirect", "claude", "rb1", { name: "Bash", title: `$ ${redirect}`, args: { command: redirect }, exec: { command: redirect } }),
    { type: "item", threadId, item: { id: "a-redirect", kind: "assistant", text: "Done.", phase: "final", outcome: "succeeded", origin: origin("u-redirect", "a-redirect", "claude"), at: at() } },
    { type: "item", threadId, item: { id: "u-perl", kind: "user", text: "Say hi", at: at() } },
    tool("u-perl", "codex", "pp1", { name: "shell", title: `$ ${perl}`, exec: { command: perl, actions: [] }, exitCode: 0 }),
    tool("u-perl", "codex", "pp2", { name: "shell", title: `$ ${perl}`, exec: { command: perl, actions: [] }, exitCode: 0 }),
    tool("u-perl", "codex", "pp3", { name: "shell", title: "$ printf changed > partial.txt; exit 1", exec: { command: "printf changed > partial.txt; exit 1", actions: [] }, outcome: "failed", ok: false, exitCode: 1 }),
    { type: "item", threadId, item: { id: "a-perl", kind: "assistant", text: "Done.", phase: "final", outcome: "succeeded", origin: origin("u-perl", "a-perl", "codex"), at: at() } },
    { type: "status", threadId, status: "idle" },
  ]);
  await expect(tid(page, "task-context-toggle")).toHaveCount(before + 2);
  const claude = tid(page, "task-context").filter({ hasText: "Files touched · 1, maybe more" });
  await expect(claude).toHaveCount(1);
  await tid(claude, "task-context-toggle").click();
  await expect(tid(claude, "task-context-file")).toHaveText(["greeting.txt read"]);
  await expect(claude).toContainText("These commands may have changed files that neither the CLI nor Modex named:");
  await expect(tid(claude, "task-context-unlisted")).toHaveText([redirect]);
  const codex = tid(page, "task-context").filter({ hasText: "Files touched · not listed" });
  await expect(codex).toHaveCount(1);
  await tid(codex, "task-context-toggle").click();
  await expect(tid(codex, "task-context-file")).toHaveCount(0);
  // Shown as the script its shell ran, with the exact command on hover, and once although it ran twice.
  await expect(tid(codex, "task-context-unlisted")).toHaveText(["perl -pi -e s/hello/hi/ greeting.txt", "printf changed > partial.txt; exit 1"]);
  await expect(tid(codex, "task-context-unlisted").first().locator("code")).toHaveAttribute("title", perl);
});

test("a successful shell receipt cannot verify masked failures or writes after a check", async () => {
  const commands = ["pnpm test || true", "pnpm test && printf broken > app.ts", "pnpm test | cat", "pnpm build && pnpm test"];
  const before = await tid(page, "task-verification").count();
  const events = commands.flatMap((command, i) => {
    const turn = `u-shell-proof-${i}`;
    const origin = { thread: threadId, turn, attempt: `${turn}:A1`, backend: "codex", native: { runtime: "R" } };
    return [
      { type: "item", threadId, item: { id: turn, kind: "user", text: command, at: at() } },
      { type: "item", threadId, item: { id: `${turn}:edit`, kind: "tool", name: "apply_patch", title: "edit app.ts", args: {}, status: "done", outcome: "succeeded", ok: true, origin, at: at() } },
      { type: "item", threadId, item: { id: `${turn}:check`, kind: "tool", name: "shell", title: command, args: {}, status: "done", outcome: "succeeded", ok: true, exitCode: 0, exec: { command }, origin, at: at() } },
      { type: "item", threadId, item: { id: `${turn}:answer`, kind: "assistant", text: "Done.", phase: "final", outcome: "succeeded", origin, at: at() } },
    ];
  });
  await app.evaluate(({ BrowserWindow }, list) => {
    for (const event of list) BrowserWindow.getAllWindows()[0]!.webContents.send("thread:event", event);
  }, [...events, { type: "status", threadId, status: "idle" }]);
  const lines = tid(page, "task-verification");
  await expect(lines).toHaveCount(before + commands.length);
  for (let i = 0; i < 3; i++) {
    await expect(lines.nth(before + i)).toHaveAttribute("data-state", "none");
    await expect(lines.nth(before + i)).toHaveText("Not verified: no check result confirms the latest changes");
  }
  await expect(lines.last()).toHaveAttribute("data-state", "verified");
});

/**
 * A scripted codex-cli 0.163.0 app-server for one task: a plan, a clarifying question, an edit, a passing
 * `pnpm test` and an answer. Every `turn/start` is counted, so reopening can prove it asked the CLI nothing.
 */
function taskCodex(dir: string): string {
  const cli = path.join(dir, "codex-task.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const starts = ${JSON.stringify(path.join(dir, "turn-starts.log"))};
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let turn = 0, open = null;
const cwds = new Map();
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const p = msg.params || {};
  if (msg.method === 'initialize') return emit({ id: msg.id, result: { userAgent: 'codex-task/0.163.0' } });
  if (msg.method === 'initialized') return;
  if (msg.method === 'account/read') return emit({ id: msg.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (msg.method === 'model/list') return emit({ id: msg.id, result: { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true }], nextCursor: null } });
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') { const id = p.threadId || 'thr-' + cwds.size; cwds.set(id, p.cwd || ''); return emit({ id: msg.id, result: { thread: { id } } }); }
  const n = (method, params) => emit({ method, params: { threadId: open.thread, turnId: open.turn, ...params } });
  if (msg.method === 'turn/start') {
    fs.appendFileSync(starts, (cwds.get(p.threadId) || '') + '\\n');
    const id = 'turn-' + (++turn);
    emit({ id: msg.id, result: { turn: { id } } });
    if (/modex-title-/.test(cwds.get(p.threadId) || '')) {
      emit({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item: { id: 'name-' + turn, type: 'agentMessage', text: 'Fix the import', phase: 'final_answer' } } });
      return emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
    }
    open = { thread: p.threadId, turn: id, request: 800 + turn, cwd: cwds.get(p.threadId) };
    emit({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } });
    n('turn/plan/updated', { explanation: null, plan: [{ step: 'Ask which import', status: 'inProgress' }, { step: 'Fix the import', status: 'pending' }, { step: 'Run the tests', status: 'pending' }] });
    return emit({ id: open.request, method: 'item/tool/requestUserInput', params: { threadId: p.threadId, turnId: id, itemId: 'ask-' + turn, isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'q-file', header: 'Import', question: 'Which import should I fix?', isOther: false, isSecret: false, options: [{ label: 'lodash', description: '' }, { label: 'react', description: '' }] }] } });
  }
  if (open && msg.id === open.request && !msg.method) {
    const change = { path: open.cwd + '/src/app.ts', kind: { type: 'update' }, diff: '-a\\n+b' };
    n('item/started', { item: { type: 'fileChange', id: 'edit-1', changes: [change], status: 'inProgress' } });
    n('item/completed', { item: { type: 'fileChange', id: 'edit-1', changes: [change], status: 'completed' } });
    n('item/started', { item: { type: 'commandExecution', id: 'check-1', command: 'pnpm test', cwd: open.cwd, status: 'inProgress' } });
    n('item/completed', { item: { type: 'commandExecution', id: 'check-1', command: 'pnpm test', cwd: open.cwd, status: 'completed', exitCode: 0, aggregatedOutput: '' } });
    n('turn/plan/updated', { explanation: null, plan: [{ step: 'Ask which import', status: 'completed' }, { step: 'Fix the import', status: 'completed' }, { step: 'Run the tests', status: 'completed' }] });
    n('item/completed', { item: { type: 'agentMessage', id: 'final-' + turn, text: 'Fixed the ' + msg.result.answers['q-file'].answers[0] + ' import; the tests pass.', phase: 'final_answer' } });
    return emit({ method: 'turn/completed', params: { threadId: open.thread, turn: { id: open.turn, status: 'completed', error: null } } });
  }
  if (msg.id !== undefined && msg.method) emit({ id: msg.id, error: { code: -32601, message: 'fixture does not implement ' + msg.method } });
});
`, { mode: 0o755 });
  return cli;
}

test("a saved task note reopens read-only as the task it saved, asks the CLI nothing, writes nothing, and says when it was edited or moved", async () => {
  const seeded = seedHome({ default_backend: "codex", default_mode: "agent" });
  const logs = fs.mkdtempSync(path.join(path.dirname(seeded.home), "modex-e2e-reopen-"));
  const statePath = path.join(seeded.home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.codex_bin = taskCodex(logs);
  fs.writeFileSync(statePath, JSON.stringify(state));
  const { app: reopenApp, page: win } = await launch(seeded.home);
  const starts = () => fs.existsSync(path.join(logs, "turn-starts.log")) ? fs.readFileSync(path.join(logs, "turn-starts.log"), "utf8").split("\n").filter((line) => line && !/modex-title-/.test(line)).length : 0;
  type Note = { id: string; title: string; markdown: string; revision: number };
  const notes = async () => (await win.evaluate(() => window.modex!.invoke("space:list", undefined))) as Note[];
  try {
    await win.keyboard.press("Meta+n");
    await tid(win, "composer-input").fill("Fix the failing import");
    await win.keyboard.press("Meta+Enter");
    const card = items(win, "question").first();
    await card.getByRole("radio", { name: "lodash" }).check();
    await tid(card, "question-submit").click();
    await expect(items(win, "assistant").last()).toContainText("Fixed the lodash import");
    await expect(currentRow(win)).toHaveAttribute("data-status", "idle");
    const thread = (await currentRow(win).getAttribute("data-thread-id"))!;
    expect(starts()).toBe(1);

    await tid(win, "save-task-note").last().click();
    const saved = tid(win, "task-note-saved").last();
    await expect(saved).toContainText("Saved to Notes · Task:");
    const note = (await notes()).find((p) => p.title.startsWith("Task:"))!;
    const turnItems = async () => JSON.stringify(await win.evaluate((threadId) => window.modex!.invoke("thread:items", { threadId }), thread));
    const transcript = await turnItems();

    // Open the note from the saved line, then its task view.
    await saved.getByRole("button", { name: "Open" }).click();
    await tid(win, "task-view-open").click();
    const view = tid(win, "task-view");
    await expect(view).toBeVisible();
    await expect(view).toContainText("Read-only");
    await expect(tid(view, "task-view-request")).toHaveText("Fix the failing import");
    await expect(tid(view, "task-view-step")).toHaveText(["Reported done Ask which import", "Reported done Fix the import", "Reported done Run the tests"]);
    await expect(tid(view, "task-view-clarification")).toHaveText(["Which import should I fix? — lodash"]);
    await expect(tid(view, "task-view-file")).toHaveText(["src/app.ts changed"]);
    await expect(tid(view, "task-view-verification")).toHaveAttribute("data-state", "verified");
    await expect(tid(view, "task-view-verification")).toContainText("pnpm test");
    await expect(tid(view, "task-view-edited")).toHaveCount(0);
    await expect(tid(view, "task-view-moved")).toHaveCount(0);
    await expect(view.locator("input, textarea, [contenteditable=true]")).toHaveCount(0);

    // Nothing ran again, nothing was asked of the CLI, the note and the transcript are as they were.
    expect(starts()).toBe(1);
    expect((await notes()).find((p) => p.id === note.id)).toEqual(note);
    expect(await turnItems()).toBe(transcript);

    // An edit outside Modex after the save is said; the view still shows the record as saved.
    const file = path.join(seeded.home, "notes", (await win.evaluate((id) => window.modex!.invoke("notes:page:path", { id }), note.id))!);
    fs.appendFileSync(file, "\nMy own notes.\n");
    await expect(tid(view, "task-view-edited")).toContainText("edited after it was saved", { timeout: 10_000 });
    await expect(tid(view, "task-view-edited")).toContainText("Outside Modex");
    await expect(tid(view, "task-view-request")).toHaveText("Fix the failing import");

    // Moved to another project's notes: said, and the task still names the project it ran in.
    const tree = await win.evaluate(() => window.modex!.invoke("notes:tree", undefined)) as { nodes: { id: string; kind: string; name: string; isDefault?: boolean; modexProjectId?: string | null; parentId: string | null }[] };
    const workspace = tree.nodes.find((n) => n.kind === "workspace")!;
    const own = tree.nodes.find((n) => n.kind === "project" && n.modexProjectId)!;
    const elsewhere = await win.evaluate((workspaceId) => window.modex!.invoke("notes:project:create", { workspaceId, name: "Elsewhere" }), workspace.id);
    await win.evaluate(({ ids, targetId }) => window.modex!.invoke("notes:move", { ids, targetId }), { ids: [note.id], targetId: elsewhere.id });
    await expect(tid(view, "task-view-moved")).toContainText(`moved from ${own.name}'s notes to Elsewhere`, { timeout: 10_000 });
    expect(starts()).toBe(1);
  } finally {
    await reopenApp.close();
    for (const dir of [seeded.home, seeded.repo, logs]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
