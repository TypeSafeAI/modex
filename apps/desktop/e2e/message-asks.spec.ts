import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * A question Codex asks in its reply (docs/task-context.md#live-codex-captures): an `agentMessage` with
 * `delivery: "async"` and `questions`, as gpt-6-astra sent it live on codex-cli 0.163.0. There is no request
 * to answer; an option sends itself as the next message, from the latest reply only. The executable below is
 * a scripted app-server, not a provider.
 */
function fixture(dir: string): string {
  const cli = path.join(dir, "codex-asks.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const log = ${JSON.stringify(path.join(dir, "turn-starts.jsonl"))};
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
let turn = 0;
const cwds = new Map();
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const p = msg.params || {};
  if (msg.method === 'initialize') return emit({ id: msg.id, result: { userAgent: 'codex-asks/0.163.0' } });
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
    const title = /modex-title-/.test(cwds.get(p.threadId) || '');
    if (!title) fs.appendFileSync(log, JSON.stringify(p.input.map((i) => i.text)) + '\\n');
    emit({ id: msg.id, result: { turn: { id } } });
    emit({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } });
    const say = (text, questions) => emit({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item: { id: 'say-' + turn, type: 'agentMessage', text, phase: 'final_answer', memoryCitation: null, delivery: questions ? 'async' : null, questions } } });
    if (title) say('Greeting');
    else if (turn <= 3) say('Should greeting.txt say hello in English or in Spanish?\\n- English\\n- Spanish', [{ title: 'Should greeting.txt say hello in English or in Spanish?', options: ['English', 'Spanish'] }]);
    else say('Wrote Hello.');
    return emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
  }
  if (msg.id !== undefined && msg.method) emit({ id: msg.id, error: { code: -32601, message: 'fixture does not implement ' + msg.method } });
});
`, { mode: 0o755 });
  return cli;
}

const starts = (dir: string): string[][] => {
  const file = path.join(dir, "turn-starts.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
};

test("a question Codex asks in its reply offers its options; one sends itself as the next message, and older replies' options are off", async () => {
  const { home } = seedHome({ default_backend: "codex", default_mode: "agent" });
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-asks-"));
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.codex_bin = fixture(logs);
  fs.writeFileSync(statePath, JSON.stringify(state));
  const { app, page } = await launch(home);
  try {
    await page.keyboard.press("Meta+n");
    await tid(page, "composer-input").fill("Write the greeting");
    await page.keyboard.press("Meta+Enter");
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    const asks = tid(items(page, "assistant").last(), "message-asks");
    await expect(tid(asks, "message-ask")).toContainText("Should greeting.txt say hello in English or in Spanish?");
    await expect(tid(asks, "message-ask-option")).toHaveText(["English", "Spanish"]);
    await expect(asks).toContainText("Your next message is the answer.");
    await expect(items(page, "question")).toHaveCount(0);

    await tid(asks, "message-ask-option").filter({ hasText: "English" }).click();
    await expect.poll(() => starts(logs).length).toBe(2);
    // Modex puts its skill instructions first; the message itself is the option, exactly.
    expect(starts(logs)[1]!.at(-1)!.split("\n").at(-1)).toBe("English");
    await expect(items(page, "user").last()).toContainText("English");
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");

    // The first reply's options are off once something was sent after it; the latest reply's are on.
    const replies = items(page, "assistant");
    await expect(tid(replies.first(), "message-ask-option").first()).toBeDisabled();
    await expect(tid(replies.last(), "message-ask-option").first()).toBeEnabled();
  } finally { await app.close(); }
});
