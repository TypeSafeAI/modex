import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCommands, type RegisterCommand } from "../src/main/commands.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { TerminalManager } from "../src/main/engine/terminal.js";
import { gitRepo, tmpdir } from "./helpers.js";
import { stateFor } from "../src/main/engine/routing/judge.js";
import type { ContextDraftBinding, TaskContextEvidence } from "../src/shared/task-context-evidence.js";

test("shared main commands select exact project context and refuse a closed binding without starting a turn", async t => {
  const home = tmpdir("modex-context-commands-"), store = new Store(home), project = store.addProject(gitRepo());
  const runner = new ThreadRunner({ home, store, emit: () => {} });
  const terminals = new TerminalManager(id => store.thread(id)!.cwd, () => {});
  t.after(async () => { await runner.dispose(); await terminals.dispose(); });
  const handlers = new Map<string, (req: any) => any>();
  registerCommands(((channel, handler) => handlers.set(channel, handler)) as RegisterCommand, { store, runner, terminals, emit: () => {}, pickDirectory: async () => null, openPath: async () => {}, openTerminal: async () => {} });
  const invoke = async (channel: string, req: unknown) => { const handler = handlers.get(channel); if (!handler) throw new Error(`Context command unavailable: ${channel}`); return handler(req); };
  const binding = await invoke("task:context-draft-open", { owner: { kind: "project", projectId: project.id, key: `draft:0:${project.id}` } }) as ContextDraftBinding;
  const selected = await invoke("task:context-draft-select", { binding, targets: [{ kind: "file", path: "README.md" }] }) as { binding: ContextDraftBinding; context: TaskContextEvidence };
  assert.equal(selected.context.refs[0]!.target.kind, "file");
  assert.equal(selected.context.captures[0]!.revision.state, "available");
  await invoke("task:context-draft-close", { binding: selected.binding });
  await assert.rejects(invoke("task:context-draft-select", { binding: selected.binding, targets: [] }), /draft|stale/);
  assert.equal(store.snapshot().threads.length, 0, "selecting context cannot create a thread or start a CLI turn");
});

for (const kind of ["project", "thread"] as const) test(`${kind} removal revokes a pending context capture before its OS read completes`, async t => {
  const { TaskContextCapture } = await import("../src/main/engine/task-context-capture.js");
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(r => { entered = r; }), held = new Promise<void>(r => { release = r; });
  t.mock.method(TaskContextCapture.prototype, "captureSelection", async (_cwd: unknown, _targets: unknown, _source: unknown, _notes: unknown, _phase: unknown, signal: AbortSignal) => {
    entered(); await Promise.race([held, new Promise<void>(r => { if (signal.aborted) r(); else signal.addEventListener("abort", () => r(), { once: true }); })]); return [];
  });
  const home = tmpdir("modex-context-removal-"), store = new Store(home), project = store.addProject(gitRepo());
  const runner = new ThreadRunner({ home, store, emit: () => {} }); t.after(() => runner.dispose());
  const thread = kind === "thread" ? await runner.createThread(project.id, { backend: "mock", auto: false }) : undefined;
  const binding = runner.openContextDraft(thread ? { kind: "thread", threadId: thread.id } : { kind: "project", projectId: project.id, key: `draft:0:${project.id}` });
  let outcome = "pending";
  const pending = runner.selectTaskContext(binding, [{ kind: "file", path: "README.md" }]).then(() => { outcome = "accepted"; }, () => { outcome = "rejected"; });
  try {
    await started; await (thread ? runner.deleteThread(thread.id) : runner.removeProject(project.id)); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(outcome, "rejected", "removal revokes the capture instead of waiting for unrelated OS work");
  } finally { release(); await pending; }
});

function admittedApp(t: { after(fn: () => Promise<void>): void }) {
  const home = tmpdir("modex-context-admitted-"), store = new Store(home), project = store.addProject(gitRepo());
  let turns = 0; const inputs: string[] = [];
  const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { mock: { id: "mock", runTurn: async text => { turns++; inputs.push(text); return { status: "completed" }; }, listModels: async () => [], dispose: async () => {} } } });
  const terminals = new TerminalManager(id => store.thread(id)!.cwd, () => {});
  t.after(async () => { await runner.dispose(); await terminals.dispose(); });
  const handlers = new Map<string, (req: any) => any>();
  registerCommands(((channel, handler) => handlers.set(channel, handler)) as RegisterCommand, { store, runner, terminals, emit: () => {}, pickDirectory: async () => null, openPath: async () => {}, openTerminal: async () => {} });
  const invoke = async (channel: string, req: unknown): Promise<any> => { const handler = handlers.get(channel); if (!handler) throw new Error(`Context command unavailable: ${channel}`); return handler(req); };
  return { store, project, runner, invoke, turns: () => turns, inputs };
}
async function selectForFirstSend(f: ReturnType<typeof admittedApp>) {
  const binding = await f.invoke("task:context-draft-open", { owner: { kind: "project", projectId: f.project.id, key: `draft:0:${f.project.id}` } }) as ContextDraftBinding;
  return f.invoke("task:context-draft-select", { binding, targets: [{ kind: "file", path: "README.md" }] }) as Promise<{ binding: ContextDraftBinding; context: TaskContextEvidence }>;
}

test("first ordinary Send carries selected receipts once and refuses a second Send with the spent nonce", async t => {
  const f = admittedApp(t), selected = await selectForFirstSend(f);
  const thread = await f.invoke("thread:create", { projectId: f.project.id, backend: "mock", auto: false, contextDraft: selected.binding });
  assert.deepEqual(await f.invoke("thread:send", { threadId: thread.id, text: "Check", contextDraft: selected.binding }), { ok: true });
  const user = f.store.items(thread.id).find(i => i.kind === "user");
  assert.ok(user?.kind === "user"); assert.deepEqual(user.contextEvidence, selected.context);
  assert.equal(f.turns(), 1);
  assert.ok(f.inputs[0]!.includes("README.md"), "selected relative refs reach the existing native coding input");
  assert.equal(f.inputs[0]!.includes(f.project.path), false);
  assert.equal(f.inputs[0]!.includes("# demo"), false, "capture metadata never adds file bodies to the prompt");
  const judge = stateFor({ text: "Next", backend: "mock", model: "", mode: "agent", plan: false, items: f.store.items(thread.id), project: { name: f.project.name } });
  assert.equal(JSON.stringify(judge).includes("README.md"), false, "Jev's compact state excludes the saved context map");
  assert.equal(JSON.stringify(judge).includes("contextEvidence"), false);
  const again = await f.invoke("thread:send", { threadId: thread.id, text: "Again", contextDraft: selected.binding });
  assert.equal(again.ok, false); assert.equal(f.turns(), 1);
  assert.equal(f.store.items(thread.id).filter(i => i.kind === "user").length, 1);
});

test("a failed user write keeps the selection editable and a later explicit Send uses its original receipts", async t => {
  const f = admittedApp(t), selected = await selectForFirstSend(f);
  const thread = await f.invoke("thread:create", { projectId: f.project.id, backend: "mock", auto: false, contextDraft: selected.binding });
  const save = f.store.saveItems.bind(f.store); let fail = true;
  t.mock.method(f.store, "saveItems", (id: string, items: Parameters<Store["saveItems"]>[1]) => {
    if (fail && items.some(i => i.kind === "user")) { fail = false; throw new Error("Synthetic user write failure"); }
    save(id, items);
  });
  assert.equal((await f.invoke("thread:send", { threadId: thread.id, text: "Check", contextDraft: selected.binding })).ok, false);
  assert.equal(f.turns(), 0); assert.deepEqual(f.store.items(thread.id), []);
  assert.equal((await f.invoke("thread:send", { threadId: thread.id, text: "Check", contextDraft: selected.binding })).ok, true);
  const user = f.store.items(thread.id).find(i => i.kind === "user");
  assert.ok(user?.kind === "user"); assert.deepEqual(user.contextEvidence, selected.context);
  assert.equal(f.turns(), 1);
});

test("thread creation refuses a foreign context draft before creating a thread", async t => {
  const f = admittedApp(t), selected = await selectForFirstSend(f), other = f.store.addProject(gitRepo());
  await assert.rejects(f.invoke("thread:create", { projectId: other.id, backend: "mock", auto: false, contextDraft: selected.binding }), /context|project|draft/);
  assert.equal(f.store.snapshot().threads.length, 0);
});


test("concurrent first-thread creation using one context draft returns one main-bound thread", async t => {
  const f = admittedApp(t), selected = await selectForFirstSend(f);
  const request = { projectId: f.project.id, backend: "mock", auto: false, contextDraft: selected.binding };
  const [a, b] = await Promise.all([f.invoke("thread:create", request), f.invoke("thread:create", request)]);
  assert.equal(a.id, b.id); assert.equal(f.store.snapshot().threads.length, 1);
});

test("provided malformed context is refused instead of being silently treated as an ordinary request", async t => {
  const f = admittedApp(t);
  for (const contextDraft of [null, false]) {
    await assert.rejects(f.invoke("thread:create", { projectId: f.project.id, backend: "mock", auto: false, contextDraft }));
  }
  const thread = await f.invoke("thread:create", { projectId: f.project.id, backend: "mock", auto: false });
  for (const contextDraft of [null, false]) assert.equal((await f.invoke("thread:send", { threadId: thread.id, text: "Check", contextDraft })).ok, false);
  assert.equal(f.turns(), 0);
});
