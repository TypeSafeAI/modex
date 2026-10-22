import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, seedHome, tid, items } from "./support";

// Plan mode on Codex through the real CodexBackend, runner, IPC and UI. The local executable below speaks
// codex-cli 0.163.0's app-server protocol the way the 2026-10-22 live capture recorded it
// (docs/reviews/2026-10-22-cf3-plan-mode-decision.md): in plan collaboration mode it asks one question and
// answers with a `plan` item and its deltas, and no agent message. It is a scripted fixture, not live-model evidence.

function fixture(dir: string): string {
  const cli = path.join(dir, "codex-plan.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const log = ${JSON.stringify(path.join(dir, "codex-turns.jsonl"))};
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const plan = '### Add a new-user greeting\\n\\nCreate \`greeting.txt\` with the selected greeting:\\n\\n- End the file with a newline.\\n- Verify the exact content.\\n';
let turn = 0, open = null;
const cwds = new Map();
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const p = msg.params || {};
  if (msg.method === 'initialize') return emit({ id: msg.id, result: { userAgent: 'codex-plan/0.163.0' } });
  if (msg.method === 'initialized') return;
  if (msg.method === 'account/read') return emit({ id: msg.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (msg.method === 'model/list') return emit({ id: msg.id, result: { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true }], nextCursor: null } });
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const id = p.threadId || 'thr-' + cwds.size;
    cwds.set(id, p.cwd || '');
    return emit({ id: msg.id, result: { thread: { id }, model: 'fixture-model' } });
  }
  if (msg.method === 'turn/start') {
    const id = 'turn-' + (++turn);
    const title = /modex-title-/.test(cwds.get(p.threadId) || '');
    if (!title) fs.appendFileSync(log, JSON.stringify({ collaborationMode: p.collaborationMode ?? null, text: p.input[0].text }) + '\\n');
    emit({ id: msg.id, result: { turn: { id } } });
    emit({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } });
    if (title || !p.collaborationMode) {
      emit({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item: { id: 'say-' + turn, type: 'agentMessage', text: title ? 'Greeting' : 'An ordinary answer.', phase: 'final_answer' } } });
      emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
      return;
    }
    open = { thread: p.threadId, turn: id, request: 700 + turn };
    emit({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item: { id: 'pre-' + turn, type: 'agentMessage', text: 'I will settle the greeting language before preparing the plan.', phase: 'commentary' } } });
    emit({ id: open.request, method: 'item/tool/requestUserInput', params: { threadId: p.threadId, turnId: id, itemId: 'ask-' + turn, isBlocking: true, autoResolutionMs: null, questions: [
      { id: 'greeting_language', header: 'Language', question: 'Which language should the greeting use?', isOther: true, isSecret: false, options: [{ label: 'English (Recommended)', description: 'Welcome!' }, { label: 'Spanish', description: '¡Bienvenido!' }] },
    ] } });
    return;
  }
  if (open && msg.id === open.request && !msg.method) {
    const { thread, turn: id } = open;
    open = null;
    fs.appendFileSync(log, JSON.stringify({ answered: msg.result }) + '\\n');
    emit({ method: 'item/started', params: { threadId: thread, turnId: id, item: { id: 'plan-' + id, type: 'plan', text: '' } } });
    emit({ method: 'item/plan/delta', params: { threadId: thread, turnId: id, itemId: 'plan-' + id, delta: '### Add a new-user ' } });
    emit({ method: 'item/plan/delta', params: { threadId: thread, turnId: id, itemId: 'plan-' + id, delta: 'greeting' } });
    emit({ method: 'item/completed', params: { threadId: thread, turnId: id, item: { id: 'plan-' + id, type: 'plan', text: plan } } });
    emit({ method: 'turn/completed', params: { threadId: thread, turn: { id, status: 'completed', error: null } } });
    return;
  }
  if (msg.method === 'turn/interrupt') return emit({ id: msg.id, result: {} });
  if (msg.id !== undefined && msg.method) emit({ id: msg.id, error: { code: -32601, message: 'fixture does not implement ' + msg.method } });
});
`, { mode: 0o755 });
  return cli;
}

const turns = (dir: string): Record<string, unknown>[] => {
  const file = path.join(dir, "codex-turns.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
};
const currentRow = (page: Page) => page.locator('[data-testid="thread-row"][aria-current="true"]');

test("Plan mode on Codex: native plan mode asks its question, and Codex's plan item is the answer", async () => {
  const { home } = seedHome({ default_backend: "codex", default_mode: "agent" });
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-codex-plan-"));
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.codex_bin = fixture(logs);
  fs.writeFileSync(statePath, JSON.stringify(state));
  let app: ElectronApplication | undefined;
  try {
    const opened = await launch(home); app = opened.app;
    const page = opened.page;

    await page.keyboard.press("Meta+n");
    await expect(tid(page, "draft-view")).toBeVisible();
    await page.keyboard.press("Meta+Shift+p");
    await expect(tid(page, "plan-chip")).toBeVisible();
    await tid(page, "composer-input").fill("Add a greeting.txt for new users");
    await tid(page, "send").click();

    // Codex's question tool is offered in plan mode with no feature flag: the card appears.
    const card = items(page, "question").first();
    await expect(tid(card, "question")).toHaveCount(1);
    await expect(currentRow(page)).toHaveAttribute("data-status", "waiting");
    const [planned] = turns(logs) as { collaborationMode: unknown; text: string }[];
    // The thread's model as Modex picked it (the default from model/list), carried into the mode, which overrides the turn's.
    expect(planned!.collaborationMode).toEqual({ mode: "plan", settings: { model: "fixture", reasoning_effort: null, developer_instructions: null } });
    expect(planned!.text).toMatch(/Add a greeting\.txt for new users$/);
    expect(planned!.text).not.toMatch(/PLAN MODE/);
    await card.getByRole("radio", { name: /English \(Recommended\)/ }).check();
    await tid(card, "question-submit").click();

    // The plan item is the turn's answer, rendered as Markdown.
    const answer = items(page, "assistant").last();
    await expect(answer.getByRole("heading", { name: "Add a new-user greeting" })).toBeVisible();
    await expect(answer).toContainText("Verify the exact content.");
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    expect(turns(logs)[1]).toEqual({ answered: { answers: { greeting_language: { answers: ["English (Recommended)"] } } } });
    const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
    const saved = await page.evaluate(async (id) => (await window.modex!.invoke("thread:items", { threadId: id }) as { kind: string; text?: string; phase?: string; nativePhase?: string }[])
      .filter((i) => i.kind === "assistant").map((i) => ({ phase: i.phase, nativePhase: i.nativePhase ?? null, plan: (i.text ?? "").startsWith("### Add a new-user greeting") })), threadId);
    expect(saved).toEqual([{ phase: "commentary", nativePhase: "commentary", plan: false }, { phase: "final", nativePhase: "plan", plan: true }]);
    await page.screenshot({ path: test.info().outputPath("codex-native-plan.png") });

    // Plan off: an ordinary turn, with no collaboration mode.
    await tid(page, "plan-chip").click();
    await expect(tid(page, "plan-chip")).toHaveCount(0);
    await tid(page, "composer-input").fill("Now just say hi");
    await tid(page, "send").click();
    await expect(items(page, "assistant").last()).toContainText("An ordinary answer.");
    expect(turns(logs)[2]).toMatchObject({ collaborationMode: null, text: expect.stringMatching(/Now just say hi$/) });
  } finally {
    await app?.close();
    fs.rmSync(logs, { recursive: true, force: true });
  }
});
