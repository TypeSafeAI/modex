import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventJournal, replayItems } from "../src/main/engine/event-journal.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { mobileItem } from "../src/main/engine/companion.js";
import type { Backend } from "../src/main/engine/backends/types.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { itemFacts } from "../src/shared/conversation-events.js";
import { local } from "./fakeproc.js";
import { gitRepo, tmpdir } from "./helpers.js";

/**
 * History written before the conversation-event contract (docs/conversation-events.md) keeps every
 * word, gains no invented provenance, replays the same from the journal, and reads on the phone as
 * it did. Work a dead process left running becomes unknown everywhere, not only in this window.
 */

const at = "2026-10-01T00:00:00.000Z";
const LEGACY: ThreadItem[] = [
  { id: "u1", kind: "user", text: "fix the build", at },
  { id: "think-1", kind: "thinking", text: "Look at the error first.", status: "done", durationMs: 1200, at },
  { id: "a1", kind: "assistant", text: "Checking — café ✓.", at },
  { id: "x:tool-1", kind: "tool", name: "shell", title: "$ npm test", args: { command: "npm test" }, output: "1 failing", ok: false, status: "done", durationMs: 900, at },
  { id: "x:tool-2", kind: "tool", name: "shell", title: "$ ls", args: { command: "ls" }, output: "src", ok: true, status: "done", durationMs: 40, at },
  { id: "a2", kind: "assistant", text: "Fixed the import.", at },
];

function runnerOn(home: string, journal: EventJournal, backend?: Backend) {
  const store = new Store(home);
  const emitted: ThreadEvent[] = [];
  const runner = new ThreadRunner({ home, store, emit: (event) => { emitted.push(event); journal.record(event); }, ...(backend ? { backends: { claude: backend } } : {}) });
  return { store, runner, emitted };
}

async function legacyThread() {
  const home = tmpdir("modex-migration-");
  const journal = new EventJournal(path.join(home, "app", "events.sqlite"), { flushMs: 5 });
  const { store, runner } = runnerOn(home, journal);
  const project = store.addProject(gitRepo());
  const thread = await runner.createThread(project.id, { backend: "claude", auto: false });
  store.updateThread(thread.id, { title: "Old thread", titleSource: "manual" });
  store.saveItems(thread.id, LEGACY);
  // The journal as an older build wrote it: the same items, as plain events.
  for (const item of LEGACY) journal.record({ threadId: thread.id, type: "item", item });
  journal.flush();
  await runner.dispose();
  return { home, journal, threadId: thread.id };
}

test("a transcript and journal written before the contract load, replay and project unchanged", async () => {
  const old = await legacyThread();
  try {
    const { runner } = runnerOn(old.home, old.journal);
    assert.deepEqual(runner.items(old.threadId), LEGACY, "every item exactly as saved");
    assert.deepEqual(new Store(old.home).items(old.threadId), LEGACY);
    assert.deepEqual(replayItems(old.journal.since(0, { threadId: old.threadId }), old.threadId), LEGACY, "the old journal replays to the same transcript");
    assert.ok(LEGACY.every((item) => !itemFacts(item).observed && !itemFacts(item).origin), "no provenance is invented");
    // The phone reads old items as before; a failed tool now also says so in its title.
    assert.deepEqual(LEGACY.map(mobileItem), [
      { id: "u1", kind: "user", text: "fix the build", at },
      { id: "think-1", kind: "thinking", text: "Look at the error first.", at },
      { id: "a1", kind: "assistant", text: "Checking — café ✓.", at },
      { id: "x:tool-1", kind: "tool", title: "$ npm test · Failed", status: "done", ok: false, at },
      { id: "x:tool-2", kind: "tool", title: "$ ls", status: "done", ok: true, at },
      { id: "a2", kind: "assistant", text: "Fixed the import.", at },
    ]);
    await runner.dispose();
  } finally { old.journal.close(); }
});

test("a typed turn appended to old history leaves the old items as they were and replays with them", async () => {
  const old = await legacyThread();
  try {
    const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, runTurn: async (_t, _o, sink) => { local(sink).assistant("New answer."); return { status: "completed" }; } };
    const { runner } = runnerOn(old.home, old.journal, backend);
    await runner.send(old.threadId, "and now?");
    old.journal.flush();
    const saved = new Store(old.home).items(old.threadId);
    assert.deepEqual(saved.slice(0, LEGACY.length), LEGACY, "old items untouched");
    const added = saved.slice(LEGACY.length);
    assert.deepEqual(added.map((item) => [item.kind, itemFacts(item).observed]), [["user", false], ["assistant", true]]);
    assert.deepEqual(replayItems(old.journal.since(0, { threadId: old.threadId }), old.threadId), saved);
    await runner.dispose();
  } finally { old.journal.close(); }
});

test("work a dead process left running becomes unknown in the snapshot, the journal and every client, and nothing runs", async () => {
  const old = await legacyThread();
  try {
    const origin = { thread: old.threadId, turn: "u2", attempt: "dead", backend: "claude" as const, native: { runtime: "gone", item: "toolu" } };
    const stale: ThreadItem[] = [
      ...LEGACY,
      { id: "u2", kind: "user", text: "deploy", at },
      { id: "dead:5", kind: "tool", name: "Bash", title: "$ ./deploy.sh", args: {}, status: "running", outcome: "running", origin, at },
      { id: "dead:6", kind: "assistant", text: "Deploying", phase: "unspecified", outcome: "running", origin: { ...origin, native: { runtime: "gone", item: "msg" } }, at },
      { id: "x:agent", kind: "tool", name: "subagent", title: "agent: review", args: {}, status: "running", agent: { id: "a", label: "review", state: "running" }, at },
    ];
    new Store(old.home).saveItems(old.threadId, stale);
    // The process that died had journaled them too, still running.
    for (const item of stale.slice(LEGACY.length)) old.journal.record({ threadId: old.threadId, type: "item", item });
    old.journal.flush();
    let ran = 0;
    const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, runTurn: async () => { ran++; return { status: "completed" }; } };
    const { runner, emitted } = runnerOn(old.home, old.journal, backend);
    const items = runner.items(old.threadId);
    const view = (list: ThreadItem[]) => list.slice(-3).map((item) => [item.id, (item as { status?: string }).status ?? null, (item as { outcome?: string }).outcome ?? null, item.kind === "tool" ? item.agent?.state ?? null : null]);
    const expected = [["dead:5", "done", "unknown", null], ["dead:6", null, "unknown", null], ["x:agent", "done", null, "unknown"]];
    assert.deepEqual(view(items), expected, "this window");
    assert.deepEqual(view(new Store(old.home).items(old.threadId)), expected, "the saved snapshot, for the next process");
    old.journal.flush();
    assert.deepEqual(view(replayItems(old.journal.since(0, { threadId: old.threadId }), old.threadId)), expected, "paired clients catching up from the journal");
    assert.ok(emitted.some((event) => event.type === "item_update" && event.id === "dead:5"), "and the open window is told");
    assert.equal(ran, 0, "nothing is run again");
    await runner.dispose();
  } finally { old.journal.close(); }
});
