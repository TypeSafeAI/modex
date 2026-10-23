import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { PROPOSED_WORDS, taskRecord, taskMarkdown, verification } from "../src/shared/task-context.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { FakeProcess, fakeSpawn } from "./fakeproc.js";
import { gitRepo, tmpdir } from "./helpers.js";

/**
 * Live codex-cli 0.163.0 turns replayed through the Codex backend and the runner (docs/task-context.md#live-codex-captures):
 * the clarification, files and checks reach the task record as Codex reported them, and a turn that
 * sent no plan has none and says so. Fixtures are redacted captures; `/repo` stands for the capture's project.
 */

type Line = { dir: "in" | "out"; msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown } };
function capture(name: string, cwd: string): { about: string; lines: Line[] } {
  const text = fs.readFileSync(fileURLToPath(new URL(`../../test/fixtures/${name}`, import.meta.url)), "utf8").replaceAll("/repo", cwd);
  const [head, ...rest] = text.trim().split("\n").map((l) => JSON.parse(l) as Line & { _about?: string });
  return { about: head!._about!, lines: rest };
}

/**
 * Plays a capture's app-server side: setup replies are the captured ones under the client's own ids;
 * after turn/start, every captured message in order, pausing at each server request until Modex
 * answers it. `close` ends a turn whose capture never completed (it is labelled where used).
 */
function replay(proc: FakeProcess, lines: Line[], close?: () => unknown) {
  const inbound = lines.filter((l) => l.dir === "in").map((l) => l.msg);
  const reply = (method: string) => inbound.find((m) => m.id !== undefined && !m.method && lines.some((o) => o.dir === "out" && o.msg.id === m.id && o.msg.method === method));
  const turnStart = inbound.indexOf(reply("turn/start")!);
  const rest = inbound.slice(turnStart + 1);
  const answers: unknown[] = [];
  let waiting: number | undefined;
  const play = () => {
    while (rest.length && waiting === undefined) {
      const m = rest.shift()!;
      proc.emitLine(m);
      if (m.method && m.id !== undefined) waiting = m.id;
    }
    if (!rest.length && waiting === undefined && close) proc.emitLine(close());
  };
  proc.stdin.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; result?: unknown };
      if (msg.method === "initialize") proc.emitLine({ ...reply("initialize"), id: msg.id });
      else if (msg.method === "thread/start") proc.emitLine({ ...reply("thread/start"), id: msg.id });
      else if (msg.method === "turn/start") { proc.emitLine({ ...reply("turn/start"), id: msg.id }); setImmediate(play); }
      else if (msg.method === undefined && msg.id === waiting) { answers.push(msg.result); waiting = undefined; setImmediate(play); }
      else if (msg.method && msg.id !== undefined) proc.emitLine({ id: msg.id, result: {} });
    }
  });
  return answers;
}

async function harness(codex: CodexBackend, opts: { plan?: boolean } = {}) {
  const home = tmpdir("modex-live-");
  const store = new Store(home);
  const events: ThreadEvent[] = [];
  const runner = new ThreadRunner({ home, store, emit: (e) => events.push(e), backends: { codex } });
  const project = store.addProject(gitRepo());
  const thread = await runner.createThread(project.id, { backend: "codex", auto: false, ...(opts.plan ? { plan: true } : {}) });
  store.updateThread(thread.id, { title: "Greeting", titleSource: "manual" });
  return { runner, thread, cwd: project.path };
}
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };

test("live Codex (gpt-6.1-sol): the requestUserInput clarification, the edit and the check reach the task record; no plan was sent, so the turn says Codex reported none", async () => {
  const proc = new FakeProcess();
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  const { lines } = capture("codex-plan-question-0.163.0.jsonl", h.cwd);
  const turnCompleted = lines.filter((l) => l.msg.method === "turn/completed");
  assert.equal(turnCompleted.length, 0, "the capture has no turn/completed");
  const thr = (lines.find((l) => l.msg.method === "turn/started")!.msg.params as { threadId: string; turn: { id: string } });
  // Not captured: Codex sent no turn/completed in the 600 s after its final message. The test ends the turn.
  const answers = replay(proc, lines, () => ({ method: "turn/completed", params: { threadId: thr.threadId, turn: { id: thr.turn.id, status: "completed", error: null } } }));
  try {
    const sent = h.runner.send(h.thread.id, "Write the greeting");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question") as ThreadItem & { kind: "question" };
    assert.deepEqual(card.questions.map((q) => [q.id, q.header, q.text, q.options?.map((o) => o.label), q.allowOther, q.secret]),
      [["greeting_language", "Language", "Should greeting.txt say hello in English or in Spanish?", ["English", "Spanish"], true, false]]);
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, card.id, { greeting_language: ["English"] }), { ok: true });
    await sent;
    const accepted = lines.find((l) => l.dir === "out" && !l.msg.method && (l.msg.result as { answers?: unknown })?.answers)!.msg.result;
    assert.deepEqual(answers, [accepted], "Modex sends the answer Codex accepted live");

    const items = h.runner.items(h.thread.id);
    assert.equal(items.some((i) => i.kind === "plan"), false, "Codex sent no turn/plan/updated");
    const record = taskRecord(items, { threadId: h.thread.id, title: "Greeting", cwd: h.cwd });
    assert.equal(record.plan, undefined);
    assert.equal(record.noPlan, "codex");
    assert.deepEqual(record.clarifications, [{ question: "Should greeting.txt say hello in English or in Spanish?", answer: ["English"] }]);
    assert.deepEqual(record.files, ["greeting.txt"]);
    assert.deepEqual(record.commands.map((c) => [c.command, c.outcome, c.exitCode]).at(-1), ["/bin/zsh -lc 'node check.js'", "succeeded", 0], "as Codex reported it");
    assert.equal(verification(items).state, "none", "node check.js is not a known check, so nothing is verified");
    // Codex parsed `cat check.js greeting.txt` and the rg listing as "unknown" actions, so they are not reads.
    assert.deepEqual(record.context?.files.map((f) => [f.path, f.relations]), [["greeting.txt", ["changed"]]]);
    const md = taskMarkdown(record);
    for (const expected of ["- Should greeting.txt say hello in English or in Spanish? — English", "- `greeting.txt`", "- `/bin/zsh -lc 'node check.js'` — succeeded, exit code 0"]) assert.ok(md.includes(expected), `missing: ${expected}\n${md}`);
    assert.ok(md.includes("## Plan\n\nCodex reported no plan for this turn."), md);
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("live Codex (gpt-6-astra): an async question in an agent message is kept with the reply, answered by the next message, and its sleeps are not tools that ran", async () => {
  const proc = new FakeProcess();
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  const { lines } = capture("codex-async-question-0.163.0.jsonl", h.cwd);
  replay(proc, lines);
  try {
    await h.runner.send(h.thread.id, "Write the greeting");
    const items = h.runner.items(h.thread.id);
    assert.equal(items.some((i) => i.kind === "question"), false, "Codex asked in text; there is no request to answer");
    assert.equal(items.some((i) => i.kind === "plan"), false);
    const asked = items.find((i) => i.kind === "assistant" && i.text.includes("English or in Spanish")) as ThreadItem & { kind: "assistant" } | undefined;
    assert.ok(asked, "the question is shown as Codex's message");
    assert.deepEqual(asked.asks, [{ title: "Should greeting.txt say hello in English or in Spanish?", options: ["English", "Spanish"] }], "with the questions Codex attached");
    const sleeps = items.filter((i) => i.kind === "tool" && /sleep/i.test(`${i.name} ${i.title}`));
    assert.equal(sleeps.length, 0, `sleep items are not commands: ${JSON.stringify(sleeps.map((i) => i.kind === "tool" && i.title))}`);
    const record = taskRecord(items, { threadId: h.thread.id, title: "Greeting", cwd: h.cwd });
    assert.deepEqual(record.clarifications, [{ question: "Should greeting.txt say hello in English or in Spanish?", answer: null, closed: "message" }]);
    assert.ok(taskMarkdown(record).includes("- Should greeting.txt say hello in English or in Spanish? — asked in a message: the answer is the next message"), taskMarkdown(record));
    assert.deepEqual(record.files, []);
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("live Codex (gpt-6.1-sol) never sent turn/completed: after its final answer and a quiet period, Modex ends the turn, says so and interrupts it", async () => {
  const proc = new FakeProcess();
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  codex.quietAfterFinalMs = 50;
  const h = await harness(codex);
  const { lines } = capture("codex-plan-question-0.163.0.jsonl", h.cwd);
  const interrupts: unknown[] = [];
  proc.stdin.on("data", (d: Buffer) => { for (const l of d.toString().split("\n")) if (l.includes('"turn/interrupt"')) interrupts.push(JSON.parse(l)); });
  replay(proc, lines);
  try {
    const sent = h.runner.send(h.thread.id, "Write the greeting");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question")!;
    h.runner.answerQuestion(h.thread.id, card.id, { greeting_language: ["English"] });
    await sent;
    assert.notEqual(h.runner.status(h.thread.id), "running");
    assert.equal(interrupts.length, 1, "Codex is asked to end the turn it never reported finished");
    assert.match(JSON.stringify(h.runner.items(h.thread.id)), /did not report the turn finished/);
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("live Codex (gpt-6.1-sol) in plan mode: the clarification and the proposed plan reach the task record, it does not say no plan, and the turn Codex never ended is ended", async () => {
  const proc = new FakeProcess();
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  codex.quietAfterFinalMs = 50;
  const h = await harness(codex, { plan: true });
  const { lines } = capture("codex-plan-mode-0.163.0.jsonl", h.cwd);
  assert.equal(lines.filter((l) => l.msg.method === "turn/completed").length, 0, "the capture has no turn/completed");
  const sentLines: { method?: string; params?: Record<string, unknown> }[] = [];
  proc.stdin.on("data", (d: Buffer) => { for (const l of d.toString().split("\n")) if (l.trim()) sentLines.push(JSON.parse(l)); });
  const answers = replay(proc, lines);
  try {
    const sent = h.runner.send(h.thread.id, "Plan the greeting");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question") as ThreadItem & { kind: "question" };
    assert.deepEqual(card.questions.map((q) => [q.id, q.text, q.options?.map((o) => o.label)]),
      [["greeting_language", "Should the greeting be in English or in Spanish?", ["English (Recommended)", "Spanish"]]]);
    h.runner.answerQuestion(h.thread.id, card.id, { greeting_language: ["English"] });
    await sent;
    const accepted = lines.find((l) => l.dir === "out" && !l.msg.method && (l.msg.result as { answers?: unknown })?.answers)!.msg.result;
    assert.deepEqual(answers, [accepted], "Modex sends the answer Codex accepted live");
    assert.equal((sentLines.find((m) => m.method === "turn/start")?.params?.collaborationMode as { mode?: string })?.mode, "plan");
    assert.equal(sentLines.filter((m) => m.method === "turn/interrupt").length, 1, "Codex is asked to end the turn it never reported finished");

    const items = h.runner.items(h.thread.id);
    assert.match(JSON.stringify(items), /Codex proposed its plan but did not report the turn finished/);
    assert.equal(items.some((i) => i.kind === "plan"), false, "Codex sent no turn/plan/updated: the plan is its plan item");
    const proposed = items.find((i) => i.kind === "assistant" && i.nativePhase === "plan") as ThreadItem & { kind: "assistant" } | undefined;
    assert.ok(proposed, "the plan item is shown as a message");
    assert.ok(proposed.text.startsWith("## Add and verify the greeting"), "as Codex wrote it");

    const record = taskRecord(items, { threadId: h.thread.id, title: "Greeting", cwd: h.cwd });
    assert.equal(record.proposedPlan, proposed.text.trim());
    assert.equal(record.noPlan, undefined, "a proposed plan is a plan Codex reported");
    assert.equal(record.answer, undefined, "the plan is not repeated as the answer");
    assert.deepEqual(record.clarifications, [{ question: "Should the greeting be in English or in Spanish?", answer: ["English"] }]);
    assert.deepEqual(record.files, [], "plan mode edited nothing");
    const md = taskMarkdown(record);
    assert.ok(md.includes(`## Plan\n\n${PROPOSED_WORDS}\n\n> ## Add and verify the greeting\n>\n> 1. Create \`greeting.txt\``), md);
    assert.ok(!md.includes("reported no plan"), md);
  } finally { await h.runner.dispose(); await codex.dispose(); }
});
