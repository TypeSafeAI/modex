import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * A long command's full log (docs/conversation-evidence.md). A codex-cli 0.163.0-shaped app-server
 * streams a 3.1 MB log through the real Codex backend and runner. The transcript keeps its last 256 KB;
 * main keeps the log from its first line, and Show full log reads it back a page at a time. Reading it
 * runs nothing, and it is still there after a restart.
 */

const LINES = 30_000;
const line = (i: number) => `line ${String(i + 1).padStart(6, "0")} ${"x".repeat(96)}\n`;
const LOG = Array.from({ length: LINES }, (_, i) => line(i)).join("");
const CHUNK = 64 * 1024;
const BYTES = Buffer.byteLength(LOG);
/** As the transcript writes sizes (ThreadView's formatBytes). */
const SIZE = BYTES < 1024 * 1024 ? `${Math.round(BYTES / 1024)} KB` : `${(BYTES / (1024 * 1024)).toFixed(1)} MB`;
/** ASCII, so every page but the last is exactly 256 KiB. */
const PAGES = Math.ceil(BYTES / (256 * 1024));

let app: ElectronApplication;
let page: Page;
let home: string;
let repo: string;
let counts: string;

function fakeCodex(dir: string): string {
  const cli = path.join(dir, "codex-log.cjs");
  const logFile = path.join(dir, "log.txt");
  fs.writeFileSync(logFile, LOG);
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const log = fs.readFileSync(${JSON.stringify(logFile)}, 'utf8');
let turn = 0;
const cwds = new Map();
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const p = msg.params || {};
  if (msg.method === 'initialize') return emit({ id: msg.id, result: { userAgent: 'codex-log/0.163.0' } });
  if (msg.method === 'initialized') return;
  if (msg.method === 'account/read') return emit({ id: msg.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (msg.method === 'model/list') return emit({ id: msg.id, result: { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true }], nextCursor: null } });
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const id = p.threadId || 'thr-' + cwds.size;
    cwds.set(id, p.cwd || '');
    return emit({ id: msg.id, result: { thread: { id } } });
  }
  if (msg.method === 'turn/start') {
    const id = 'turn-' + (++turn);
    const n = (method, params) => emit({ method, params: { threadId: p.threadId, turnId: id, ...params } });
    emit({ id: msg.id, result: { turn: { id } } });
    if (/modex-title-/.test(cwds.get(p.threadId) || '')) {
      n('item/completed', { item: { id: 'name-' + turn, type: 'agentMessage', text: 'Long log', phase: 'final_answer' } });
      return emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
    }
    const c = fs.existsSync(${JSON.stringify(counts)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(counts)}, 'utf8')) : {};
    c.commands = (c.commands || 0) + 1; fs.writeFileSync(${JSON.stringify(counts)}, JSON.stringify(c));
    emit({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } });
    const command = "/bin/zsh -lc 'cat build.log'";
    n('item/started', { item: { type: 'commandExecution', id: 'c1', command, cwd: '/repo', status: 'inProgress' } });
    let at = 0;
    const next = () => {
      if (at < log.length) { n('item/commandExecution/outputDelta', { itemId: 'c1', delta: log.slice(at, at += ${CHUNK}) }); return setTimeout(next, 5); }
      n('item/completed', { item: { type: 'commandExecution', id: 'c1', command, cwd: '/repo', status: 'completed', exitCode: 0, aggregatedOutput: log } });
      n('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Printed the build log.', phase: 'final_answer' } });
      emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
    };
    return setTimeout(next, 5);
  }
  if (msg.id !== undefined && msg.method) emit({ id: msg.id, error: { code: -32601, message: 'fixture does not implement ' + msg.method } });
});
`, { mode: 0o755 });
  return cli;
}

const commands = () => (JSON.parse(fs.readFileSync(counts, "utf8")) as { commands: number }).commands;
const row = () => items(page, "tool").filter({ hasText: "cat build.log" });

async function openRow(): Promise<void> {
  await tid(page, "turn-label").last().click();
  await tid(row(), "item-toggle").click();
  await expect(tid(row(), "tool-truncated")).toContainText(`Showing the last 256 KB of ${SIZE}.`);
}

test.beforeAll(async () => {
  ({ home, repo } = seedHome({ default_backend: "codex" }));
  counts = path.join(home, "fixture-counts.json");
  const statePath = path.join(home, "app", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.codex_bin = fakeCodex(home);
  fs.writeFileSync(statePath, JSON.stringify(state));
  ({ app, page } = await launch(home));
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "composer-input")).toBeFocused();
  await tid(page, "composer-input").fill("Print the build log");
  await page.keyboard.press("Meta+Enter");
  await expect(tid(page, "thread-view")).toBeVisible({ timeout: 15_000 });
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle", { timeout: 60_000 });
  await openRow();
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

test("the preview shows the end; Show full log starts at the first line and pages through, running nothing", async () => {
  await expect(tid(row(), "tool-output")).not.toContainText("line 000001 ");
  await tid(row(), "tool-log-show").click();
  const log = tid(row(), "tool-log");
  await expect(tid(log, "tool-log-text")).toContainText("line 000001 ");
  await expect(tid(log, "tool-log-status")).toContainText(`Kept all ${SIZE}`);
  await expect(tid(log, "tool-log-status")).toContainText(`Page 1 of ${PAGES}`);
  await tid(log, "tool-log-next").click();
  await expect(tid(log, "tool-log-status")).toContainText(`Page 2 of ${PAGES}`);
  await expect(tid(log, "tool-log-text")).not.toContainText("line 000001 ");
  await tid(log, "tool-log-prev").click();
  await expect(tid(log, "tool-log-text")).toContainText("line 000001 ");
  expect(commands()).toBe(1);
  await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
});

test("the full log is still there after a restart", async () => {
  await app.close();
  ({ app, page } = await launch(home));
  await openRow();
  await tid(row(), "tool-log-show").click();
  await expect(tid(tid(row(), "tool-log"), "tool-log-text")).toContainText("line 000001 ");
  expect(commands()).toBe(1);
});
