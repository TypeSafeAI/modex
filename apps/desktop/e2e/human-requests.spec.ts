import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, seedHome, tid, items } from "./support";

// Native questions through the real CodexBackend, runner, IPC and UI (#276). The local executable below speaks
// codex-cli 0.163.0's app-server protocol for `item/tool/requestUserInput` (experimental) the way its schema
// describes it: questions with ids, headers, options, `isOther` and `isSecret`, answered with `{ answers }`.
// It is a scripted fixture, not live-model evidence. Its log lives outside MODEX_HOME so the secret check
// below can read every file Modex wrote.

function fixture(dir: string, questionGate?: string, finishGate?: string): string {
  const cli = path.join(dir, "codex-questions.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv.includes('login') || process.argv.includes('auth')) { console.log('Logged in using ChatGPT'); process.exit(0); }
const log = ${JSON.stringify(path.join(dir, "codex-replies.jsonl"))};
const questionGate = ${JSON.stringify(questionGate ?? null)};
const finishGate = ${JSON.stringify(finishGate ?? null)};
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const questions = [
  { id: 'q-env', header: 'Environment', question: 'Which environment?', isOther: false, isSecret: false, options: [{ label: 'staging', description: 'Safe to try' }, { label: 'production', description: 'Live traffic' }] },
  { id: 'q-token', header: 'Token', question: 'Paste the deploy token', isOther: true, isSecret: true, options: null },
];
let turn = 0, asked = 0, open = null;
const cwds = new Map();
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  const p = msg.params || {};
  if (msg.method === 'initialize') return emit({ id: msg.id, result: { userAgent: 'codex-questions/0.163.0' } });
  if (msg.method === 'initialized') return;
  if (msg.method === 'account/read') return emit({ id: msg.id, result: { account: { type: 'chatgpt' }, requiresOpenaiAuth: true } });
  if (msg.method === 'model/list') return emit({ id: msg.id, result: { data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true }], nextCursor: null } });
  if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    const id = p.threadId || 'thr-' + cwds.size;
    cwds.set(id, p.cwd || '');
    return emit({ id: msg.id, result: { thread: { id } } });
  }
  if (msg.method === 'turn/start' && /modex-title-/.test(cwds.get(p.threadId) || '')) {
    // Thread naming runs in its own folder and asks nothing.
    const id = 'title-' + (++turn);
    emit({ id: msg.id, result: { turn: { id } } });
    emit({ method: 'item/completed', params: { threadId: p.threadId, turnId: id, item: { id: 'name-' + turn, type: 'agentMessage', text: 'Deploy', phase: 'final_answer' } } });
    emit({ method: 'turn/completed', params: { threadId: p.threadId, turn: { id, status: 'completed', error: null } } });
    return;
  }
  if (msg.method === 'turn/start') {
    const id = 'turn-' + (++turn);
    open = { thread: p.threadId, turn: id, request: 900 + (++asked), done: false };
    emit({ id: msg.id, result: { turn: { id } } });
    emit({ method: 'turn/started', params: { threadId: p.threadId, turn: { id } } });
    const request = { id: open.request, method: 'item/tool/requestUserInput', params: { threadId: p.threadId, turnId: id, itemId: 'ask-' + asked, isBlocking: true, autoResolutionMs: null, questions } };
    if (questionGate) {
      const pending = open;
      const timer = setInterval(() => {
        if (pending.done || open !== pending) return clearInterval(timer);
        if (fs.existsSync(questionGate)) { clearInterval(timer); emit(request); }
      }, 10);
    } else emit(request);
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
      const complete = () => finish('completed', 'Deploying to ' + msg.result.answers['q-env'].answers[0] + '.');
      if (finishGate) {
        const timer = setInterval(() => { if (fs.existsSync(finishGate)) { clearInterval(timer); complete(); } }, 10);
      } else complete();
    }
    return;
  }
  if (msg.id !== undefined && msg.method) emit({ id: msg.id, error: { code: -32601, message: 'fixture does not implement ' + msg.method } });
});
`, { mode: 0o755 });
  return cli;
}

type Reply = { request: number; result?: { answers: Record<string, { answers: string[] }> }; error?: { code: number; message: string } };
const replies = (dir: string): Reply[] => {
  const file = path.join(dir, "codex-replies.jsonl");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Reply) : [];
};
/** Every file under `dir`, read as text. */
const everything = (dir: string): string => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), "utf8")).join("\n");

async function send(page: Page, text: string): Promise<void> {
  await page.keyboard.press("Meta+n");
  await expect(tid(page, "draft-view")).toBeVisible();
  await tid(page, "composer-input").fill(text);
  await tid(page, "send").click();
}
const currentRow = (page: Page) => page.locator('[data-testid="thread-row"][aria-current="true"]');

for (const moveFocus of [false, true]) test(`a native question preserves the existing composer draft, staged attachment and ${moveFocus ? "moved" : "answer"} focus`, async () => {
  const { home } = seedHome({ default_backend: "codex", default_mode: "agent" });
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-question-draft-"));
  const gate = path.join(logs, "ask-now");
  const finishGate = path.join(logs, "finish-now");
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.codex_bin = fixture(logs, gate, finishGate);
  fs.writeFileSync(statePath, JSON.stringify(state));
  let app: ElectronApplication | undefined;
  try {
    const opened = await launch(home); app = opened.app;
    const page = opened.page;
    const threadId = await page.evaluate(async () => {
      const state = await window.modex!.invoke("state:get", undefined);
      return (await window.modex!.invoke("thread:create", { projectId: state.projects[0]!.id, backend: "codex", mode: "agent", auto: false })).id;
    });
    // Direct creation returns to its caller; reload to hydrate the renderer from main.
    await page.reload();
    await page.locator(`[data-testid="thread-row"][data-thread-id="${threadId}"]`).click();
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    const draft = "  keep this draft\nwith whitespace 😀  ";
    const composer = tid(page, "composer-input");
    await composer.fill(draft);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(["question draft attachment bytes"], "draft.txt", { type: "text/plain" }));
      document.querySelector('[data-testid="composer-input"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(tid(page, "composer-attachments")).toContainText("draft.txt");
    const recovery = () => JSON.parse(fs.readFileSync(path.join(home, "app/update-recovery.json"), "utf8")).drafts.threads.find((row: { threadId: string }) => row.threadId === threadId);
    await expect.poll(() => recovery()?.attachments.length).toBe(1);
    const saved = recovery();
    expect(saved.text).toBe(draft);
    await composer.focus();
    // A turn arriving through main must not consume the window's separate unsent draft.
    expect(await page.evaluate(threadId => window.modex!.invoke("thread:send", { threadId, text: "deploy it" }), threadId)).toEqual({ ok: true });
    await expect(currentRow(page)).toHaveAttribute("data-status", "running");
    fs.writeFileSync(gate, "ready");
    const card = items(page, "question").first();
    await expect(tid(card, "question")).toHaveCount(2);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(draft);
    expect(recovery()).toEqual(saved);
    expect(replies(logs)).toEqual([]);
    await card.getByRole("radio", { name: "staging" }).check();
    // Invalid keyboard submission must leave a usable focus target inside the card.
    await card.getByLabel("Token").focus();
    await card.getByLabel("Token").press("Enter");
    await expect(tid(card, "question-error")).toHaveText("Token needs an answer.");
    await expect(card.getByLabel("Token")).toBeFocused();
    expect(replies(logs)).toEqual([]);
    await card.getByLabel("Token").fill("question-only-secret");
    if (moveFocus) await page.evaluate(() => {
      // Bubble after React's Enter handler, before main's asynchronous answer comes back.
      document.addEventListener("keydown", (event) => { event.preventDefault(); (document.querySelector('[data-testid="composer-input"]') as HTMLTextAreaElement).focus(); }, { once: true });
    });
    await card.getByLabel("Token").press("Enter");
    await expect(tid(card, "question-answer")).toHaveText(["staging", "(hidden)"]);
    await expect(moveFocus ? composer : tid(card, "question-answer").first()).toBeFocused();
    fs.writeFileSync(finishGate, "ready");
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect(moveFocus ? composer : tid(page, "turn-label")).toBeFocused();
    await expect(composer).toHaveValue(draft);
    await expect(tid(page, "composer-attachments")).toContainText("draft.txt");
    expect(recovery()).toEqual(saved);
    await page.reload();
    await expect(composer).toHaveValue(draft);
    await expect(tid(page, "composer-attachments")).toContainText("draft.txt");
    expect(recovery()).toEqual(saved);
    expect(fs.readFileSync(path.join(home, "attachments", saved.attachments[0].rel), "utf8")).toBe("question draft attachment bytes");
    const transcript = JSON.parse(fs.readFileSync(path.join(home, "app/threads", `${threadId}.json`), "utf8"));
    expect(transcript.filter((item: { kind: string }) => item.kind === "user").map((item: { text: string }) => item.text)).toEqual(["deploy it"]);
    expect(replies(logs)).toHaveLength(1);
    expect(everything(path.join(home, "app"))).not.toContain("question-only-secret");
  } finally { await app?.close(); fs.rmSync(logs, { recursive: true, force: true }); }
});

test("Codex questions: the card answers by its schema, the CLI hears once, the secret stays out, Stop withdraws", async () => {
  const { home } = seedHome({ default_backend: "codex", default_mode: "agent" });
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-codex-questions-"));
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.codex_bin = fixture(logs);
  fs.writeFileSync(statePath, JSON.stringify(state));
  let app: ElectronApplication | undefined;
  try {
    const opened = await launch(home); app = opened.app;
    const page = opened.page;

    // 1. The card shows each question with its own control; an incomplete answer is refused in place.
    await send(page, "deploy it");
    const card = items(page, "question").first();
    await expect(tid(card, "question")).toHaveCount(2);
    await expect(currentRow(page)).toHaveAttribute("data-status", "waiting");
    await expect(tid(page, "turn-label")).toHaveText(/^Waiting for your answer · \d+s$/);
    await card.getByRole("radio", { name: "staging" }).check();
    await tid(card, "question-submit").click();
    await expect(tid(card, "question-error")).toHaveText("Token needs an answer.");
    expect(replies(logs)).toEqual([]);
    const token = card.getByLabel("Token");
    await expect(token).toHaveAttribute("type", "password");
    await token.fill("  s3cr3t-token  ");
    // A pending answer belongs to the request, even while its thread view is unmounted.
    const waitingThread = (await currentRow(page).getAttribute("data-thread-id"))!;
    await page.keyboard.press("Meta+n");
    await expect(tid(page, "draft-view")).toBeVisible();
    await page.locator(`[data-testid="thread-row"][data-thread-id="${waitingThread}"]`).click();
    await expect(card.getByRole("radio", { name: "staging" })).toBeChecked();
    await expect(token).toHaveValue("  s3cr3t-token  ");
    expect(replies(logs)).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("codex-question-card.png") });
    await tid(card, "question-submit").click();

    // 2. Codex hears the answers once; the card shows them with the secret hidden; the turn carries on.
    await expect(tid(card, "question-answer")).toHaveText(["staging", "(hidden)"]);
    await expect(items(page, "assistant").last()).toContainText("Deploying to staging.");
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    expect(replies(logs)).toEqual([{ request: 901, result: { answers: { "q-env": { answers: ["staging"] }, "q-token": { answers: ["  s3cr3t-token  "] } } } }]);
    // A second answer (an old window, or a double click) is refused and reaches nothing.
    const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
    const again = await page.evaluate(async (id) => {
      const list = await window.modex!.invoke("thread:items", { threadId: id }) as { id: string; kind: string }[];
      const asked = list.find((i) => i.kind === "question")!;
      return window.modex!.invoke("thread:answer-question", { threadId: id, itemId: asked.id, answers: { "q-env": ["production"], "q-token": ["other"] } });
    }, threadId);
    expect(again).toEqual({ ok: false, reason: "already-resolved" });
    expect(replies(logs)).toHaveLength(1);
    await page.screenshot({ path: test.info().outputPath("codex-question-answered.png") });

    // 3. Stop while a question waits: the card closes as stopped, and Codex gets an error, never an empty answer.
    await send(page, "deploy again");
    const second = items(page, "question").first();
    await expect(tid(second, "question-submit")).toBeVisible();
    await tid(page, "stop").click();
    await expect(tid(second, "question-closed")).toHaveText("Not answered — the turn was stopped");
    await expect(tid(second, "question-submit")).toHaveCount(0);
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect.poll(() => replies(logs).length).toBe(2);
    expect(replies(logs)[1]).toMatchObject({ request: 902, error: { code: -32000 } });

    // Nothing Modex saved (threads, journal, state) holds the secret.
    expect(everything(path.join(home, "app")).includes("s3cr3t-token")).toBe(false);
  } finally {
    await app?.close();
    fs.rmSync(logs, { recursive: true, force: true });
  }
});

test("Codex questions: a draft and its attachments survive the card being shown and answered (#276)", async () => {
  const { home } = seedHome({ default_backend: "codex", default_mode: "agent" });
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-codex-questions-"));
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.codex_bin = fixture(logs);
  fs.writeFileSync(statePath, JSON.stringify(state));
  let app: ElectronApplication | undefined;
  try {
    const opened = await launch(home); app = opened.app;
    const page = opened.page;
    await send(page, "deploy it");
    const first = items(page, "question").first();
    await first.getByRole("radio", { name: "staging" }).check();
    await first.getByLabel("Token").fill("s3cr3t");
    await tid(first, "question-submit").click();
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");

    // Write the next message and attach a file while nothing runs (attaching is refused during a turn).
    const draft = "  the follow-up I am still writing\n  second line  ";
    const input = tid(page, "composer-input");
    await input.fill(draft);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File(["kept bytes"], "kept.txt", { type: "text/plain" }));
      document.querySelector('[data-testid="composer-input"]')!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const chips = tid(page, "composer-attachments");
    await expect(chips).toContainText("kept.txt");

    // A turn this composer did not send, as from the iPhone, asks a question while the draft sits there.
    const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
    await page.evaluate((id) => window.modex!.invoke("thread:send", { threadId: id, text: "deploy again" }), threadId);
    const card = items(page, "question").last();
    await expect(tid(card, "question-submit")).toBeVisible();
    await expect(currentRow(page)).toHaveAttribute("data-status", "waiting");
    await expect(input).toHaveValue(draft);
    await expect(chips).toContainText("kept.txt");

    // A refused answer and a good one both leave the composer as written.
    await card.getByRole("radio", { name: "staging" }).check();
    await tid(card, "question-submit").click();
    await expect(tid(card, "question-error")).toHaveText("Token needs an answer.");
    await expect(input).toHaveValue(draft);
    await expect(chips).toContainText("kept.txt");
    await card.getByLabel("Token").fill("s3cr3t");
    await tid(card, "question-submit").click();
    await expect(tid(card, "question-answer")).toHaveText(["staging", "(hidden)"]);
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect(input).toHaveValue(draft);
    await expect(chips).toContainText("kept.txt");
    expect(replies(logs)).toHaveLength(2);

    // The draft was never sent: the only user messages are the two that started the turns.
    await expect(items(page, "user")).toHaveCount(2);
  } finally {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(logs, { recursive: true, force: true });
  }
});

test("with the journal on, a restart shows answered and stopped cards inert, says when an answer was never confirmed, and re-sends nothing", async () => {
  const { home } = seedHome({ default_backend: "codex", default_mode: "agent" });
  const logs = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-codex-questions-"));
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.settings.codex_bin = fixture(logs);
  fs.writeFileSync(statePath, JSON.stringify(state));
  const journal = process.env.MODEX_EVENT_JOURNAL;
  process.env.MODEX_EVENT_JOURNAL = "1";
  let app: ElectronApplication | undefined;
  try {
    let opened = await launch(home); app = opened.app;
    let page = opened.page;
    await send(page, "deploy it");
    const card = items(page, "question").first();
    await card.getByRole("radio", { name: "staging" }).check();
    await card.getByLabel("Token").fill("s3cr3t-token");
    await tid(card, "question-submit").click();
    await expect(tid(card, "question-answer")).toHaveText(["staging", "(hidden)"]);
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect(tid(card, "answer-note")).toHaveCount(0);
    // A follow-up in the same thread asks again; Stop closes that card unanswered.
    await tid(page, "composer-input").fill("deploy again");
    await page.keyboard.press("Meta+Enter");
    await expect(tid(items(page, "question").nth(1), "question-submit")).toBeVisible();
    await tid(page, "stop").click();
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
    const lifecycle = (list: { kind: string; answeredBy?: string; delivery?: string; withdrawn?: string }[]) =>
      list.filter((i) => i.kind === "question").map((i) => [i.answeredBy ?? null, i.delivery ?? null, i.withdrawn ?? null]);
    expect(lifecycle(await page.evaluate((id) => window.modex!.invoke("thread:items", { threadId: id }), threadId) as never)).toEqual([["desktop", "sent", null], [null, null, "stopped"]]);
    await app.close();
    app = undefined;
    expect(replies(logs)).toHaveLength(2);

    // As if Modex had died after taking the first answer and before recording its hand-off to Codex.
    const file = path.join(home, "app", "threads", `${threadId}.json`);
    const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { kind: string; delivery?: string }[];
    saved.find((i) => i.kind === "question")!.delivery = "sending";
    fs.writeFileSync(file, JSON.stringify(saved));

    opened = await launch(home); app = opened.app;
    page = opened.page;
    await page.locator(`[data-testid="thread-row"][data-thread-id="${threadId}"] button.thread-main`).click();
    const [first, second] = [items(page, "question").first(), items(page, "question").nth(1)];
    await expect(tid(first, "question-answer")).toHaveText(["staging", "(hidden)"]);
    await expect(tid(first, "answer-note")).toHaveText("Modex stopped before it could confirm the agent received this answer.");
    await expect(tid(second, "question-closed")).toHaveText("Not answered — the turn was stopped");
    await expect(page.locator('[data-testid="question-submit"]')).toHaveCount(0);
    expect(lifecycle(await page.evaluate((id) => window.modex!.invoke("thread:items", { threadId: id }), threadId) as never)).toEqual([["desktop", "uncertain", null], [null, null, "stopped"]]);
    // An old window answering the uncertain card again is refused, and nothing reaches Codex.
    expect(await page.evaluate(async (id) => {
      const list = await window.modex!.invoke("thread:items", { threadId: id }) as { id: string; kind: string }[];
      return window.modex!.invoke("thread:answer-question", { threadId: id, itemId: list.find((i) => i.kind === "question")!.id, answers: { "q-env": ["production"], "q-token": ["other"] } });
    }, threadId)).toEqual({ ok: false, reason: "already-resolved" });
    expect(replies(logs)).toHaveLength(2);
    await app.close();
    app = undefined;
    // The journal recorded all of it, and no file Modex wrote holds the secret.
    expect(fs.existsSync(path.join(home, "app", "events.sqlite"))).toBe(true);
    expect(everything(path.join(home, "app")).includes("s3cr3t-token")).toBe(false);
  } finally {
    if (journal === undefined) delete process.env.MODEX_EVENT_JOURNAL; else process.env.MODEX_EVENT_JOURNAL = journal;
    await app?.close();
    fs.rmSync(logs, { recursive: true, force: true });
  }
});

test("uncertain question delivery stays inert after restart and never reads as answered", async () => {
  const { home, repo } = seedHome();
  const statePath = path.join(home, "app/state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  const at = new Date().toISOString();
  state.threads = [{ id: "uncertain", projectId: "p1", title: "Uncertain answer", createdAt: at, updatedAt: at, cwd: repo, backend: "mock", model: "mock", mode: "chat", plan: false, status: "idle" }];
  fs.writeFileSync(statePath, JSON.stringify(state));
  fs.writeFileSync(path.join(home, "app/threads/uncertain.json"), JSON.stringify([
    { id: "u", kind: "user", text: "Deploy", at },
    { id: "a", kind: "approval", question: "Deploy?", answer: "yes", delivery: "sending", at },
    { id: "q", kind: "question", questions: [{ id: "env", header: "Environment", text: "Which?", options: null, allowOther: true, secret: false }], blocking: true, answers: { env: ["staging"] }, delivery: "sending", at },
  ]));
  const { app, page } = await launch(home);
  try {
    await page.locator('[data-testid="thread-row"][data-thread-id="uncertain"]').click();
    const card = items(page, "question").first();
    await expect(card).toContainText("Delivery uncertain");
    await expect(card).toHaveAttribute("data-answered", "false");
    const approval = items(page, "approval").first();
    await expect(approval).toContainText("Delivery uncertain");
    await expect(approval).toHaveAttribute("data-answered", "false");
    await expect(tid(card, "question-submit")).toHaveCount(0);
    const stored = JSON.parse(fs.readFileSync(path.join(home, "app/threads/uncertain.json"), "utf8"));
    expect(stored.find((item: { id: string }) => item.id === "q").delivery).toBe("uncertain");
  } finally { await app.close(); }
});
