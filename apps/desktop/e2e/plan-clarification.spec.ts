import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { currentRow, items, launch, seedHome, tid } from "./support";

/**
 * A plan clarification (docs/task-context.md, CF-7 #280): the CLI reports a plan, asks a clarifying question
 * through the question card, and carries on once it is answered. The answer reaches the CLI once, and Save
 * to Notes records it with the secret hidden. A clarification nobody answered says so and gains no answer.
 * The executable below is a scripted codex-cli 0.163.0 app-server (`turn/plan/updated`, then
 * `item/tool/requestUserInput`), not a provider.
 */
function fixture(dir: string): string {
  const cli = path.join(dir, "codex-clarify.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const log = ${JSON.stringify(path.join(dir, "codex-replies.jsonl"))};
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const questions = [
  { id: 'q-env', header: 'Environment', question: 'Which environment should the plan target?', isOther: false, isSecret: false, options: [{ label: 'staging', description: 'Safe to try' }, { label: 'production', description: 'Live traffic' }] },
  { id: 'q-token', header: 'Token', question: 'Paste the deploy token', isOther: true, isSecret: true, options: null },
];
let turn = 0, open = null;
const cwds = new Map();
const plan = (thread, id, a, b) => emit({ method: 'turn/plan/updated', params: { threadId: thread, turnId: id, explanation: null, plan: [{ step: 'Pick the environment', status: a }, { step: 'Deploy', status: b }] } });
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const p = msg.params || {};
  if (msg.method === 'initialize') return emit({ id: msg.id, result: { userAgent: 'codex-clarify/0.163.0' } });
  if (msg.method === 'initialized') return;
  if (msg.method === 'account/read') return emit({ id: msg.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (msg.method === 'model/list') return emit({ id: msg.id, result: { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true }], nextCursor: null } });
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const id = p.threadId || 'thr-' + cwds.size;
    cwds.set(id, p.cwd || '');
    return emit({ id: msg.id, result: { thread: { id } } });
  }
  if (msg.method === 'turn/start' && /modex-title-/.test(cwds.get(p.threadId) || '')) {
    const id = 'title-' + (++turn);
    emit({ id: msg.id, result: { turn: { id } } });
    emit({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item: { id: 'name-' + turn, type: 'agentMessage', text: 'Deploy plan', phase: 'final_answer' } } });
    return emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
  }
  if (msg.method === 'turn/start') {
    const id = 'turn-' + (++turn);
    open = { thread: p.threadId, turn: id, request: 900 + turn, done: false };
    emit({ id: msg.id, result: { turn: { id } } });
    emit({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } });
    plan(p.threadId, id, 'inProgress', 'pending');
    emit({ id: open.request, method: 'item/tool/requestUserInput', params: { threadId: p.threadId, turnId: id, itemId: 'ask-' + turn, isBlocking: true, autoResolutionMs: null, questions } });
    return;
  }
  const finish = (status, text) => {
    if (!open || open.done) return;
    open.done = true;
    if (text) emit({ method: 'item/completed', params: { threadId: open.thread, turnId: open.turn, item: { id: 'say-' + turn, type: 'agentMessage', text, phase: 'final_answer' } } });
    emit({ method: 'turn/completed', params: { threadId: open.thread, turn: { id: open.turn, status, error: null } } });
  };
  if (msg.method === 'turn/interrupt') { emit({ id: msg.id, result: {} }); return finish('interrupted'); }
  if (open && msg.id === open.request && !msg.method) {
    fs.appendFileSync(log, JSON.stringify({ request: msg.id, result: msg.result, error: msg.error }) + '\\n');
    if (msg.result) {
      plan(open.thread, open.turn, 'completed', 'completed');
      finish('completed', 'Planned the deploy to ' + msg.result.answers['q-env'].answers[0] + '.');
    }
    return;
  }
  if (msg.id !== undefined && msg.method) emit({ id: msg.id, error: { code: -32601, message: 'fixture does not implement ' + msg.method } });
});
`, { mode: 0o755 });
  return cli;
}

type Reply = { request: number; result?: { answers: Record<string, { answers: string[] }> }; error?: { code: number } };
const replies = (dir: string): Reply[] => {
  const file = path.join(dir, "codex-replies.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Reply) : [];
};
const everything = (dir: string): string => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8")).join("\n");

test("a plan clarification is answered on its card, reaches the CLI once, and is saved to Notes with the secret hidden; an unanswered one says so", async () => {
  const { home, repo } = seedHome({ default_backend: "codex", default_mode: "agent" });
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-clarify-"));
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.codex_bin = fixture(logs);
  fs.writeFileSync(statePath, JSON.stringify(state));
  const { app, page } = await launch(home);
  try {
    await page.keyboard.press("Meta+n");
    await tid(page, "composer-input").fill("Plan the deploy");
    await page.keyboard.press("Meta+Enter");
    // The plan as reported, then the clarification on the existing question card.
    await expect(tid(items(page, "plan"), "plan-step")).toHaveText(["In progress Pick the environment", "Not started Deploy"]);
    const card = items(page, "question").first();
    await expect(currentRow(page)).toHaveAttribute("data-status", "waiting");
    await card.getByRole("radio", { name: "staging" }).check();
    await card.getByLabel("Token").fill("s3cr3t-deploy-token");
    await tid(card, "question-submit").click();
    await expect(items(page, "assistant").last()).toContainText("Planned the deploy to staging.");
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect(tid(items(page, "plan"), "plan-step")).toHaveText(["Reported done Pick the environment", "Reported done Deploy"]);
    expect(replies(logs).map((reply) => reply.result)).toEqual([{ answers: { "q-env": { answers: ["staging"] }, "q-token": { answers: ["s3cr3t-deploy-token"] } } }]);

    // Save to Notes: the clarification is in the record, the secret is not.
    await tid(page, "save-task-note").last().click();
    await expect(tid(page, "task-note-saved").last()).toContainText("Saved to Notes · Task:");
    const notes = async () => (await page.evaluate(() => window.modex!.invoke("space:list", undefined))) as { title: string; markdown: string }[];
    const first = (await notes()).find((note) => note.title.startsWith("Task:"))!;
    expect(first.markdown).toContain("## Clarifications");
    expect(first.markdown).toContain("- Which environment should the plan target? — staging");
    expect(first.markdown).toContain("- Paste the deploy token — (hidden)");
    expect(first.markdown).not.toContain("s3cr3t-deploy-token");

    // A second turn asks again, and Stop closes the question unanswered: the CLI gets an error, the record no answer.
    await tid(page, "composer-input").fill("Plan it again");
    await page.keyboard.press("Meta+Enter");
    await expect(tid(items(page, "question").nth(1), "question-submit")).toBeVisible();
    await tid(page, "stop").click();
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect.poll(() => replies(logs).length).toBe(2);
    expect(replies(logs)[1]).toMatchObject({ error: { code: -32000 } });
    await tid(page, "save-task-note").last().click();
    await expect(tid(page, "task-note-saved").last()).toContainText("Saved to Notes · Task:");
    const second = (await notes()).filter((note) => note.title.startsWith("Task:")).find((note) => note.markdown.includes("Plan it again"))!;
    expect(second.markdown).toContain("- Which environment should the plan target? — not answered: the turn was stopped");
    expect(second.markdown).toMatch(/## Not settled\n[\s\S]*Paste the deploy token — not answered: the turn was stopped/);
    expect(second.markdown).not.toContain("— staging");
    expect(replies(logs)).toHaveLength(2);
    expect(everything(home).includes("s3cr3t-deploy-token")).toBe(false);
  } finally {
    await app.close();
    for (const dir of [home, repo, logs]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
