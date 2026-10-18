import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { ClaudeBackend } from "../src/main/engine/backends/claude.js";
import type { Backend, TurnResult, TurnSink } from "../src/main/engine/backends/types.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { FakeProcess, fakeSpawn } from "./fakeproc.js";
import { gitRepo, tmpdir } from "./helpers.js";
import { CONVERSATION_SCHEMA, applyConversationEvent, finalAnswerIndex, itemFacts, parseConversationEvent, projectConversation, type AttemptMark, type ConversationEvent, type ConversationItem, type NativeRef, type Observation, type TurnRef } from "../src/shared/conversation-events.js";

// Sanitized captures from real CLI runs (see test/fixtures/conversation/README.md). Replaying them
// tests the adapters against bytes the CLIs really sent; it is not live-provider acceptance.
const FIXTURES = fileURLToPath(new URL("../../test/fixtures/conversation/", import.meta.url));
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8").split("\n").filter((l) => l.trim());
const CODEX_THREAD = "01a14da2-063a-77a3-9092-0e3543b84bd0";
const CLAUDE_SESSION = "852a2cd1-6453-4922-802d-193d60be6980";

/** What a test reads off a transcript item, typed loosely so it also reads items written before CF-1. */
type Loose = ThreadItem & Record<string, unknown>;
const conversation = (items: ThreadItem[]) => items.filter((i) => i.kind === "assistant" || i.kind === "thinking" || i.kind === "tool") as Loose[];
const origin = (item: Loose) => item.origin as { thread: string; turn: string; attempt: string; backend: string; native: { runtime: string; thread?: string; turn?: string; item: string; part?: string } } | undefined;

/** Writes `text` to the fake CLI's stdout in chunks of 1, 2, 3, 5 and 7 bytes, splitting UTF-8 sequences and JSON lines. */
async function trickle(proc: FakeProcess, text: string): Promise<void> {
  const bytes = Buffer.from(text, "utf8");
  const sizes = [1, 2, 3, 5, 7];
  for (let at = 0, n = 0; at < bytes.length; n++) {
    const size = sizes[n % sizes.length]!;
    proc.stdout.write(bytes.subarray(at, at + size));
    at += size;
    if (n % 16 === 0) await new Promise((r) => setImmediate(r));
  }
}

/**
 * Plays a captured app-server stream to CodexBackend. Setup requests are answered with the capture's
 * own thread and turn ids; each server request (an approval) waits for Modex's reply before the next line.
 */
function codexServer(proc: FakeProcess, lines: string[], opts: { split?: boolean; close?: number } = {}) {
  const turnId = (lines.map((l) => JSON.parse(l) as { method?: string; params?: { turn?: { id?: string } } }).find((m) => m.method === "turn/started")?.params?.turn?.id) ?? "turn-1";
  const threadId = (JSON.parse(lines[0]!) as { params?: { threadId?: string; thread?: { id?: string } } }).params;
  const tid = threadId?.threadId ?? threadId?.thread?.id ?? CODEX_THREAD;
  let played: Promise<void> | null = null;
  proc.stdin.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (msg.method === "initialize") proc.emitLine({ id: msg.id, result: { userAgent: "fixture/0.163.0" } });
      else if (msg.method === "thread/start" || msg.method === "thread/resume") proc.emitLine({ id: msg.id, result: { thread: { id: tid } } });
      else if (msg.method === "turn/start") {
        proc.emitLine({ id: msg.id, result: { turn: { id: turnId } } });
        played ??= (async () => {
          for (const raw of lines) {
            const m = JSON.parse(raw) as { id?: number; method?: string };
            if (opts.split) await trickle(proc, raw + "\n"); else proc.stdout.write(raw + "\n");
            if (m.id !== undefined && m.method) await proc.waitFor((l) => { const r = JSON.parse(l) as { id?: number; result?: unknown }; return r.id === m.id && r.result !== undefined; }, 5000);
          }
          if (opts.close !== undefined) proc.close(opts.close);
        })();
      }
    }
  });
}

/** Plays a captured `claude -p` stream. Each `control_request` waits for Modex's `control_response`. */
async function claudeStream(proc: FakeProcess, lines: string[], opts: { split?: boolean } = {}): Promise<void> {
  await proc.waitFor((l) => l.includes('"type":"user"'));
  for (const raw of lines) {
    const m = JSON.parse(raw) as { type: string; request_id?: string };
    if (opts.split) await trickle(proc, raw + "\n"); else proc.stdout.write(raw + "\n");
    if (m.type === "control_request") await proc.waitFor((l) => l.includes('"control_response"') && l.includes(m.request_id!), 5000);
  }
  proc.close(0);
}

/** A runner on a fresh store with the given backends, and a thread on `backend` whose approvals the test answers. */
async function harness(backends: Partial<Record<"claude" | "codex" | "mock", Backend>>, backend: "claude" | "codex" | "mock", answer: (question: string) => "yes" | "no" = () => "yes") {
  const home = tmpdir("modex-conversation-");
  const store = new Store(home);
  const events: ThreadEvent[] = [];
  let runner!: ThreadRunner;
  const emit = (e: ThreadEvent) => {
    events.push(e);
    if (e.type === "item" && e.item.kind === "approval" && !e.item.answer) {
      const { id, question } = e.item;
      setImmediate(() => runner.answer(e.threadId, id, answer(question)));
    }
  };
  runner = new ThreadRunner({ home, store, emit, backends });
  const project = store.addProject(gitRepo());
  const thread = await runner.createThread(project.id, { backend, auto: false });
  // A manual title: naming would start a second CLI conversation on the same fake process.
  store.updateThread(thread.id, { title: "Fixture", titleSource: "manual" });
  return { home, store, runner, thread, events };
}

async function codexTurn(lines: string[], opts: { split?: boolean; close?: number } = {}) {
  const proc = new FakeProcess();
  codexServer(proc, lines, opts);
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness({ codex }, "codex", (q) => (q.includes("echo") ? "yes" : "no"));
  try {
    await h.runner.send(h.thread.id, "go");
    return { ...h, items: h.runner.items(h.thread.id), saved: new Store(h.home).items(h.thread.id) };
  } finally { await codex.dispose(); }
}

async function claudeTurn(lines: string[], opts: { split?: boolean } = {}) {
  const proc = new FakeProcess();
  const claude = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const h = await harness({ claude }, "claude", (q) => (q.includes("echo") ? "yes" : "no"));
  const played = claudeStream(proc, lines, opts);
  await h.runner.send(h.thread.id, "go");
  await played;
  return { ...h, items: h.runner.items(h.thread.id), saved: new Store(h.home).items(h.thread.id) };
}

/** Items with the fields that differ between two runs (fresh ids, times, attempts and runtimes) removed. */
function comparable(items: ThreadItem[]) {
  return conversation(items).map((item) => {
    const { id: _id, at: _at, durationMs: _d, origin: o, ...rest } = item as Loose & { durationMs?: number };
    const native = (o as { native?: Record<string, unknown> } | undefined)?.native;
    return { ...rest, native: native ? { ...native, runtime: undefined } : undefined };
  });
}

test("Codex: interleaved commentary, tools and a final answer keep separate text, phase, native identity and outcome", async () => {
  const run = await codexTurn(fixture("codex-0.163.0-interleave.jsonl"));
  const items = conversation(run.items);
  assert.deepEqual(items.map((i) => i.kind), ["assistant", "tool", "assistant", "tool", "assistant"]);
  const messages = items.filter((i) => i.kind === "assistant");
  assert.deepEqual(messages.map((i) => i.text), ["Checking one — café ✓.\n", "Checking two.\n", "Done ha ha ha."]);
  assert.deepEqual(messages.map((i) => i.phase), ["commentary", "commentary", "final"]);
  assert.deepEqual(messages.map((i) => i.outcome), ["succeeded", "succeeded", "succeeded"]);
  const tools = items.filter((i) => i.kind === "tool");
  assert.deepEqual(tools.map((i) => [i.title, i.outcome, i.ok]), [["$ echo one", "succeeded", true], ["$ touch denied.txt", "denied", false]]);
  const user = run.items.find((i) => i.kind === "user")!;
  for (const item of items) {
    const o = origin(item);
    assert.ok(o, `${item.kind} ${item.id} carries its origin`);
    assert.equal(o.thread, run.thread.id);
    assert.equal(o.turn, user.id, "the Modex turn is the user message it answers");
    assert.equal(o.backend, "codex");
    assert.equal(o.native.thread, CODEX_THREAD);
    assert.equal(o.native.turn, "01a14da2-0a5f-74e2-9378-527679121b7d");
    assert.ok(o.native.runtime, "a runtime generation scopes the native ids");
  }
  assert.equal(new Set(items.map((i) => origin(i)!.attempt)).size, 1, "one attempt");
  // Three messages, three native ids: they share a long prefix, so only whole ids tell them apart.
  assert.deepEqual(messages.map((i) => origin(i)!.native.item), [
    "msg_0408cf99458c7974016ad462d9003c8190968751d7feab8c30",
    "msg_0408cf99458c7974016ad462dbeb2c8190a4fbda9861915353",
    "msg_0408cf99458c7974016ad462ddd7a081909c104c1bfb9df34c",
  ]);
  assert.deepEqual(comparable(run.saved), comparable(run.items), "what was saved is what was shown");
});

test("Claude: thinking without text stays unavailable, blocks keep message/part identity, a denied tool is denied", async () => {
  const run = await claudeTurn(fixture("claude-2.1.302-haiku-interleave.jsonl"));
  const items = conversation(run.items);
  assert.deepEqual(items.map((i) => i.kind), ["thinking", "assistant", "tool", "assistant", "tool", "assistant"]);
  const [thinking] = items;
  assert.equal(thinking!.text, "");
  assert.equal(thinking!.reasoning, "unavailable");
  assert.equal(thinking!.status, "done");
  const messages = items.filter((i) => i.kind === "assistant");
  assert.deepEqual(messages.map((i) => i.text), ["Checking one — café ✓.", "Writing the second sentence, then running the third command.\n\nChecking two.", "Done ha ha ha."]);
  assert.deepEqual(messages.map((i) => i.phase), ["unspecified", "unspecified", "unspecified"], "Claude reports no phase; Modex does not guess one");
  assert.deepEqual(messages.map((i) => [origin(i)!.native.item, origin(i)!.native.part]), [["msg_011Cg9CnAZPTjysJ2oB2vU63", "1"], ["msg_011Cg9CnV7b5FGaS61j6GRFe", "0"], ["msg_011Cg9Cnbd1TNJE6ctRwXsp6", "0"]]);
  assert.ok(messages.every((i) => origin(i)!.native.thread === CLAUDE_SESSION));
  const tools = items.filter((i) => i.kind === "tool");
  assert.deepEqual(tools.map((i) => [i.title, i.outcome, i.ok]), [["$ echo one", "succeeded", true], ["$ touch denied.txt", "denied", false]]);
  assert.ok(!JSON.stringify(run.saved).includes("OPAQUE-SIGNATURE-REMOVED"), "the opaque thinking signature is never stored");
  assert.ok(!JSON.stringify(run.events).includes("OPAQUE-SIGNATURE-REMOVED"), "nor sent to the window");
});

test("split UTF-8 sequences and split JSON lines project exactly as the unsplit stream (Codex and Claude)", async () => {
  const codexWhole = await codexTurn(fixture("codex-0.163.0-interleave.jsonl"));
  const codexSplit = await codexTurn(fixture("codex-0.163.0-interleave.jsonl"), { split: true });
  assert.deepEqual(comparable(codexSplit.items), comparable(codexWhole.items));
  assert.ok(conversation(codexSplit.items).some((i) => i.text === "Checking one — café ✓.\n"));
  const claudeWhole = await claudeTurn(fixture("claude-2.1.302-haiku-interleave.jsonl"));
  const claudeSplit = await claudeTurn(fixture("claude-2.1.302-haiku-interleave.jsonl"), { split: true });
  assert.deepEqual(comparable(claudeSplit.items), comparable(claudeWhole.items));
  assert.ok(conversation(claudeSplit.items).some((i) => i.text === "Checking one — café ✓."));
});

test("repeated tokens are kept: three identical ' ha' deltas make 'ha ha ha'", async () => {
  const run = await codexTurn(fixture("codex-0.163.0-interleave.jsonl"));
  assert.equal(conversation(run.items).at(-1)!.text, "Done ha ha ha.");
});

test("Codex: a reasoning summary is a summary; reasoning with neither summary nor text is unavailable", async () => {
  const summary = conversation((await codexTurn(fixture("codex-0.163.0-reasoning.jsonl"))).items);
  assert.deepEqual(summary.map((i) => [i.kind, i.reasoning ?? i.phase, i.text]), [["thinking", "summary", "**Need only .05**"], ["assistant", "final", "$0.05"]]);
  const interrupted = conversation((await codexTurn(fixture("codex-0.163.0-interrupt.jsonl"))).items);
  assert.equal(interrupted[0]!.kind, "thinking");
  assert.equal(interrupted[0]!.reasoning, "unavailable");
  assert.equal(interrupted[0]!.text, "");
});

test("Codex: summary parts never absorb reasoning text; each representation is its own item", async () => {
  const t = (method: string, params: Record<string, unknown>) => JSON.stringify({ method, params: { threadId: "thr", turnId: "tu", ...params } });
  const lines = [
    JSON.stringify({ method: "turn/started", params: { threadId: "thr", turn: { id: "tu" } } }),
    t("item/started", { item: { type: "reasoning", id: "r1", summary: [], content: [] } }),
    t("item/reasoning/summaryPartAdded", { itemId: "r1", summaryIndex: 0 }),
    t("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "Plan A.", summaryIndex: 0 }),
    t("item/reasoning/textDelta", { itemId: "r1", delta: "raw step 1", contentIndex: 0 }),
    t("item/reasoning/summaryPartAdded", { itemId: "r1", summaryIndex: 1 }),
    t("item/reasoning/summaryTextDelta", { itemId: "r1", delta: "Plan B.", summaryIndex: 1 }),
    t("item/reasoning/textDelta", { itemId: "r1", delta: " raw step 2", contentIndex: 0 }),
    t("item/completed", { item: { type: "reasoning", id: "r1", summary: ["Plan A.", "Plan B."], content: ["raw step 1 raw step 2"] } }),
    t("item/started", { item: { type: "agentMessage", id: "m1", text: "", phase: null } }),
    t("item/agentMessage/delta", { itemId: "m1", delta: "ok" }),
    t("item/completed", { item: { type: "agentMessage", id: "m1", text: "ok", phase: null } }),
    JSON.stringify({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } }),
  ];
  const items = conversation((await codexTurn(lines)).items);
  assert.deepEqual(items.map((i) => [i.kind, i.reasoning ?? i.phase, i.text]), [
    ["thinking", "summary", "Plan A.\n\nPlan B."],
    ["thinking", "provider-text", "raw step 1 raw step 2"],
    ["assistant", "unspecified", "ok"],
  ]);
});

test("Codex: an interrupted turn leaves its open message interrupted, not completed", async () => {
  const run = await codexTurn(fixture("codex-0.163.0-interrupt.jsonl"));
  const message = conversation(run.items).find((i) => i.kind === "assistant")!;
  assert.equal(message.text, "Tidal pools are small seawater worlds");
  assert.equal(message.phase, "final");
  assert.equal(message.outcome, "interrupted");
  assert.ok(run.items.some((i) => i.kind === "notice" && i.text === "Stopped."));
});

test("Codex: idle status alone ends nothing; a dropped connection leaves open work unknown, never succeeded", async () => {
  const t = (method: string, params: Record<string, unknown>) => JSON.stringify({ method, params: { threadId: "thr", turnId: "tu", ...params } });
  const lines = [
    JSON.stringify({ method: "turn/started", params: { threadId: "thr", turn: { id: "tu" } } }),
    t("item/started", { item: { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'npm test'", cwd: "/p", status: "inProgress" } }),
    t("item/started", { item: { type: "agentMessage", id: "m1", text: "", phase: "commentary" } }),
    t("item/agentMessage/delta", { itemId: "m1", delta: "Running the tests" }),
    JSON.stringify({ method: "thread/status/changed", params: { threadId: "thr", status: { type: "idle" } } }),
  ];
  const run = await codexTurn(lines, { close: 1 });
  const [tool, message] = conversation(run.items);
  assert.equal(tool!.kind, "tool");
  assert.equal(tool!.outcome, "unknown");
  assert.notEqual(tool!.ok, true);
  assert.equal(message!.text, "Running the tests");
  assert.equal(message!.outcome, "unknown");
  assert.ok(run.items.some((i) => i.kind === "notice" && i.failure), "the turn failed");
});

/** A backend that keeps every sink it was given, so a test can write to an old attempt's sink late. */
function keepingBackend(steps: ((sink: TurnSink) => Promise<TurnResult>)[], sinks: TurnSink[]): Backend {
  return {
    id: "claude", listModels: async () => [], dispose: async () => {},
    async runTurn(_text, _opts, sink) { sinks.push(sink); return steps.shift()!(sink); },
  };
}

/** Streams `text` as one message through whichever sink API the build under test has. */
function say(sink: TurnSink, text: string, item = "m"): void {
  const s = sink as unknown as { observe?: (o: unknown) => void; delta?: (t: string) => void };
  if (s.observe) s.observe({ type: "message.delta", native: { runtime: "test", item }, text });
  else s.delta!(text);
}

test("a late delta from a superseded attempt never changes the attempt that replaced it", async () => {
  const REFUSAL = "You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
  const sinks: TurnSink[] = [];
  let release!: () => void;
  const second = new Promise<void>((resolve) => { release = resolve; });
  const backend = keepingBackend([
    async () => ({ status: "failed", error: REFUSAL }),
    async (sink) => {
      say(sink, "fresh answer", "m2");
      say(sinks[0]!, " STALE FROM ATTEMPT ONE", "m2");
      await second;
      return { status: "completed" };
    },
  ], sinks);
  const h = await harness({ claude: backend }, "claude");
  h.store.updateThread(h.thread.id, { model: "fable" });
  const sent = h.runner.send(h.thread.id, "go");
  while (sinks.length < 2) await new Promise((r) => setTimeout(r, 5));
  release();
  await sent;
  const texts = conversation(h.runner.items(h.thread.id)).map((i) => i.text);
  assert.deepEqual(texts, ["fresh answer"]);
  assert.ok(!JSON.stringify(h.runner.items(h.thread.id)).includes("STALE"));
});

// ── The pure projector ──────────────────────────────────────────────────────────────────────────

const turnRef = (over: Partial<TurnRef> = {}): TurnRef => ({ thread: "T", turn: "U", attempt: "A1", backend: "codex", ...over });

/** Builds stamped events the way the runner does: ids and order assigned at ingress unless given. */
function stream(turn: TurnRef = turnRef()) {
  let seq = 0;
  const at = (n: number) => new Date(Date.UTC(2026, 9, 18, 6, 0, n)).toISOString();
  return (body: Observation | AttemptMark, id?: string): ConversationEvent => {
    seq++;
    return { schema: CONVERSATION_SCHEMA, id: id ?? `${turn.attempt}:${seq}`, seq, at: at(seq), turn, ...body } as ConversationEvent;
  };
}
const native = (item: string, over: Partial<NativeRef> = {}): NativeRef => ({ runtime: "R1", thread: "nt", turn: "nu", item, ...over });
/** An item's text, or a tool's title. */
const body = (item: ConversationItem) => (item.kind === "tool" ? item.title : item.text);

test("projector: two messages interleaved with two tools keep their own text and phase; completion snapshots replace, never duplicate", () => {
  const e = stream();
  const events = [
    e({ type: "attempt.start" }),
    e({ type: "message.start", native: native("m1"), phase: "commentary", nativePhase: "commentary" }),
    e({ type: "message.delta", native: native("m1"), text: "Looking" }),
    e({ type: "tool.start", native: native("t1"), tool: { name: "shell", title: "$ ls", args: {} } }),
    e({ type: "message.start", native: native("m2"), phase: "final", nativePhase: "final_answer" }),
    e({ type: "message.delta", native: native("m2"), text: "All" }),
    e({ type: "message.delta", native: native("m1"), text: " around." }),
    e({ type: "tool.start", native: native("t2"), tool: { name: "shell", title: "$ npm test", args: {} } }),
    e({ type: "tool.done", native: native("t1"), outcome: "succeeded", progress: { output: "a.ts" } }),
    e({ type: "message.done", native: native("m1"), text: "Looking around." }),
    e({ type: "message.delta", native: native("m2"), text: " good." }),
    e({ type: "message.done", native: native("m2") }),
    e({ type: "tool.done", native: native("t2"), outcome: "failed", progress: { output: "1 failing" } }),
    e({ type: "attempt.end", outcome: "succeeded" }),
  ];
  const state = projectConversation(events);
  assert.deepEqual(state.items.map((i) => [i.kind, body(i), i.kind === "assistant" ? i.phase : i.outcome]), [
    ["assistant", "Looking around.", "commentary"],
    ["tool", "$ ls", "succeeded"],
    ["assistant", "All good.", "final"],
    ["tool", "$ npm test", "failed"],
  ]);
  assert.deepEqual(state.items.map((i) => i.outcome), ["succeeded", "succeeded", "succeeded", "failed"]);
  assert.deepEqual(state.items.map((i) => i.kind === "tool" ? i.ok : null), [null, true, null, false]);
  assert.equal(state.attempts.U!.outcome, "succeeded");
});

test("projector: a reused native item id stays separate across threads, accounts and runtime generations", () => {
  const events: ConversationEvent[] = [];
  for (const [label, turn, runtime] of [
    ["thread A", turnRef({ thread: "TA", turn: "UA", attempt: "AA" }), "R1"],
    ["thread B", turnRef({ thread: "TB", turn: "UB", attempt: "AB" }), "R1"],
    ["account cli", turnRef({ thread: "TC", turn: "UC", attempt: "AC", account: "cli" }), "R2"],
    ["account chatgpt", turnRef({ thread: "TC", turn: "UC2", attempt: "AC2", account: "acct-2" }), "R2"],
  ] as const) {
    const e = stream(turn);
    events.push(e({ type: "attempt.start" }), e({ type: "message.delta", native: native("msg_same", { runtime }), text: label }));
  }
  // One attempt whose runtime restarted mid-turn (Codex reconnects after a stale sign-in): same ids, new generation.
  const e = stream(turnRef({ thread: "TD", turn: "UD", attempt: "AD" }));
  events.push(e({ type: "attempt.start" }), e({ type: "message.delta", native: native("msg_same", { runtime: "gen-1" }), text: "first server" }), e({ type: "message.delta", native: native("msg_same", { runtime: "gen-2" }), text: "second server" }));
  const state = projectConversation(events);
  assert.deepEqual(state.items.map((i) => body(i)), ["thread A", "thread B", "account cli", "account chatgpt", "first server", "second server"]);
  assert.equal(new Set(state.items.map((i) => i.id)).size, 6);
});

test("projector: deltas from a superseded or ended attempt never mutate the turn", () => {
  const one = stream(turnRef({ attempt: "A1" }));
  const two = stream(turnRef({ attempt: "A2" }));
  const events = [
    one({ type: "attempt.start" }),
    one({ type: "message.delta", native: native("m"), text: "draft" }),
    one({ type: "attempt.end", outcome: "failed" }),
    one({ type: "message.delta", native: native("m"), text: " after the end" }),
    two({ type: "attempt.start" }),
    two({ type: "message.delta", native: native("m"), text: "retry" }),
    one({ type: "message.delta", native: native("m"), text: " late" }),
    one({ type: "tool.start", native: native("t"), tool: { name: "shell", title: "$ rm -rf", args: {} } }),
    two({ type: "message.done", native: native("m"), text: "retry answer" }),
  ];
  const state = projectConversation(events);
  assert.deepEqual(state.items.map((i) => [i.origin.attempt, body(i), i.outcome]), [["A1", "draft", "unknown"], ["A2", "retry answer", "succeeded"]]);
  assert.equal(state.attempts.U!.attempt, "A2");
});

test("projector: summaries and provider text never mix; reasoning with no text stays unavailable", () => {
  const e = stream();
  const r = native("r1");
  const state = projectConversation([
    e({ type: "attempt.start" }),
    e({ type: "reasoning.start", native: r }),
    e({ type: "reasoning.delta", native: r, representation: "summary", index: 1, text: "Then edit." }),
    e({ type: "reasoning.delta", native: r, representation: "provider-text", index: 0, text: "private-looking raw text" }),
    e({ type: "reasoning.delta", native: r, representation: "summary", index: 0, text: "Look first." }),
    e({ type: "reasoning.done", native: r }),
    e({ type: "reasoning.start", native: native("r2") }),
    e({ type: "reasoning.done", native: native("r2") }),
  ]);
  assert.deepEqual(state.items.map((i) => [i.kind, i.kind === "thinking" ? i.reasoning : null, body(i), i.kind === "thinking" ? i.status : null]), [
    ["thinking", "summary", "Look first.\n\nThen edit.", "done"],
    ["thinking", "provider-text", "private-looking raw text", "done"],
    ["thinking", "unavailable", "", "done"],
  ]);
  // A completion snapshot replaces what streamed, per representation.
  const snap = projectConversation([e({ type: "attempt.start" }), e({ type: "reasoning.start", native: native("r3") }), e({ type: "reasoning.delta", native: native("r3"), representation: "summary", index: 0, text: "Lo" }), e({ type: "reasoning.done", native: native("r3"), summary: ["Look first."], text: [] })]);
  assert.deepEqual(snap.items.map((i) => [i.kind === "thinking" && i.reasoning, body(i)]), [["summary", "Look first."]]);
});

test("projector: replay is deterministic, duplicates of an event apply once, and identical adjacent deltas are both kept", () => {
  const e = stream();
  const events = [
    e({ type: "attempt.start" }),
    e({ type: "message.start", native: native("m"), phase: "final" }),
    e({ type: "message.delta", native: native("m"), text: "ha" }),
    e({ type: "message.delta", native: native("m"), text: "ha" }),
    e({ type: "message.delta", native: native("m"), text: "ha" }),
    e({ type: "tool.start", native: native("t"), tool: { name: "shell", title: "$ ls", args: {} } }),
    e({ type: "tool.update", native: native("t"), progress: { output: "a" } }),
    e({ type: "tool.done", native: native("t"), outcome: "succeeded" }),
    e({ type: "attempt.end", outcome: "succeeded" }),
  ];
  const once = projectConversation(events);
  assert.equal(body(once.items[0]!), "hahaha", "three different events with the same text are three tokens");
  assert.deepEqual(projectConversation(events), once, "replaying the same events gives the same view");
  const doubled = events.flatMap((event) => [event, structuredClone(event)]);
  assert.deepEqual(projectConversation(doubled), once, "a duplicate of an identified event changes nothing");
  assert.equal(applyConversationEvent(once, events[3]!), once, "re-applying an applied event returns the same state");
  const roundTrip = JSON.parse(JSON.stringify(events)) as ConversationEvent[];
  assert.deepEqual(projectConversation(roundTrip), once, "events survive JSON");
  assert.deepEqual(JSON.parse(JSON.stringify(once)), once, "state survives JSON");
});

test("projector: failed, denied, interrupted and unknown stay distinct from success; ending the attempt settles open work", () => {
  const e = stream();
  const tool = (id: string) => e({ type: "tool.start", native: native(id), tool: { name: "shell", title: id, args: {} } });
  const state = projectConversation([
    e({ type: "attempt.start" }),
    tool("ok"), tool("failed"), tool("denied"), tool("unknown"), tool("open"),
    e({ type: "message.delta", native: native("m"), text: "partial" }),
    e({ type: "reasoning.start", native: native("r") }),
    e({ type: "tool.done", native: native("ok"), outcome: "succeeded" }),
    e({ type: "tool.done", native: native("failed"), outcome: "failed" }),
    e({ type: "tool.done", native: native("denied"), outcome: "denied" }),
    e({ type: "tool.done", native: native("unknown"), outcome: "unknown" }),
    e({ type: "attempt.end", outcome: "interrupted" }),
    e({ type: "tool.done", native: native("open"), outcome: "succeeded" }),
  ]);
  assert.deepEqual(state.items.map((i) => [i.kind === "tool" ? i.title : i.kind, i.outcome, i.kind === "tool" ? i.ok : undefined]), [
    ["ok", "succeeded", true], ["failed", "failed", false], ["denied", "denied", false], ["unknown", "unknown", undefined],
    ["open", "interrupted", undefined], ["assistant", "interrupted", undefined], ["thinking", "interrupted", undefined],
  ]);
  assert.ok(state.items.every((i) => i.kind !== "tool" || i.status === "done"));
  const dropped = projectConversation([e({ type: "attempt.start" }), tool("still running"), e({ type: "attempt.end", outcome: "failed" })]);
  assert.equal(dropped.items.at(-1)!.outcome, "unknown", "a failed turn says nothing about the work it left open");
});

test("projector: an empty message start shows nothing until text arrives; an empty completion adds nothing", () => {
  const e = stream();
  const state = projectConversation([
    e({ type: "attempt.start" }),
    e({ type: "message.start", native: native("m1"), phase: "final" }),
    e({ type: "message.done", native: native("m1"), text: "" }),
    e({ type: "message.done", native: native("m2"), text: "Completed without deltas." }),
  ]);
  assert.deepEqual(state.items.map((i) => body(i)), ["Completed without deltas."]);
});

test("events validate before a client trusts them", () => {
  const e = stream();
  const good = e({ type: "message.delta", native: native("m"), text: "hi" });
  assert.deepEqual(parseConversationEvent(JSON.parse(JSON.stringify(good))), good);
  for (const bad of [
    { ...good, schema: 2 }, { ...good, id: "" }, { ...good, type: "message.exploded" }, { ...good, native: { item: "m" } },
    { ...good, text: 3 }, { ...good, turn: { ...good.turn, attempt: undefined } }, { ...good, type: "tool.done", outcome: "maybe" }, null, "x",
  ]) assert.equal(parseConversationEvent(bad), null, JSON.stringify(bad));
});

test("legacy items read through the explicit adapter: text kept, identity and phase unknown, success only where it was recorded", () => {
  const at = "2026-10-01T00:00:00.000Z";
  const legacy: ThreadItem[] = [
    { id: "u", kind: "user", text: "hi", at },
    { id: "a1", kind: "assistant", text: "Let me look.", at },
    { id: "t1", kind: "tool", name: "shell", title: "$ ls", args: {}, status: "done", ok: true, at },
    { id: "t2", kind: "tool", name: "shell", title: "$ rm", args: {}, status: "done", ok: false, at },
    { id: "t3", kind: "tool", name: "shell", title: "$ sleep", args: {}, status: "running", at },
    { id: "r", kind: "thinking", text: "Thought.", status: "done", at },
    { id: "a2", kind: "assistant", text: "Done.", at },
  ];
  assert.deepEqual(legacy.slice(1).map((i) => itemFacts(i)), [
    { observed: false, phase: "unspecified", outcome: "unknown" },
    { observed: false, phase: "unspecified", outcome: "succeeded" },
    { observed: false, phase: "unspecified", outcome: "unknown" },
    { observed: false, phase: "unspecified", outcome: "unknown" },
    { observed: false, phase: "unspecified", outcome: "unknown" },
    { observed: false, phase: "unspecified", outcome: "unknown" },
  ]);
  assert.equal(finalAnswerIndex(legacy.slice(1)), 5, "legacy turns keep the last-reply heuristic");
  const typed = [{ ...legacy[1]!, phase: "final" }, { ...legacy[6]!, phase: "commentary" }] as ThreadItem[];
  assert.equal(finalAnswerIndex(typed), 0, "a typed final answer wins over a later commentary");
});

test("legacy history loads unchanged, starts no turn, and a stale running CF-1 item becomes unknown", async () => {
  let ran = 0;
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, runTurn: async () => { ran++; return { status: "completed" }; } };
  const h = await harness({ claude: backend }, "claude");
  const at = "2026-10-01T00:00:00.000Z";
  const legacy: ThreadItem[] = [
    { id: "u", kind: "user", text: "hi", at },
    { id: "a1", kind: "assistant", text: "Hello — café ✓", at },
    { id: "t1", kind: "tool", name: "shell", title: "$ ls", args: {}, status: "done", ok: true, at },
  ];
  const origin = { thread: h.thread.id, turn: "u2", attempt: "x", backend: "claude" as const, native: { runtime: "dead", item: "toolu" } };
  const stale = { id: "t2", kind: "tool", name: "Bash", title: "$ sleep 60", args: {}, status: "running", at, outcome: "running", origin } as ThreadItem;
  h.store.saveItems(h.thread.id, [...legacy, stale]);
  const fresh = new ThreadRunner({ home: h.home, store: new Store(h.home), emit: () => {}, backends: { claude: backend } });
  const items = fresh.items(h.thread.id);
  assert.deepEqual(items.slice(0, 3), legacy, "legacy items are returned exactly as stored");
  assert.ok(items.slice(0, 3).every((i) => !("origin" in i)), "no provenance is invented for them");
  assert.deepEqual([items[3]!.kind === "tool" && items[3]!.status, (items[3] as Loose).outcome, items[3]!.kind === "tool" && items[3]!.ok], ["done", "unknown", undefined]);
  assert.equal(ran, 0, "loading history runs nothing");
});
