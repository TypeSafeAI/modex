import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { MockBackend } from "../src/main/engine/backends/mock.js";
import type { MockStep } from "@modex/core";
import type { ThreadEvent } from "../src/shared/types.js";
import { gitRepo, tmpdir, writeScript } from "./helpers.js";

const PATCH = "*** Begin Patch\n*** Add File: NOTE.md\n+hello from modex\n*** End Patch";

function harness(steps: MockStep[]) {
  const home = tmpdir("modex-home-");
  const store = new Store(home);
  store.updateSettings({ default_backend: "mock", mock_script: writeScript(steps) });
  const events: ThreadEvent[] = [];
  const backends = { mock: new MockBackend(() => store.settings.mock_script, home, 0) };
  return { home, store, events, emit: (e: ThreadEvent) => events.push(e), backends };
}

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const saved = (home: string) => JSON.parse(fs.readFileSync(path.join(home, "app", "state.json"), "utf8")).threads[0] as Record<string, unknown>;

test("archiving is refused while a thread works, keeps the transcript, survives restart, and publishes once", async () => {
  const h = harness([
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "ok" },
  ]);
  const project = h.store.addProject(gitRepo());
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "chat" });
  try {
    assert.throws(() => runner.setArchived(thread.id, "yes" as unknown as boolean), /Archive or Unarchive/);
    assert.throws(() => runner.setArchived("nope0000", true), /unknown thread/);
    const done = runner.send(thread.id, "write NOTE.md");
    const approval = await waitFor(() => runner.items(thread.id).find((i) => i.kind === "approval"));
    assert.equal(runner.status(thread.id), "waiting");
    assert.throws(() => runner.setArchived(thread.id, true), /finish before archiving/, "nothing hidden may wait for an answer");
    runner.answer(thread.id, approval!.id, "yes");
    await done;
    assert.equal(runner.status(thread.id), "idle");

    const archived = runner.setArchived(thread.id, true);
    assert.ok(archived.archived?.at, "archiving records when");
    const published = h.events.filter((e) => e.type === "thread").at(-1);
    assert.equal(published?.type === "thread" && published.thread.archived?.at, archived.archived!.at, "the renderer learns about it from the thread event");
    assert.equal(runner.items(thread.id).length > 0, true, "the transcript stays");
    assert.equal(new Store(h.home).thread(thread.id)?.archived?.at, archived.archived!.at, "archive state survives a restart");
    const before = h.events.length;
    assert.deepEqual(runner.setArchived(thread.id, true).archived, archived.archived);
    assert.equal(h.events.length, before, "archiving twice publishes nothing new");

    assert.equal(runner.setArchived(thread.id, false).archived, undefined);
    assert.equal("archived" in saved(h.home), false, "the saved record drops the field rather than keeping a blank");
    assert.equal(new Store(h.home).thread(thread.id)?.archived, undefined);
  } finally { await runner.dispose(); }
});

test("a new message brings an archived thread back", async () => {
  // The mock script restarts on every turn, so one plain reply is enough here.
  const h = harness([{ content: "back again" }]);
  const project = h.store.addProject(gitRepo());
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "chat" });
  try {
    runner.setArchived(thread.id, true);
    assert.ok(h.store.thread(thread.id)?.archived);
    await runner.send(thread.id, "come back");
    assert.equal(runner.status(thread.id), "idle");
    assert.equal(h.store.thread(thread.id)?.archived, undefined, "sending restores the thread");
    assert.equal("archived" in saved(h.home), false);
    const restored = h.events.filter((e) => e.type === "thread").find((e) => e.type === "thread" && e.thread.archived === undefined);
    assert.ok(restored, "the renderer learns about the restore from a thread event");
    assert.equal(runner.items(thread.id).filter((i) => i.kind === "assistant").length, 1, "the turn ran");
  } finally { await runner.dispose(); }
});

test("an archived thread is only hidden: items, settings and retirement state are untouched", async () => {
  const h = harness([]);
  const project = h.store.addProject(gitRepo());
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id, { mode: "chat" });
  try {
    runner.updateThread(thread.id, { title: "Keep me", approvals: "always" });
    const archived = runner.setArchived(thread.id, true);
    assert.equal(archived.title, "Keep me");
    assert.equal(archived.approvals, "always");
    const restored = new Store(h.home);
    assert.equal(restored.thread(thread.id)?.title, "Keep me");
    assert.equal(restored.thread(thread.id)?.status, "idle", "an archived thread is never working");
  } finally { await runner.dispose(); }
});

test("a failed automatic unarchive releases admission so the thread can retry", async () => {
  const h = harness([{ content: "recovered" }]);
  const project = h.store.addProject(gitRepo());
  const runner = new ThreadRunner(h);
  const thread = await runner.createThread(project.id);
  const update = h.store.updateThread.bind(h.store);
  try {
    runner.setArchived(thread.id, true);
    h.store.updateThread = () => { throw new Error("injected archive write failure"); };
    await assert.rejects(runner.send(thread.id, "first"), /injected archive write failure/);
    h.store.updateThread = update;
    // Restart admission also proves that no unresolved turn reservation survived.
    runner.holdForRestart()();
    await runner.send(thread.id, "retry");
    assert.equal(runner.status(thread.id), "idle");
    assert.equal(h.store.thread(thread.id)?.archived, undefined);
    assert.ok(runner.items(thread.id).some(item => item.kind === "assistant" && item.text === "recovered"));
  } finally {
    h.store.updateThread = update;
    await runner.dispose();
  }
});
