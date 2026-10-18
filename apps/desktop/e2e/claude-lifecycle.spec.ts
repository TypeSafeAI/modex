import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid, items } from "./support";

// Stop and withdrawn permission prompts through the real ClaudeBackend, runner, IPC and UI (#275). The local
// executable below speaks Claude Code 2.1.302's stream-json the way it was captured live on 2026-10-18: an
// interrupt withdraws the pending can_use_tool (control_cancel_request), is acknowledged, closes the turn
// (error_during_execution, aborted_tools) and the CLI exits with code 1 once its input ends. It is a scripted
// fixture, not live-model evidence.

function fixture(home: string, stage: string): string {
  const cli = path.join(home, "claude-lifecycle.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.302 (Claude Code)'); process.exit(0); }
if (process.argv.includes('auth')) { console.log('{"loggedIn":true,"authMethod":"claude.ai"}'); process.exit(0); }
if (path.basename(process.cwd()).startsWith('modex-title-')) process.exit(1);
const log = ${JSON.stringify(path.join(home, "claude-stdin.jsonl"))};
const record = (entry) => fs.appendFileSync(log, JSON.stringify({ pid: process.pid, ...entry }) + '\\n');
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let mode = '', pending = null;
process.on('SIGTERM', () => { record({ signal: 'SIGTERM' }); process.exit(143); });
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  record({ msg });
  if (msg.type === 'user') {
    const text = typeof msg.message.content === 'string' ? msg.message.content : '';
    mode = text.includes('slow') ? 'slow' : text.includes('withdraw') ? 'withdraw' : 'card';
    emit({ type: 'system', subtype: 'init', session_id: 's-' + mode, claude_code_version: '2.1.302', capabilities: ['interrupt_receipt_v1'] });
    if (mode === 'slow') {
      // Ignores the interrupt and the end of its input; only SIGTERM ends it.
      setInterval(() => {}, 1000);
      emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Working on it' } } });
      return;
    }
    pending = 'req-' + mode;
    const input = { command: 'touch ' + mode + '.txt' };
    emit({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 'tu-' + mode, name: 'Bash', input }] } });
    emit({ type: 'control_request', request_id: pending, request: { subtype: 'can_use_tool', tool_name: 'Bash', input, tool_use_id: 'tu-' + mode } });
    if (mode === 'withdraw') {
      const timer = setInterval(() => {
        if (!fs.existsSync(${JSON.stringify(stage)})) return;
        clearInterval(timer);
        emit({ type: 'control_cancel_request', request_id: pending });
        pending = null;
        emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-withdraw', content: 'Permission request withdrawn', is_error: true }] } });
        emit({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Skipped the file.' }] } });
        emit({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, session_id: 's-withdraw' });
      }, 50);
    }
    return;
  }
  if (msg.type === 'control_request' && msg.request && msg.request.subtype === 'interrupt' && mode !== 'slow') {
    if (pending) { emit({ type: 'control_cancel_request', request_id: pending }); pending = null; }
    emit({ type: 'control_response', response: { subtype: 'success', request_id: msg.request_id, response: { still_queued: [] } } });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu-' + mode, content: "The user doesn't want to proceed with this tool use.", is_error: true }] } });
    emit({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } });
    emit({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 2, session_id: 's-' + mode, terminal_reason: 'aborted_tools', errors: ['[ede_diagnostic] result_type=user'] });
  }
});
rl.on('close', () => { record({ stdin: 'end' }); if (mode !== 'slow') process.exit(1); });
`, { mode: 0o755 });
  return cli;
}

type Entry = { pid: number; msg?: { type: string; request_id?: string; request?: { subtype?: string }; response?: { request_id?: string } }; signal?: string; stdin?: string };
const entries = (home: string): Entry[] => {
  const file = path.join(home, "claude-stdin.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Entry) : [];
};
const answered = (home: string, id: string) => entries(home).filter((e) => e.msg?.type === "control_response" && e.msg.response?.request_id === id);
const interrupts = (home: string) => entries(home).filter((e) => e.msg?.type === "control_request" && e.msg.request?.subtype === "interrupt");

async function send(page: Page, text: string): Promise<void> {
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "draft-view")).toBeVisible();
  await tid(page, "composer-input").fill(text);
  await tid(page, "send").click();
}
const currentRow = (page: Page) => page.locator('[data-testid="thread-row"][aria-current="true"]');

test("Claude Stop and withdrawn prompts: cards close inert, Stop ends the CLI, late answers do nothing", async () => {
  const { home, repo } = seedHome({ default_backend: "claude", default_mode: "agent" });
  const stage = path.join(home, "withdraw-now");
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.claude_bin = fixture(home, stage);
  fs.writeFileSync(statePath, JSON.stringify(state));
  let app: ElectronApplication | undefined;
  try {
    const opened = await launch(home); app = opened.app;
    const page = opened.page;

    // 1. Stop while a permission card waits: one interrupt, the CLI withdraws the prompt, the card closes as stopped.
    await send(page, "card: touch a file");
    const card = items(page, "approval").first();
    await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(currentRow(page)).toHaveAttribute("data-status", "waiting");
    await tid(page, "stop").click();
    await expect(tid(card, "approval-answer")).toHaveText("Not answered — the turn was stopped");
    await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect(items(page, "notice").last()).toHaveText(/^Stopped\.$/);
    await expect(page.locator('[data-item-kind="notice"][data-level="error"]')).toHaveCount(0);
    expect(interrupts(home)).toHaveLength(1);
    expect(answered(home, "req-card")).toEqual([]);
    // A late answer to the obsolete card (straight over IPC, as an old window or the phone could send) changes nothing.
    const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
    const late = await page.evaluate(async (id) => {
      const list = await window.modex!.invoke("thread:items", { threadId: id }) as { id: string; kind: string; withdrawn?: string }[];
      const stale = list.find((i) => i.kind === "approval")!;
      await window.modex!.invoke("thread:answer", { threadId: id, itemId: stale.id, answer: "yes" });
      const after = await window.modex!.invoke("thread:items", { threadId: id }) as { id: string; kind: string; answer?: string; withdrawn?: string }[];
      return after.find((i) => i.id === stale.id);
    }, threadId);
    expect(late).toMatchObject({ answer: "no", withdrawn: "stopped" });
    await expect(tid(card, "approval-answer")).toHaveText("Not answered — the turn was stopped");
    expect(answered(home, "req-card")).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("claude-stop-card.png") });

    // 2. Claude withdraws its own prompt mid-turn: the card closes as withdrawn and the turn carries on to its reply.
    await send(page, "withdraw: touch a file");
    const second = items(page, "approval").first();
    await expect(second.getByRole("button", { name: "Approve" })).toBeVisible();
    fs.writeFileSync(stage, "now");
    await expect(tid(second, "approval-answer")).toHaveText("Withdrawn — the agent no longer needs an answer");
    await expect(second.getByRole("button", { name: "Approve" })).toHaveCount(0);
    await expect(items(page, "assistant").last()).toContainText("Skipped the file.");
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    expect(answered(home, "req-withdraw")).toEqual([]);
    expect(fs.existsSync(path.join(repo, "withdraw.txt"))).toBe(false);
    await page.screenshot({ path: test.info().outputPath("claude-withdrawn-card.png") });

    // 3. A CLI that ignores the interrupt is terminated after the grace window, and the notice says so.
    await send(page, "slow: think for a while");
    await expect(items(page, "assistant").last()).toContainText("Working on it");
    await tid(page, "stop").click();
    await expect(items(page, "notice").last()).toHaveText("Stopped. Claude did not end the turn within 1.5 s of the interrupt, so Modex terminated it.", { timeout: 10_000 });
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    expect(entries(home).filter((e) => e.signal === "SIGTERM")).toHaveLength(1);
    await page.screenshot({ path: test.info().outputPath("claude-lifecycle.png") });
  } finally {
    if (app) await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
