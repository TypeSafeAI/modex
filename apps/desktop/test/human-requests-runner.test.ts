import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import type { Backend, TurnSink } from "../src/main/engine/backends/types.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { FakeProcess, fakeSpawn } from "./fakeproc.js";
import { gitRepo, tmpdir } from "./helpers.js";

/**
 * Requests through the runner (docs/human-requests.md): one accepted answer per request, an explicit
 * refusal for every other one, native questions answered by schema with secrets kept out of the
 * transcript, and cards nobody can answer any more made inert, including after a restart.
 */

async function harness(backend: Backend) {
  const home = tmpdir("modex-requests-");
  const store = new Store(home);
  const events: ThreadEvent[] = [];
  const runner = new ThreadRunner({ home, store, emit: (e) => events.push(e), backends: { [backend.id]: backend } });
  const project = store.addProject(gitRepo());
  const thread = await runner.createThread(project.id, { backend: backend.id, auto: false });
  store.updateThread(thread.id, { title: "Fixture", titleSource: "manual" });
  return { home, store, runner, thread, events };
}
const waitFor = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };

test("two answers to one approval: the first is accepted, the second is refused as already resolved, and the CLI hears one", async () => {
  const heard: string[] = [];
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink: TurnSink) {
    heard.push(await sink.approval({ question: "Allow Bash: $ npm test?", canAlways: true, action: { backend: "claude", tool: "Bash", title: "$ npm test", input: { command: "npm test" } } }));
    return { status: "completed" };
  } };
  const h = await harness(backend);
  const sent = h.runner.send(h.thread.id, "go");
  await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "approval"));
  const card = h.runner.items(h.thread.id).find((i) => i.kind === "approval")!;
  assert.deepEqual(h.runner.answer(h.thread.id, card.id, "yes"), { ok: true });
  assert.deepEqual(h.runner.answer(h.thread.id, card.id, "no"), { ok: false, reason: "already-resolved" });
  await sent;
  assert.deepEqual(heard, ["yes"]);
  assert.deepEqual(h.runner.answer(h.thread.id, "no-such-card", "yes"), { ok: false, reason: "unknown" });
  await h.runner.dispose();
});

/** The next transcript save fails the way a full disk does, once, after or before its write reaches the disk. */
function failNextSave(store: Store, written = false) {
  const save = store.saveItems;
  store.saveItems = (threadId, items) => {
    store.saveItems = save;
    if (written) save.call(store, threadId, items);
    throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
  };
}

test("an answer whose save fails is not taken: the approval stays open, and answering again reaches the CLI (CF-6 #279, finding 10)", async () => {
  const heard: string[] = [];
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink: TurnSink) {
    heard.push(await sink.approval({ question: "Allow Bash: $ npm test?", canAlways: true, action: { backend: "claude", tool: "Bash", title: "$ npm test", input: { command: "npm test" } } }));
    return { status: "completed" };
  } };
  const h = await harness(backend);
  const sent = h.runner.send(h.thread.id, "go");
  await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "approval"));
  const card = h.runner.items(h.thread.id).find((i) => i.kind === "approval")!;
  failNextSave(h.store);
  assert.throws(() => h.runner.answer(h.thread.id, card.id, "yes"), /ENOSPC/);
  assert.deepEqual(h.runner.items(h.thread.id).find((i) => i.id === card.id), card, "the card reads as it did before the answer");
  assert.equal(h.events.some((e) => e.type === "item_update" && e.id === card.id), false, "no client was told it was answered");
  assert.equal(h.store.thread(h.thread.id)?.status, "waiting");
  assert.deepEqual(heard, []);
  assert.deepEqual(h.runner.answer(h.thread.id, card.id, "no"), { ok: true }, "answering again is accepted");
  await sent;
  assert.deepEqual(heard, ["no"]);
  const answered = h.runner.items(h.thread.id).find((i) => i.id === card.id) as Extract<ThreadItem, { kind: "approval" }>;
  assert.deepEqual([answered.answer, answered.delivery], ["no", "sent"]);
  await h.runner.dispose();
});

test("a failed save whose write reached the disk reads as uncertain after a crash, never as sent", async () => {
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink: TurnSink) {
    await sink.approval({ question: "Allow Bash: $ deploy?", canAlways: false, action: { backend: "claude", tool: "Bash", title: "$ deploy" } });
    return { status: "completed" };
  } };
  const h = await harness(backend);
  const sent = h.runner.send(h.thread.id, "go");
  await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "approval"));
  const card = h.runner.items(h.thread.id).find((i) => i.kind === "approval")!;
  failNextSave(h.store, true);
  assert.throws(() => h.runner.answer(h.thread.id, card.id, "yes"), /ENOSPC/);
  // Modex crashes here: a new process reads what reached the disk.
  const restarted = new ThreadRunner({ home: h.home, store: new Store(h.home), emit: () => {}, backends: { claude: backend } });
  const read = restarted.items(h.thread.id).find((i) => i.id === card.id) as Extract<ThreadItem, { kind: "approval" }>;
  assert.deepEqual([read.answer, read.delivery], ["yes", "uncertain"]);
  await restarted.dispose();
  h.runner.stop(h.thread.id);
  await sent;
  await h.runner.dispose();
});

test("a question answer whose save fails is not taken either, and answering again reaches the CLI", async () => {
  const heard: unknown[] = [];
  const backend: Backend = { id: "codex", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink: TurnSink) {
    heard.push(await sink.question!({ blocking: true, questions: [{ id: "env", header: "Env", text: "Which environment?", options: null, allowOther: true, secret: false }] }));
    return { status: "completed" };
  } };
  const h = await harness(backend);
  const sent = h.runner.send(h.thread.id, "go");
  await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
  const card = h.runner.items(h.thread.id).find((i) => i.kind === "question")!;
  failNextSave(h.store);
  assert.throws(() => h.runner.answerQuestion(h.thread.id, card.id, { env: ["staging"] }), /ENOSPC/);
  assert.deepEqual(h.runner.items(h.thread.id).find((i) => i.id === card.id), card);
  assert.deepEqual(heard, []);
  assert.deepEqual(h.runner.answerQuestion(h.thread.id, card.id, { env: ["production"] }), { ok: true });
  await sent;
  assert.deepEqual(heard, [{ answers: { env: ["production"] } }]);
  await h.runner.dispose();
});

test("an approval withdrawn by Stop refuses a late answer as withdrawn", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink: TurnSink, signal) {
    void sink.approval({ question: "Allow Bash: $ deploy?", canAlways: false, action: { backend: "claude", tool: "Bash", title: "$ deploy" } });
    signal.addEventListener("abort", () => release());
    await held;
    return { status: "interrupted" };
  } };
  const h = await harness(backend);
  const sent = h.runner.send(h.thread.id, "go");
  await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "approval"));
  const card = h.runner.items(h.thread.id).find((i) => i.kind === "approval")!;
  h.runner.stop(h.thread.id);
  await sent;
  assert.deepEqual(h.runner.answer(h.thread.id, card.id, "yes"), { ok: false, reason: "withdrawn" });
  await h.runner.dispose();
});

/** A Codex app-server whose turn asks one requestUserInput question (codex-cli 0.163.0 shape) and finishes when answered. */
function codexAsking(proc: FakeProcess, params: Record<string, unknown>) {
  const replies: unknown[] = [];
  proc.stdin.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: unknown };
      if (msg.method === "initialize") proc.emitLine({ id: msg.id, result: { userAgent: "fake" } });
      else if (msg.method === "thread/start") proc.emitLine({ id: msg.id, result: { thread: { id: "thr" } } });
      else if (msg.method === "turn/start") {
        proc.emitLine({ id: msg.id, result: { turn: { id: "tu" } } });
        proc.emitLine({ method: "turn/started", params: { threadId: "thr", turn: { id: "tu" } } });
        proc.emitLine({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "thr", turnId: "tu", itemId: "ask-1", isBlocking: true, autoResolutionMs: null, ...params } });
      } else if (msg.method === "turn/interrupt") {
        proc.emitLine({ id: msg.id, result: {} });
        proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "interrupted", error: null } } });
      } else if (msg.id === 7 && !msg.method) {
        replies.push(msg.result ?? { error: msg.error });
        proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
      }
    }
  });
  return replies;
}
const questions = [
  { id: "q-env", header: "Environment", question: "Which environment?", isOther: false, isSecret: false, options: [{ label: "staging", description: "" }, { label: "production", description: "" }] },
  { id: "q-token", header: "Token", question: "Paste the deploy token", isOther: true, isSecret: true, options: null },
];

test("Codex: a native question is a card answered by its schema; the CLI gets the answers, the transcript never the secret", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question") as ThreadItem & { kind: "question" };
    assert.deepEqual(card.questions.map((q) => [q.id, q.secret, q.options?.map((o) => o.label) ?? null]), [["q-env", false, ["staging", "production"]], ["q-token", true, null]]);
    assert.equal(h.runner.status(h.thread.id), "waiting");
    for (const junk of [null, "staging", ["staging"]]) {
      const refused = h.runner.answerQuestion(h.thread.id, card.id, junk as unknown as Record<string, unknown>);
      assert.equal(!refused.ok && refused.reason, "invalid", JSON.stringify(junk));
    }
    const bad = h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["prod"], "q-token": ["s3cr3t"] });
    assert.equal(bad.ok, false);
    assert.equal(!bad.ok && bad.reason, "invalid");
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["staging"], "q-token": ["s3cr3t"] }), { ok: true });
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["production"], "q-token": ["x"] }), { ok: false, reason: "already-resolved" });
    await sent;
    assert.deepEqual(replies, [{ answers: { "q-env": { answers: ["staging"] }, "q-token": { answers: ["s3cr3t"] } } }]);
    const saved = new Store(h.home).items(h.thread.id).find((i) => i.kind === "question") as ThreadItem & { kind: "question"; answers?: Record<string, string[]> };
    assert.deepEqual(saved.answers, { "q-env": ["staging"], "q-token": ["(hidden)"] });
    assert.ok(!JSON.stringify([new Store(h.home).items(h.thread.id), h.events]).includes("s3cr3t"), "the secret is never stored or sent to a window");
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("Codex: Stop during a question withdraws it; the CLI is told it was withdrawn, not given an answer", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question")!;
    h.runner.stop(h.thread.id);
    await sent;
    assert.equal((h.runner.items(h.thread.id).find((i) => i.id === card.id) as { withdrawn?: string }).withdrawn, "stopped");
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["staging"], "q-token": ["x"] }), { ok: false, reason: "withdrawn" });
    assert.equal(replies.length, 1);
    assert.ok((replies[0] as { error?: unknown }).error, "a withdrawal is an error reply, never an empty answer");
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("cards a dead process left open are inert after a restart, in the snapshot and for every client", async () => {
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, runTurn: async () => ({ status: "completed" }) };
  const h = await harness(backend);
  const at = "2026-10-18T10:00:00.000Z";
  h.store.saveItems(h.thread.id, [
    { id: "u", kind: "user", text: "deploy", at },
    { id: "a", kind: "approval", question: "Allow Bash: $ deploy?", canAlways: false, at },
    { id: "q", kind: "question", questions: [{ id: "q1", header: "Env", text: "Which?", options: null, allowOther: true, secret: false }], blocking: true, at },
  ] as ThreadItem[]);
  await h.runner.dispose();
  const events: ThreadEvent[] = [];
  const fresh = new ThreadRunner({ home: h.home, store: new Store(h.home), emit: (e) => events.push(e), backends: { claude: backend } });
  const items = fresh.items(h.thread.id);
  assert.deepEqual(items.filter((i) => i.kind !== "user").map((i) => [i.id, (i as { answer?: string }).answer ?? null, (i as { withdrawn?: string }).withdrawn]), [["a", "no", "ended"], ["q", null, "ended"]]);
  assert.deepEqual(new Store(h.home).items(h.thread.id).filter((i) => i.kind !== "user").map((i) => (i as { withdrawn?: string }).withdrawn), ["ended", "ended"]);
  assert.ok(events.some((e) => e.type === "item_update" && e.id === "a"));
  assert.deepEqual(fresh.answer(h.thread.id, "a", "yes"), { ok: false, reason: "withdrawn" });
  await fresh.dispose();
});

test("Codex: a question Codex resolves itself (serverRequest/resolved) closes as withdrawn, and Modex sends no answer", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question")!;
    proc.emitLine({ method: "serverRequest/resolved", params: { threadId: "thr", requestId: 7 } });
    await waitFor(() => (h.runner.items(h.thread.id).find((i) => i.id === card.id) as { withdrawn?: string }).withdrawn === "native");
    assert.equal(h.runner.status(h.thread.id), "running", "nothing is left to wait on");
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["staging"], "q-token": ["x"] }), { ok: false, reason: "withdrawn" });
    proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
    await sent;
    assert.deepEqual(replies, [], "Codex already settled it");
  } finally { await h.runner.dispose(); await codex.dispose(); }
});
