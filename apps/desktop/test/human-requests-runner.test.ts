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
  const native = { runtime: "runtime", request: "request" };
  const heard: string[] = [];
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink: TurnSink) {
    const answer = await sink.approval({ question: "Allow Bash: $ npm test?", canAlways: true, native, action: { backend: "claude", tool: "Bash", title: "$ npm test", input: { command: "npm test" } } });
    await sink.deliverRequest!(native, async () => { heard.push(answer); });
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
function codexAsking(proc: FakeProcess, params: Record<string, unknown>, method = "item/tool/requestUserInput", finish = true) {
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
        proc.emitLine({ id: 7, method, params: { threadId: "thr", turnId: "tu", itemId: "ask-1", isBlocking: true, autoResolutionMs: null, ...params } });
      } else if (msg.method === "turn/interrupt") {
        proc.emitLine({ id: msg.id, result: {} });
        proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "interrupted", error: null } } });
      } else if (msg.id === 7 && !msg.method) {
        replies.push(msg.result ?? { error: msg.error });
        if (finish) setImmediate(() => proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } }));
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


test("Codex: withdrawal after local acceptance but before the native write leaves delivery uncertain", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question")!;
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["staging"], "q-token": ["s3cr3t"] }), { ok: true });
    // The promise resumes in a microtask. Native withdrawal can win before any response is written.
    proc.emitLine({ method: "serverRequest/resolved", params: { threadId: "thr", requestId: 7 } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(replies, [], "the CLI received no answer");
    const saved = h.runner.items(h.thread.id).find((i) => i.id === card.id) as ThreadItem & { delivery?: string };
    assert.equal(saved.delivery, "uncertain", "local acceptance must not be presented as confirmed delivery");
    proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
    await sent;
    assert.ok(!JSON.stringify([new Store(h.home).items(h.thread.id), h.events]).includes("s3cr3t"));
  } finally { await h.runner.dispose(); await codex.dispose(); }
});


test("Codex: Stop after local question acceptance prevents the answer write and records uncertainty", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question")!;
    h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["staging"], "q-token": ["secret"] });
    h.runner.stop(h.thread.id);
    await sent;
    assert.deepEqual(replies, [], "an accepted answer must not escape after Stop");
    assert.equal((h.runner.items(h.thread.id).find((i) => i.id === card.id) as { delivery?: string }).delivery, "uncertain");
  } finally { await h.runner.dispose(); await codex.dispose(); }
});


test("Codex: an account change between acceptance and delivery cannot send the old answer", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question")!;
    h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["staging"], "q-token": ["secret"] });
    h.store.updateThread(h.thread.id, { codexAccount: "replacement" });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(replies, []);
    assert.equal((h.runner.items(h.thread.id).find((i) => i.id === card.id) as { delivery?: string }).delivery, "uncertain");
    proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
    await sent;
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("Codex: a failed write stays uncertain and a second client cannot resend the answer", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question")!;
    const original = proc.stdin.write.bind(proc.stdin);
    let writes = 0;
    proc.stdin.write = ((chunk: string, callback: (error?: Error) => void) => {
      if (JSON.parse(chunk).id !== 7) return original(chunk);
      writes++;
      callback(new Error("transport failed"));
      return false;
    }) as typeof proc.stdin.write;
    h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["staging"], "q-token": ["failure-only-token"] });
    await waitFor(() => (h.runner.items(h.thread.id).find((i) => i.id === card.id) as { delivery?: string }).delivery === "uncertain");
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["production"], "q-token": ["failure-only-token"] }, "phone"), { ok: false, reason: "already-resolved" });
    assert.equal(writes, 1);
    assert.deepEqual(replies, []);
    proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
    await sent;
    assert.ok(!JSON.stringify([h.events, new Store(h.home).items(h.thread.id)]).includes("failure-only-token"));
  } finally { await h.runner.dispose(); await codex.dispose(); }
});


test("Codex: an approval records sent only after its response write completes", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc, { command: "npm test" }, "item/commandExecution/requestApproval", false);
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "test it");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "approval"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "approval")!;
    assert.deepEqual(h.runner.answer(h.thread.id, card.id, "yes"), { ok: true });
    assert.equal((h.runner.items(h.thread.id).find((i) => i.id === card.id) as { delivery?: string }).delivery, "sending");
    await waitFor(() => (h.runner.items(h.thread.id).find((i) => i.id === card.id) as { delivery?: string }).delivery === "sent");
    assert.deepEqual(replies, [{ decision: "accept" }]);
    proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
    await sent;
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("Claude: the native approval write settles its delivery receipt", async () => {
  const { ClaudeBackend } = await import("../src/main/engine/backends/claude.js");
  const proc = new FakeProcess();
  const claude = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const h = await harness(claude);
  try {
    const sent = h.runner.send(h.thread.id, "test it");
    await proc.waitFor(line => line.includes('"type":"user"'));
    proc.emitLine({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" }, tool_use_id: "tool1" } });
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "approval"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "approval")!;
    h.runner.answer(h.thread.id, card.id, "yes");
    await waitFor(() => (h.runner.items(h.thread.id).find((i) => i.id === card.id) as { delivery?: string }).delivery === "sent");
    assert.equal(proc.sent(m => m.type === "control_response" && m.response.request_id === "r1").length, 1);
    proc.close(0);
    await sent;
  } finally { proc.close(0); await h.runner.dispose(); await claude.dispose(); }
});

test("a changed backend cannot accept an old card", async () => {
  const proc = new FakeProcess();
  codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question")!;
    h.runner.updateThread(h.thread.id, { backend: "claude" });
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["staging"], "q-token": ["token"] }), { ok: false, reason: "wrong-identity" });
    proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
    await sent;
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("an accepted answer is immutable until the backend writes it", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "question")!;
    const answers = { "q-env": ["staging"], "q-token": ["token"] };
    h.runner.answerQuestion(h.thread.id, card.id, answers);
    answers["q-env"][0] = "production";
    await sent;
    assert.deepEqual(replies, [{ answers: { "q-env": { answers: ["staging"] }, "q-token": { answers: ["token"] } } }]);
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("a changed action cannot use the original approval card", async () => {
  const request = { question: "Allow Bash?", canAlways: true, action: { backend: "claude" as const, tool: "Bash", title: "test", input: { command: "npm test" } } };
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    await sink.approval(request);
    return { status: "completed" };
  } };
  const h = await harness(backend);
  try {
    const sent = h.runner.send(h.thread.id, "go");
    await waitFor(() => h.runner.items(h.thread.id).some((i) => i.kind === "approval"));
    const card = h.runner.items(h.thread.id).find((i) => i.kind === "approval")!;
    request.action.input.command = "deploy";
    assert.deepEqual(h.runner.answer(h.thread.id, card.id, "yes"), { ok: false, reason: "changed-action" });
    h.runner.stop(h.thread.id);
    await sent;
  } finally { h.runner.stop(h.thread.id); await h.runner.dispose(); }
});

test("a policy decision cannot write after the thread switches backend", async () => {
  let ready = false;
  let release!: () => void;
  let writes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const native = { runtime: "runtime", request: "request", item: "item" };
  const backend: Backend = { id: "codex", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    const answer = await sink.approval({ question: "Allow test?", canAlways: true, native, action: { backend: "codex", tool: "command", title: "test", input: { command: "npm test" } } });
    assert.equal(answer, "yes");
    ready = true;
    await held;
    await sink.deliverRequest!(native, async () => { writes++; });
    return { status: "completed" };
  } };
  const h = await harness(backend);
  try {
    h.runner.updateThread(h.thread.id, { approvals: "yolo" });
    const sent = h.runner.send(h.thread.id, "go");
    await waitFor(() => ready);
    h.runner.updateThread(h.thread.id, { backend: "claude" });
    release();
    await sent;
    assert.equal(writes, 0);
  } finally { release(); await h.runner.dispose(); }
});

test("Codex: replaying a native question retains one card and its original cancellation controller", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "go");
    await waitFor(() => h.runner.items(h.thread.id).some(i => i.kind === "question"));
    proc.emitLine({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "thr", turnId: "tu", itemId: "ask-1", isBlocking: true, autoResolutionMs: null, questions } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.runner.items(h.thread.id).filter(i => i.kind === "question").length, 1);
    proc.emitLine({ method: "serverRequest/resolved", params: { threadId: "thr", requestId: 7 } });
    await waitFor(() => (h.runner.items(h.thread.id).find(i => i.kind === "question") as { withdrawn?: string }).withdrawn === "native");
    assert.deepEqual(replies, []);
    proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
    await sent;
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("Codex: reusing a native question id for changed questions withdraws the original", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "go");
    await waitFor(() => h.runner.items(h.thread.id).some(i => i.kind === "question"));
    proc.emitLine({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "thr", turnId: "tu", itemId: "ask-1", isBlocking: true, autoResolutionMs: null, questions: [{ ...questions[0], question: "Changed action?" }] } });
    await new Promise<void>(resolve => setImmediate(resolve));
    const cards = h.runner.items(h.thread.id).filter(i => i.kind === "question");
    assert.equal(cards.length, 1);
    assert.equal((cards[0] as { withdrawn?: string }).withdrawn, "native");
    assert.deepEqual(replies, []);
    proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
    await sent;
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("Claude: a replayed permission request keeps one card; changed input withdraws it", async () => {
  const { ClaudeBackend } = await import("../src/main/engine/backends/claude.js");
  const proc = new FakeProcess();
  const claude = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const h = await harness(claude);
  try {
    const sent = h.runner.send(h.thread.id, "go");
    await proc.waitFor(line => line.includes('"type":"user"'));
    const request = { type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" }, tool_use_id: "tool1" } };
    proc.emitLine(request);
    await waitFor(() => h.runner.items(h.thread.id).some(i => i.kind === "approval"));
    proc.emitLine(request);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.runner.items(h.thread.id).filter(i => i.kind === "approval").length, 1);
    proc.emitLine({ ...request, request: { ...request.request, input: { command: "deploy" } } });
    await waitFor(() => (h.runner.items(h.thread.id).find(i => i.kind === "approval") as { withdrawn?: string }).withdrawn === "native");
    assert.equal(proc.sent(m => m.type === "control_response").length, 0);
    proc.close(0);
    await sent;
  } finally { proc.close(0); await h.runner.dispose(); await claude.dispose(); }
});

test("a policy approval reports uncertain when its transport write fails", async () => {
  const native = { runtime: "runtime", request: "request" };
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    const answer = await sink.approval({ question: "Allow test?", canAlways: true, native, action: { backend: "claude", tool: "Bash", title: "test", input: { command: "npm test" } } });
    assert.equal(answer, "yes");
    await sink.deliverRequest!(native, async () => { throw new Error("closed"); });
    return { status: "completed" };
  } };
  const h = await harness(backend);
  try {
    h.runner.updateThread(h.thread.id, { approvals: "yolo" });
    await h.runner.send(h.thread.id, "go");
    const card = h.runner.items(h.thread.id).find(i => i.kind === "approval") as { delivery?: string };
    assert.equal(card.delivery, "uncertain");
  } finally { await h.runner.dispose(); }
});

test("the offline backend acknowledges consuming its approval without leaving an uncertain card", async () => {
  const { MockBackend } = await import("../src/main/engine/backends/mock.js");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const home = tmpdir("modex-offline-delivery-");
  const script = path.join(home, "script.json");
  fs.writeFileSync(script, JSON.stringify({ steps: [{ tool_calls: [{ name: "apply_patch", arguments: { patch: "*** Begin Patch\n*** Add File: NOTE.md\n+hello\n*** End Patch" } }] }, { content: "Done" }] }));
  const backend = new MockBackend(() => script, home, 0);
  const h = await harness(backend);
  try {
    h.runner.updateThread(h.thread.id, { mode: "chat" });
    const sent = h.runner.send(h.thread.id, "go");
    await waitFor(() => h.runner.items(h.thread.id).some(i => i.kind === "approval"));
    const card = h.runner.items(h.thread.id).find(i => i.kind === "approval")!;
    h.runner.answer(h.thread.id, card.id, "no");
    await sent;
    assert.equal((h.runner.items(h.thread.id).find(i => i.id === card.id) as { delivery?: string }).delivery, "sent");
  } finally { await h.runner.dispose(); }
});

test("Codex: a Writable error during an answer becomes an uncertain receipt without an uncaught stream error", async () => {
  const proc = new FakeProcess();
  codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "go");
    await waitFor(() => h.runner.items(h.thread.id).some(i => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find(i => i.kind === "question")!;
    proc.stdin._write = (_chunk, _encoding, callback) => callback(new Error("pipe failed"));
    h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["staging"], "q-token": ["stream-error-token"] });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal((h.runner.items(h.thread.id).find(i => i.id === card.id) as { delivery?: string }).delivery, "uncertain");
    proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
    await sent;
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("Codex: stdin closing before the write callback leaves delivery uncertain", async () => {
  const proc = new FakeProcess();
  codexAsking(proc, { questions });
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  try {
    const sent = h.runner.send(h.thread.id, "go");
    await waitFor(() => h.runner.items(h.thread.id).some(i => i.kind === "question"));
    const card = h.runner.items(h.thread.id).find(i => i.kind === "question")!;
    proc.stdin.write = (() => false) as typeof proc.stdin.write;
    h.runner.answerQuestion(h.thread.id, card.id, { "q-env": ["staging"], "q-token": ["close-token"] });
    await new Promise<void>(resolve => setImmediate(resolve));
    proc.stdin.emit("close");
    await waitFor(() => (h.runner.items(h.thread.id).find(i => i.id === card.id) as { delivery?: string }).delivery === "uncertain");
    proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } });
    await sent;
  } finally { await h.runner.dispose(); await codex.dispose(); }
});

test("changing approval rules invalidates an already displayed approval", async () => {
  const native = { runtime: "runtime", request: "request" };
  let writes = 0;
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    await sink.approval({ question: "Allow deploy?", canAlways: true, native, action: { backend: "claude", tool: "Bash", title: "deploy", input: { command: "deploy" } } });
    await sink.deliverRequest!(native, async () => { writes++; });
    return { status: "completed" };
  } };
  const h = await harness(backend);
  try {
    const sent = h.runner.send(h.thread.id, "go");
    await waitFor(() => h.runner.items(h.thread.id).some(i => i.kind === "approval"));
    const card = h.runner.items(h.thread.id).find(i => i.kind === "approval")!;
    h.store.updateSettings({ approval_gate: { enabled: true, threshold: 0.8, timeout_ms: 1000 }, approval_rules: [{ id: "never", when: "deploy", decision: "never", match: "Bash: deploy", enabled: true }] });
    assert.deepEqual(h.runner.answer(h.thread.id, card.id, "yes"), { ok: false, reason: "changed-action" });
    await sent;
    assert.equal(writes, 0);
  } finally { h.runner.stop(h.thread.id); await h.runner.dispose(); }
});

test("revoking YOLO prevents its accepted automatic decision from being written", async () => {
  let ready = false;
  let release!: () => void;
  let writes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const native = { runtime: "runtime", request: "request", item: "item" };
  const backend: Backend = { id: "codex", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    const answer = await sink.approval({ question: "Allow test?", canAlways: true, native, action: { backend: "codex", tool: "command", title: "test", input: { command: "npm test" } } });
    assert.equal(answer, "yes");
    ready = true;
    await held;
    await sink.deliverRequest!(native, async () => { writes++; });
    return { status: "completed" };
  } };
  const h = await harness(backend);
  try {
    h.runner.updateThread(h.thread.id, { approvals: "yolo" });
    const sent = h.runner.send(h.thread.id, "go");
    await waitFor(() => ready);
    h.runner.updateThread(h.thread.id, { approvals: "ask" });
    release();
    await sent;
    assert.equal(writes, 0);
  } finally { release(); await h.runner.dispose(); }
});

test("a delivery is claimed before awaiting its write callback", async () => {
  const native = { runtime: "runtime", request: "request" };
  let writes = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    await sink.approval({ question: "Allow?", canAlways: true, native, action: { backend: "claude", tool: "Bash", title: "test", input: { command: "npm test" } } });
    const first = sink.deliverRequest!(native, async () => { writes++; await held; });
    await sink.deliverRequest!(native, async () => { writes++; });
    release();
    await first;
    return { status: "completed" };
  } };
  const h = await harness(backend);
  try {
    h.runner.updateThread(h.thread.id, { approvals: "yolo" });
    await h.runner.send(h.thread.id, "go");
    assert.equal(writes, 1);
  } finally { release(); await h.runner.dispose(); }
});

test("changing mode invalidates a queued automatic approval", async () => {
  let ready = false;
  let release!: () => void;
  let writes = 0;
  const held = new Promise<void>(resolve => { release = resolve; });
  const native = { runtime: "runtime", request: "request", item: "item" };
  const backend: Backend = { id: "codex", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    const answer = await sink.approval({ question: "Allow test?", canAlways: true, native, action: { backend: "codex", tool: "command", title: "test", input: { command: "npm test" } } });
    assert.equal(answer, "yes");
    ready = true;
    await held;
    await sink.deliverRequest!(native, async () => { writes++; });
    return { status: "completed" };
  } };
  const h = await harness(backend);
  try {
    h.runner.updateThread(h.thread.id, { approvals: "yolo", mode: "agent" });
    const sent = h.runner.send(h.thread.id, "go");
    await waitFor(() => ready);
    h.runner.updateThread(h.thread.id, { mode: "chat" });
    release();
    await sent;
    assert.equal(writes, 0);
  } finally { release(); await h.runner.dispose(); }
});

test("image execution override retains the admitted thread binding and confirms consumption", async () => {
  const home = tmpdir("modex-image-requests-");
  const store = new Store(home);
  let consumed = false;
  const native = { runtime: "offline-image", request: "approval" };
  const imageBackend: Backend = { id: "mock", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
    const answer = await sink.approval({ question: "Create offline image?", canAlways: false, native });
    if (answer === "no") return { status: "interrupted" };
    await sink.deliverRequest?.(native, async () => { consumed = true; });
    return { status: "completed" };
  } };
  const runner = new ThreadRunner({ home, store, emit: () => {}, imageBackend });
  const thread = await runner.createImageThread(gitRepo(), "image-job", "claude", "cli");
  const sent = runner.send(thread.id, "generate");
  try {
    await waitFor(() => runner.items(thread.id).some(i => i.kind === "approval"));
    const card = runner.items(thread.id).find(i => i.kind === "approval")!;
    assert.deepEqual(runner.answer(thread.id, card.id, "yes"), { ok: true });
    await sent;
    assert.equal(consumed, true);
    assert.equal((runner.items(thread.id).find(i => i.id === card.id) as Extract<ThreadItem, { kind: "approval" }>).delivery, "sent");
  } finally { await runner.dispose(); }
});

test("offline image denial is acknowledged without generating an image", async () => {
  const { imageFixtureBackend } = await import("../src/main/engine/images/fixture.js");
  const home = tmpdir("modex-image-denial-");
  const store = new Store(home);
  const runner = new ThreadRunner({ home, store, emit: () => {}, imageBackend: imageFixtureBackend });
  const thread = await runner.createImageThread(gitRepo(), "image-job", "claude", "cli");
  const sent = runner.send(thread.id, "generate");
  try {
    await waitFor(() => runner.items(thread.id).some(i => i.kind === "approval"));
    const card = runner.items(thread.id).find(i => i.kind === "approval")!;
    assert.deepEqual(runner.answer(thread.id, card.id, "no"), { ok: true });
    await sent;
    const result = runner.items(thread.id).find(i => i.id === card.id) as Extract<ThreadItem, { kind: "approval" }>;
    assert.deepEqual([result.answer, result.delivery], ["no", "sent"]);
    const fs = await import("node:fs");
    assert.equal(fs.readdirSync(thread.cwd).some(name => name.endsWith(".png")), false);
  } finally { await runner.dispose(); }
});
