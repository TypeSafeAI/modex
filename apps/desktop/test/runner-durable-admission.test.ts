import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner, type DurableSendAdmission } from "../src/main/engine/runner.js";
import { AttachmentStore } from "../src/main/engine/attachments.js";
import type { ThreadEvent } from "../src/shared/types.js";

async function fixture(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-durable-runner-"));
  const store = new Store(home), events: ThreadEvent[] = [], turns: string[] = [];
  const attachments = new AttachmentStore(path.join(home, "attachments"), {
    authorizeDraft: owner => owner.kind === "thread" && !!store.thread(owner.threadId),
  });
  const runner = new ThreadRunner({ home, store, attachments, emit: event => events.push(event), backends: {
    mock: { id: "mock", listModels: async () => [], dispose: async () => {}, runTurn: async text => { turns.push(text); return { status: "completed" }; } },
  } });
  const thread = await runner.createThread(store.addProject(home).id, { backend: "mock", auto: false });
  store.updateThread(thread.id, { title: "Existing thread" });
  t.after(async () => { await runner.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  const admission = (committed: DurableSendAdmission["committed"] = () => {}): DurableSendAdmission =>
    ({ id: "stable-intent-1", at: "2026-10-11T00:00:00.000Z", committed });
  return { home, store, runner, thread, events, turns, attachments, admission };
}
const native = { skip: process.platform === "win32" };

test("durable native admission preserves fixed raw message and immutable files before backend work", native, async t => {
  const h = await fixture(t), raw = "  original raw message\n\t  ";
  const owner = { kind: "thread" as const, threadId: h.thread.id };
  const draft = h.attachments.mintDraft(owner);
  const staged = h.attachments.stage([{ name: "note.txt", data: "YQ==" }], { draft }).staged;
  const files = h.attachments.claim(h.thread.id, staged, { draft });
  let accepted = 0;
  await h.runner.sendDurably(h.thread.id, raw, files, h.admission(item => {
    accepted++;
    assert.equal(h.turns.length, 0);
    assert.equal(h.events.some(event => event.type === "item" && event.item.kind === "user"), false);
    assert.equal(item.text, raw); assert.equal(item.id, "stable-intent-1");
    assert.ok(Object.isFrozen(item)); assert.ok(Object.isFrozen(item.attachments![0]));
    assert.deepEqual(new Store(h.home).items(h.thread.id).find(row => row.id === item.id), item);
    assert.throws(() => { (item.attachments![0] as { name: string }).name = "changed"; }, TypeError);
  }));
  assert.equal(accepted, 1); assert.equal(h.turns.length, 1);
  assert.ok(h.turns[0]!.startsWith(raw.trim() + "\n\nAttached file"));
  const stored = h.store.items(h.thread.id).find(item => item.id === "stable-intent-1");
  assert.ok(stored?.kind === "user"); assert.equal(stored.text, raw);
  await h.runner.retry(h.thread.id);
  assert.equal(h.turns.length, 2);
  assert.equal(h.store.items(h.thread.id).filter(item => item.kind === "user").length, 1);
});

for (const outcome of ["throw", "async"] as const) {
  test(`an admission callback ${outcome} preserves the durable user item but starts no backend`, native, async t => {
    const h = await fixture(t);
    const committed = outcome === "throw" ? () => { throw new Error("intent cleanup failed"); } : async () => {};
    await assert.rejects(h.runner.sendDurably(h.thread.id, "original", [], h.admission(committed)), /cleanup|synchronously/);
    assert.deepEqual(h.turns, []);
    assert.equal(h.runner.items(h.thread.id).filter(item => item.id === "stable-intent-1").length, 1);
    assert.equal(new Store(h.home).items(h.thread.id).filter(item => item.id === "stable-intent-1").length, 1);
    assert.equal(h.events.some(event => event.type === "item" && event.item.kind === "user"), false);
  });
}

test("duplicate fixed message identity never auto-runs and normal explicit Retry remains available", native, async t => {
  const h = await fixture(t);
  await h.runner.sendDurably(h.thread.id, "original", [], h.admission());
  for (const text of ["original", "conflicting content"]) {
    await assert.rejects(h.runner.sendDurably(h.thread.id, text, [], h.admission()), /already admitted/);
  }
  assert.equal(h.turns.length, 1);
  await h.runner.retry(h.thread.id);
  assert.equal(h.turns.length, 2);
  assert.equal(h.store.items(h.thread.id).filter(item => item.kind === "user").length, 1);
  await h.runner.send(h.thread.id, "normal send");
  assert.equal(h.turns.length, 3);
});

for (const moment of ["before-write", "after-write"] as const) {
  test(`${moment} user persistence failure emits no phantom item and starts no backend`, native, async t => {
    const h = await fixture(t), save = h.store.saveItems;
    h.store.saveItems = (threadId, items) => {
      if (moment === "after-write") save.call(h.store, threadId, items);
      throw new Error("injected item persistence failure");
    };
    try { await assert.rejects(h.runner.sendDurably(h.thread.id, "original", [], h.admission()), /persistence/); }
    finally { h.store.saveItems = save; }
    assert.deepEqual(h.turns, []);
    assert.equal(h.runner.items(h.thread.id).some(item => item.id === "stable-intent-1"), false);
    assert.equal(h.events.some(event => event.type === "item" && event.item.kind === "user"), false);
    assert.equal(new Store(h.home).items(h.thread.id).some(item => item.id === "stable-intent-1"), moment === "after-write");
  });
}

test("admission reservation rejects nested sends and restart before any backend await", native, async t => {
  const h = await fixture(t); const nested: Promise<void>[] = [];
  await h.runner.sendDurably(h.thread.id, "original", [], h.admission(() => {
    nested.push(assert.rejects(h.runner.send(h.thread.id, "nested generic"), /still working/));
    nested.push(assert.rejects(h.runner.sendDurably(h.thread.id, "nested durable", [], { ...h.admission(), id: "other-intent" }), /still working/));
    assert.throws(() => h.runner.holdForRestart(), /current turns/);
  }));
  await Promise.all(nested);
  assert.deepEqual(h.turns, ["original"]);
  const release = h.runner.holdForRestart(); release();
});

test("disposal during the synchronous admission callback waits for the reservation and starts no backend", native, async t => {
  const h = await fixture(t); let closing: Promise<void> | undefined;
  await assert.rejects(h.runner.sendDurably(h.thread.id, "original", [], h.admission(() => { closing = h.runner.dispose(); })), /shutting down/);
  await closing;
  assert.deepEqual(h.turns, []);
  assert.equal(new Store(h.home).items(h.thread.id).some(item => item.id === "stable-intent-1"), true);
});

test("prepared sends refuse staged files instead of making an unjournaled claim", native, async t => {
  const h = await fixture(t), owner = { kind: "thread" as const, threadId: h.thread.id };
  const file = h.attachments.stage([{ name: "note.txt", data: "YQ==" }], { draft: h.attachments.mintDraft(owner) }).staged[0]!;
  await assert.rejects(h.runner.sendDurably(h.thread.id, "original", [file], h.admission()), /attachments changed/);
  assert.equal(fs.readFileSync(path.join(h.attachments.root, file.rel), "utf8"), "a");
  assert.deepEqual(h.turns, []); assert.deepEqual(h.runner.items(h.thread.id), []);
});

test("Windows keeps ordinary sends and refuses a strong native admission", { skip: process.platform !== "win32" }, async t => {
  const h = await fixture(t);
  await assert.rejects(h.runner.sendDurably(h.thread.id, "original", [], h.admission()), /unavailable/);
  await h.runner.send(h.thread.id, "normal Windows send");
  assert.deepEqual(h.turns, ["normal Windows send"]);
});

interface PendingCreator {
  createThreadForPending(projectId: string, creation: { threadId: string; createdAt: string }, configuration: {
    worktree: boolean; settings: { backend: "mock"; mode: "agent"; plan: boolean; auto: boolean; model: string; effort: string };
  }): Promise<import("../src/shared/types.js").Thread>;
}
const creator = (runner: ThreadRunner) => runner as ThreadRunner & PendingCreator;
const creation = () => ({ threadId: "01234567-89ab-4cde-8fab-0123456789ab", createdAt: "2026-10-11T00:00:00.000Z" });
const configuration = (worktree = false) => ({ worktree, settings: { backend: "mock" as const, mode: "agent" as const, plan: true, auto: false, model: "raw-model", effort: "high" } });

test("pending thread creation persists exact main identity and initial settings and reuses its matching thread", native, async t => {
  const h = await fixture(t), runner = creator(h.runner), reserved = creation(), config = configuration();
  const thread = await runner.createThreadForPending(h.thread.projectId, reserved, config);
  assert.equal(thread.id, reserved.threadId); assert.equal(thread.createdAt, reserved.createdAt);
  assert.equal(thread.plan, true); assert.equal(thread.effort, "high"); assert.equal(thread.model, "raw-model");
  assert.equal((await runner.createThreadForPending(h.thread.projectId, reserved, config)).id, thread.id);
  assert.equal(h.store.snapshot().threads.filter(row => row.id === reserved.threadId).length, 1);
  assert.deepEqual(new Store(h.home).thread(thread.id), JSON.parse(JSON.stringify(thread))); assert.deepEqual(h.turns, []);
});

for (const mismatch of ["threadId", "createdAt", "project"] as const) {
  test(`pending creation refuses ${mismatch} identity mismatch without changing existing threads`, native, async t => {
    const h = await fixture(t), runner = creator(h.runner);
    const reserved = creation(); await runner.createThreadForPending(h.thread.projectId, reserved, configuration());
    const before = h.store.snapshot().threads;
    const project = mismatch === "project" ? h.store.addProject(path.join(h.home, "other")).id : h.thread.projectId;
    const changed = { ...reserved, ...(mismatch === "threadId" ? { threadId: "../escape" } : mismatch === "createdAt" ? { createdAt: "2026-10-10T00:00:00.000Z" } : {}) };
    await assert.rejects(runner.createThreadForPending(project, changed, configuration()), /creation|identity|pending/i);
    assert.deepEqual(h.store.snapshot().threads, before);
  });
}

async function worktreeBarrier(h: Awaited<ReturnType<typeof fixture>>) {
  const directory = path.join(h.home, "scripts"); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "worktree.sh"), `#!/bin/bash
set -eu
printf '%s\\n' "$2" >> creation-calls
: > creation-started
for attempt in {1..200}; do
  if [ -f creation-release ]; then
    mkdir -p ".worktrees/$2"
    printf '%s\\n' "$PWD/.worktrees/$2"
    exit 0
  fi
  sleep 0.025
done
exit 1
`);
  return {
    async started() {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(path.join(h.home, "creation-started"))) {
        if (Date.now() >= deadline) throw new Error("worktree fixture did not reach barrier");
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    },
    release() { fs.writeFileSync(path.join(h.home, "creation-release"), "release"); },
    calls() { return fs.readFileSync(path.join(h.home, "creation-calls"), "utf8").trim().split("\n"); },
  };
}

test("duplicate pending creates share one real project script and capture initial configuration before await", { ...native, timeout: 10000 }, async t => {
  const h = await fixture(t), barrier = await worktreeBarrier(h), config = configuration(true), reserved = creation(), runner = creator(h.runner);
  const first = runner.createThreadForPending(h.thread.projectId, reserved, config);
  const second = runner.createThreadForPending(h.thread.projectId, reserved, config);
  config.settings.model = "caller changed model"; reserved.createdAt = "2026-10-10T00:00:00.000Z";
  try { await barrier.started(); assert.throws(() => h.runner.holdForRestart(), /finish/); }
  finally { barrier.release(); }
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id); assert.equal(a.createdAt, creation().createdAt); assert.equal(a.model, "raw-model");
  assert.deepEqual(barrier.calls(), [`modex-${creation().threadId}`]);
  assert.equal(a.worktree!.branch, `modex-${creation().threadId}`); assert.ok(fs.existsSync(a.cwd));
});

test("a script completed before Store failure remains preserved and is not implicitly executed again", { ...native, timeout: 10000 }, async t => {
  const h = await fixture(t), barrier = await worktreeBarrier(h), runner = creator(h.runner), add = h.store.addThread;
  h.store.addThread = () => { throw new Error("injected pending thread persistence"); };
  const first = runner.createThreadForPending(h.thread.projectId, creation(), configuration(true));
  const rejected = assert.rejects(first, /pending thread persistence/);
  try { await barrier.started(); }
  finally { barrier.release(); }
  await rejected; h.store.addThread = add;
  await assert.rejects(runner.createThreadForPending(h.thread.projectId, creation(), configuration(true)), /pending thread persistence/);
  assert.deepEqual(barrier.calls(), [`modex-${creation().threadId}`]);
  assert.equal(h.store.thread(creation().threadId), undefined);
  assert.ok(fs.existsSync(path.join(h.home, ".worktrees", `modex-${creation().threadId}`)));
});

test("proven unchanged no-worktree creation failure permits an explicit same-intent retry", native, async t => {
  const h = await fixture(t), reserved = creation(), open = fs.openSync;
  const stateFile = path.join(h.store.dir, "state.json"), before = fs.readFileSync(stateFile);
  fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
    if (String(args[0]).startsWith(`${stateFile}.`) && String(args[0]).endsWith(".tmp")) throw Object.assign(new Error("injected prewrite refusal"), { code: "EACCES" });
    return Reflect.apply(open, fs, args);
  }) as typeof fs.openSync;
  try { await assert.rejects(h.runner.createThreadForPending(h.thread.projectId, reserved, configuration()), /prewrite refusal/); }
  finally { fs.openSync = open; }
  assert.deepEqual(fs.readFileSync(stateFile), before); assert.equal(h.store.thread(reserved.threadId), undefined);
  assert.equal(h.store.supportsDurableAdmission, true);
  assert.equal((await h.runner.createThreadForPending(h.thread.projectId, reserved, configuration())).id, reserved.threadId);
  assert.deepEqual(h.turns, []);
});
