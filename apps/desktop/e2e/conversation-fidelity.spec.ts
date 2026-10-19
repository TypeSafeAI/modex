import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { currentRow, items, launch, resizeWindow, seedHome, setTheme, tid } from "./support";

/**
 * The integration path for tracker #273 (docs/conversation-fidelity.md): a request runs through the
 * real app, main process and `claude -p` adapter against a fake Claude CLI that edits a disposable
 * repository for real and counts what it executes. Assertions are on file bytes, execution counts,
 * typed outcomes and note revisions, not on success text. Not live-provider acceptance.
 */

type Variant = "golden" | "deny" | "fail" | "stop" | "withdraw";
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
  if (msg.type === 'control_response') count('decisions');
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
  // The CLI takes its own request back, as Claude Code does when it no longer needs the answer.
  if (${JSON.stringify(variant)} === 'withdraw') setTimeout(() => {
    pending = null;
    emit({ type: 'control_cancel_request', request_id: 'perm-1' });
    emit({ type: 'assistant', message: { id: 'm-final', content: [{ type: 'text', text: 'Left the file as it was.' }] } });
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: 'fidelity-session', result: 'Left the file as it was.', num_turns: 2 });
  }, 1500);
});
`;
}

async function open(variant: Variant, opts: { journal?: boolean } = {}): Promise<{ app: ElectronApplication; page: Page; home: string; repo: string; counts: string; read: () => Record<string, number> }> {
  const { home, repo } = seedHome({ default_backend: "claude" });
  fs.writeFileSync(path.join(repo, "greeting.txt"), BEFORE);
  const counts = path.join(home, "fixture-counts.json");
  const cli = path.join(home, "claude-fidelity.cjs");
  fs.writeFileSync(cli, fakeClaude(repo, counts, variant), { mode: 0o755 });
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.claude_bin = cli;
  fs.writeFileSync(statePath, JSON.stringify(state));
  const { app, page } = await withJournal(Boolean(opts.journal), () => launch(home));
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer-input").fill("Change the greeting to mention fidelity and check it");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  const read = () => (fs.existsSync(counts) ? JSON.parse(fs.readFileSync(counts, "utf8")) as Record<string, number> : {});
  return { app, page, home, repo, counts, read };
}

const approval = (page: Page) => items(page, "approval").filter({ hasText: "Edit" });

/** Launches with the event journal on or off; the env is read at launch. */
async function withJournal<T>(on: boolean, start: () => Promise<T>): Promise<T> {
  const before = process.env.MODEX_EVENT_JOURNAL;
  if (on) process.env.MODEX_EVENT_JOURNAL = "1"; else delete process.env.MODEX_EVENT_JOURNAL;
  try { return await start(); } finally { if (before === undefined) delete process.env.MODEX_EVENT_JOURNAL; else process.env.MODEX_EVENT_JOURNAL = before; }
}

/** Turns on the iPhone companion and returns a phone: HTTPS with the pinned certificate and token, as the app makes them. */
async function phone(page: Page, home: string) {
  const status = await page.evaluate(() => window.modex!.invoke("companion:start", undefined)) as { pairingUri?: string };
  const pairing = JSON.parse(Buffer.from(new URL(status.pairingUri!).searchParams.get("data")!, "base64url").toString()) as { url: string; token: string; fingerprint: string };
  return (route: string, method = "GET", body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = https.request(new URL(route, pairing.url), {
      method, headers: { authorization: `Bearer ${pairing.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ca: fs.readFileSync(path.join(home, "companion", "cert.pem")),
      checkServerIdentity: (_host, cert) => crypto.createHash("sha256").update(cert.raw).digest("hex") === pairing.fingerprint ? undefined : new Error("unpinned"),
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
type Card = { id: string; kind: string; answer?: string; answeredBy?: string; delivery?: string; withdrawn?: string };
const cards = async (page: Page, threadId: string, kind = "approval") =>
  ((await page.evaluate((id) => window.modex!.invoke("thread:items", { threadId: id }), threadId)) as Card[]).filter((item) => item.kind === kind);

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
  // It also takes 18 reference captures across three states, nine theme switches and a relaunch.
  test.slow();
  let run = await open("golden");
  try {
    await expect(approval(run.page)).toBeVisible();
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "waiting");
    await capture(run, "waiting");
    await approval(run.page).getByRole("button", { name: "Approve" }).click();
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
    await capture(run, "completed");
    expect(fs.readFileSync(path.join(run.repo, "greeting.txt"), "utf8")).toBe(AFTER);
    expect(run.read()).toEqual({ decisions: 1, edits: 1, checksStarted: 1, checksFinished: 1 });
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
    expect(run.read()).toEqual({ decisions: 1, edits: 1, checksStarted: 1, checksFinished: 1 });
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
    expect(run.read()).toEqual({ decisions: 1 });
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
    expect(run.read()).toEqual({ decisions: 1, edits: 1, checksStarted: 1 });
    await expect(run.page.getByText("Stopped.")).toBeVisible();
  } finally { await close(run); }
});

// CF-3's request variants (#276, #279): a native withdrawal, two clients answering at once, a reconnect after
// the decision was sent, and a clarifying question inside the path. `decisions` counts every answer the CLI read.

test("a native withdrawal closes the card, sends no answer, and leaves the file as it was", async () => {
  const run = await open("withdraw");
  try {
    await expect(approval(run.page)).toBeVisible();
    await expect(tid(approval(run.page), "approval-answer")).toHaveText("Withdrawn — the agent no longer needs an answer", { timeout: 15_000 });
    await expect(approval(run.page).getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
    const threadId = (await currentRow(run.page).getAttribute("data-thread-id"))!;
    const [card] = await cards(run.page, threadId);
    expect([card!.withdrawn, card!.answeredBy]).toEqual(["native", undefined]);
    expect(await run.page.evaluate(({ id, item }) => window.modex!.invoke("thread:answer", { threadId: id, itemId: item, answer: "yes" }), { id: threadId, item: card!.id })).toEqual({ ok: false, reason: "withdrawn" });
    expect(fs.readFileSync(path.join(run.repo, "greeting.txt"), "utf8")).toBe(BEFORE);
    expect(run.read()).toEqual({});
  } finally { await close(run); }
});

test("the desktop and the phone answer at once: exactly one decision reaches the CLI, and the card names who gave it", async () => {
  const run = await open("golden");
  try {
    const request = await phone(run.page, run.home);
    await expect(approval(run.page)).toBeVisible();
    const threadId = (await currentRow(run.page).getAttribute("data-thread-id"))!;
    const [open] = await cards(run.page, threadId);
    // Both in flight at once: the phone over HTTPS, the desktop through the bridge its Approve button uses.
    const [fromPhone, fromDesktop] = await Promise.all([
      request(`/v1/threads/${threadId}/answer`, "POST", { itemId: open!.id, answer: "no" }),
      run.page.evaluate(({ id, item }) => window.modex!.invoke("thread:answer", { threadId: id, itemId: item, answer: "yes" }), { id: threadId, item: open!.id }) as Promise<{ ok: boolean; reason?: string }>,
    ]);
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
    const [card] = await cards(run.page, threadId);
    expect([fromPhone.status === 200, fromDesktop.ok].filter(Boolean)).toHaveLength(1);
    expect(run.read().decisions).toBe(1);
    expect(card!.delivery).toBe("sent");
    if (card!.answeredBy === "phone") {
      expect([fromPhone.status, fromDesktop, card!.answer]).toEqual([200, { ok: false, reason: "already-resolved" }, "no"]);
      expect(fs.readFileSync(path.join(run.repo, "greeting.txt"), "utf8")).toBe(BEFORE);
      await expect(tid(approval(run.page), "answer-note")).toHaveText("Answered on your phone.");
    } else {
      expect([card!.answeredBy, fromDesktop.ok, fromPhone.status, card!.answer]).toEqual(["desktop", true, 409, "yes"]);
      expect(fs.readFileSync(path.join(run.repo, "greeting.txt"), "utf8")).toBe(AFTER);
    }
  } finally { await close(run); }
});

test("with the journal on, a phone that reconnects after the decision was sent sees it answered, and its late answer is refused", async () => {
  const run = await open("golden", { journal: true });
  try {
    const request = await phone(run.page, run.home);
    await expect(approval(run.page)).toBeVisible();
    const threadId = (await currentRow(run.page).getAttribute("data-thread-id"))!;
    // The phone loads the thread while the card is open, then sleeps through the decision.
    const before = (await request(`/v1/snapshot?threadId=${threadId}`)).body as { items: Card[]; journal?: { id: string; cursor: number } };
    expect(before.journal, "the journal gives the phone a cursor").toBeTruthy();
    const card = before.items.find((item) => item.kind === "approval")!;
    expect(card.answer).toBeUndefined();
    await approval(run.page).getByRole("button", { name: "Approve" }).click();
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
    // It wakes and asks for what changed since its cursor.
    const after = (await request(`/v1/snapshot?threadId=${threadId}&journal=${before.journal!.id}&after=${before.journal!.cursor}`)).body as { items: Card[]; delta?: true };
    expect(after.delta).toBe(true);
    const changed = after.items.find((item) => item.id === card.id)!;
    expect([changed.answer, changed.answeredBy, changed.delivery]).toEqual(["yes", "desktop", "sent"]);
    // A tap queued before the sleep is refused, and the CLI hears nothing more.
    const late = await request(`/v1/threads/${threadId}/answer`, "POST", { itemId: card.id, answer: "no" });
    expect(late.status, JSON.stringify({ threadId, body: late.body })).toBe(409);
    expect(run.read()).toEqual({ decisions: 1, edits: 1, checksStarted: 1, checksFinished: 1 });
  } finally { await close(run); }
});

/** A codex-cli 0.163.0-shaped app-server that asks which greeting, then edits `greeting.txt` for real and checks it. */
function fakeCodex(repo: string, counts: string): string {
  const file = path.join(repo, "greeting.txt");
  return `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const count = (key) => { const c = fs.existsSync(${JSON.stringify(counts)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(counts)}, 'utf8')) : {}; c[key] = (c[key] || 0) + 1; fs.writeFileSync(${JSON.stringify(counts)}, JSON.stringify(c)); };
let turn = 0, open = null;
const cwds = new Map();
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const p = msg.params || {};
  if (msg.method === 'initialize') return emit({ id: msg.id, result: { userAgent: 'codex-fidelity/0.163.0' } });
  if (msg.method === 'initialized') return;
  if (msg.method === 'account/read') return emit({ id: msg.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (msg.method === 'model/list') return emit({ id: msg.id, result: { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true }], nextCursor: null } });
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') { const id = p.threadId || 'thr-' + cwds.size; cwds.set(id, p.cwd || ''); return emit({ id: msg.id, result: { thread: { id } } }); }
  const n = (method, params) => emit({ method, params: { threadId: open.thread, turnId: open.turn, ...params } });
  if (msg.method === 'turn/start') {
    const id = 'turn-' + (++turn);
    emit({ id: msg.id, result: { turn: { id } } });
    if (/modex-title-/.test(cwds.get(p.threadId) || '')) {
      emit({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item: { id: 'name-' + turn, type: 'agentMessage', text: 'Fidelity greeting', phase: 'final_answer' } } });
      return emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
    }
    open = { thread: p.threadId, turn: id, request: 700 + turn };
    emit({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } });
    n('turn/plan/updated', { explanation: null, plan: [{ step: 'Ask which greeting', status: 'inProgress' }, { step: 'Edit greeting.txt', status: 'pending' }, { step: 'Check the file', status: 'pending' }] });
    return emit({ id: open.request, method: 'item/tool/requestUserInput', params: { threadId: p.threadId, turnId: id, itemId: 'ask-' + turn, isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'q-word', header: 'Greeting', question: 'Which word should the greeting add?', isOther: false, isSecret: false, options: [{ label: 'fidelity', description: '' }, { label: 'world', description: '' }] }] } });
  }
  if (open && msg.id === open.request && !msg.method) {
    count('decisions');
    const word = msg.result.answers['q-word'].answers[0];
    const change = { path: ${JSON.stringify(file)}, kind: { type: 'update' }, diff: '-hello\\n+hello, ' + word };
    n('item/started', { item: { type: 'fileChange', id: 'edit-1', changes: [change], status: 'inProgress' } });
    count('edits');
    fs.writeFileSync(${JSON.stringify(file)}, 'hello, ' + word + '\\n');
    n('item/completed', { item: { type: 'fileChange', id: 'edit-1', changes: [change], status: 'completed' } });
    const check = 'grep -q ' + word + ' greeting.txt';
    n('item/started', { item: { type: 'commandExecution', id: 'check-1', command: check, cwd: ${JSON.stringify(repo)}, status: 'inProgress' } });
    count('checksStarted');
    const ran = spawnSync('/bin/sh', ['-c', check], { cwd: ${JSON.stringify(repo)} });
    count('checksFinished');
    n('item/completed', { item: { type: 'commandExecution', id: 'check-1', command: check, cwd: ${JSON.stringify(repo)}, status: 'completed', exitCode: ran.status, aggregatedOutput: '' } });
    n('turn/plan/updated', { explanation: null, plan: [{ step: 'Ask which greeting', status: 'completed' }, { step: 'Edit greeting.txt', status: 'completed' }, { step: 'Check the file', status: 'completed' }] });
    n('item/completed', { item: { type: 'agentMessage', id: 'final-' + turn, text: 'Changed the greeting to ' + word + '; the check passed.', phase: 'final_answer' } });
    return emit({ method: 'turn/completed', params: { threadId: open.thread, turn: { id: open.turn, status: 'completed', error: null } } });
  }
  if (msg.id !== undefined && msg.method) emit({ id: msg.id, error: { code: -32601, message: 'fixture does not implement ' + msg.method } });
});
`;
}

test("a clarifying question in the path: answered on its card, heard once, saved to Notes, and inert after a restart", async () => {
  const { home, repo } = seedHome({ default_backend: "codex", default_mode: "agent" });
  fs.writeFileSync(path.join(repo, "greeting.txt"), BEFORE);
  const counts = path.join(home, "fixture-counts.json");
  const cli = path.join(home, "codex-fidelity.cjs");
  fs.writeFileSync(cli, fakeCodex(repo, counts), { mode: 0o755 });
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.codex_bin = cli;
  fs.writeFileSync(statePath, JSON.stringify(state));
  const read = () => (fs.existsSync(counts) ? JSON.parse(fs.readFileSync(counts, "utf8")) as Record<string, number> : {});
  let run = { ...(await launch(home)), home, repo };
  try {
    await run.page.keyboard.press("Meta+n");
    await tid(run.page, "composer-input").fill("Change the greeting and check it");
    await run.page.keyboard.press("Meta+Enter");
    const question = items(run.page, "question").first();
    await expect(tid(question, "question-submit")).toBeVisible({ timeout: 15_000 });
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "waiting");
    expect(read()).toEqual({});
    await question.getByRole("radio", { name: "fidelity" }).check();
    await tid(question, "question-submit").click();
    await expect(currentRow(run.page)).toHaveAttribute("data-status", "idle", { timeout: 20_000 });
    expect(fs.readFileSync(path.join(repo, "greeting.txt"), "utf8")).toBe(AFTER);
    expect(read()).toEqual({ decisions: 1, edits: 1, checksStarted: 1, checksFinished: 1 });
    await expect(tid(items(run.page, "plan"), "plan-step")).toHaveText(["Reported done Ask which greeting", "Reported done Edit greeting.txt", "Reported done Check the file"]);
    await tid(run.page, "save-task-note").last().click();
    await expect(tid(run.page, "task-note-saved").last()).toContainText("Saved to Notes · Task:");
    const note = ((await run.page.evaluate(() => window.modex!.invoke("space:list", undefined))) as { title: string; markdown: string }[]).find((p) => p.title.startsWith("Task:"))!;
    expect(note.markdown).toContain("- Which word should the greeting add? — fidelity");
    expect(note.markdown).toContain("`greeting.txt`");
    expect(note.markdown).toContain("`grep -q fidelity greeting.txt` — succeeded, exit code 0");
    // Restart: the card stays answered, nothing re-asks or re-runs, and a late answer is refused.
    const threadId = (await currentRow(run.page).getAttribute("data-thread-id"))!;
    const before = await run.page.evaluate((id) => window.modex!.invoke("thread:items", { threadId: id }), threadId);
    await run.app.close();
    run = { ...(await launch(home)), home, repo };
    expect(await run.page.evaluate((id) => window.modex!.invoke("thread:items", { threadId: id }), threadId)).toEqual(before);
    const [card] = await cards(run.page, threadId, "question");
    expect([card!.answeredBy, card!.delivery]).toEqual(["desktop", "sent"]);
    expect(await run.page.evaluate(({ id, item }) => window.modex!.invoke("thread:answer-question", { threadId: id, itemId: item, answers: { "q-word": ["world"] } }), { id: threadId, item: card!.id })).toEqual({ ok: false, reason: "already-resolved" });
    expect(read()).toEqual({ decisions: 1, edits: 1, checksStarted: 1, checksFinished: 1 });
  } finally { await close(run); }
});
