import { test } from "node:test";
import assert from "node:assert/strict";
import { registerCommands, type RegisterCommand } from "../src/main/commands.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { TerminalManager } from "../src/main/engine/terminal.js";
import { gitRepo, tmpdir } from "./helpers.js";
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
