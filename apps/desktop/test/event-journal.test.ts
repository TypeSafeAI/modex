import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { EventJournal, replayItems } from "../src/main/engine/event-journal.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { MockBackend } from "../src/main/engine/backends/mock.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import type { MockStep } from "@modex/core";
import { gitRepo, tmpdir, writeScript } from "./helpers.js";

const PATCH = "*** Begin Patch\n*** Add File: NOTE.md\n+hello from modex\n*** End Patch";

test("a recorded session replays from the journal to exactly its saved transcript", async () => {
  const home = tmpdir("modex-journal-");
  const store = new Store(home);
  const steps: MockStep[] = [
    { thinking: "Check the tree first.", content: "Looking.", tool_calls: [{ name: "shell", arguments: { command: "ls" } }] },
    { tool_calls: [{ name: "apply_patch", arguments: { patch: PATCH } }] },
    { content: "Added NOTE.md." },
  ];
  store.updateSettings({ default_backend: "mock", mock_script: writeScript(steps) });
  const journal = new EventJournal(path.join(home, "app", "events.sqlite"), 5);
  const emitted: ThreadEvent[] = [];
  const runner = new ThreadRunner({ home, store, emit: (event) => { emitted.push(event); journal.record(event); },
    backends: { mock: new MockBackend(() => store.settings.mock_script, home, 0) } });
  const project = store.addProject(gitRepo());
  const thread = await runner.createThread(project.id, { mode: "agent" });
  try {
    await runner.send(thread.id, "add a note file please");
    await runner.send(thread.id, "and say done");
    const saved = new Store(home).items(thread.id);
    assert.ok(saved.length >= 6, `a real transcript (${saved.length} items)`);
    const entries = journal.since(0, { threadId: thread.id });
    assert.deepEqual(replayItems(entries, thread.id), saved, "journal replay equals the persisted transcript");
    assert.deepEqual(replayItems(emitted, thread.id), saved, "the raw event stream folds to the same transcript");
    const itemEvents = emitted.filter((event) => event.threadId === thread.id && (event.type === "item" || event.type === "item_update")).length;
    const itemRows = entries.filter((entry) => entry.event.type === "item" || entry.event.type === "item_update").length;
    assert.ok(itemRows <= itemEvents, `merged rows (${itemRows}) never exceed events (${itemEvents})`);
  } finally {
    await runner.dispose();
    journal.close();
  }
});

test("cursors only grow and survive reopening the journal", () => {
  const file = path.join(tmpdir("modex-journal-"), "events.sqlite");
  const first = new EventJournal(file);
  const user: ThreadItem = { id: "u1", kind: "user", text: "hello", at: "2026-10-14T00:00:00.000Z" } as ThreadItem;
  first.record({ threadId: "t1", type: "item", item: user });
  first.record({ threadId: "t1", type: "status", status: "running" });
  const cursor = first.latest();
  assert.equal(cursor, 2);
  first.close();

  const reopened = new EventJournal(file);
  assert.equal(reopened.latest(), cursor);
  reopened.record({ threadId: "t1", type: "status", status: "idle" });
  const missed = reopened.since(cursor);
  assert.deepEqual(missed.map((entry) => [entry.seq, entry.event.type]), [[3, "status"]]);
  assert.deepEqual(reopened.since(0).map((entry) => entry.seq), [1, 2, 3]);
  assert.deepEqual(reopened.since(reopened.latest()), [], "a client that is caught up gets nothing");
  reopened.close();
});

test("updates within one flush merge into one row that applies like the separate updates", () => {
  const journal = new EventJournal(path.join(tmpdir("modex-journal-"), "events.sqlite"), 60_000);
  const reply = { id: "a1", kind: "assistant", text: "", at: "2026-10-14T00:00:00.000Z" } as ThreadItem;
  const events: ThreadEvent[] = [
    { threadId: "t1", type: "item", item: reply },
    { threadId: "t1", type: "item_update", id: "a1", patch: { text: "Hel" } as Partial<ThreadItem> },
    { threadId: "t1", type: "item_update", id: "a1", patch: { text: "Hello" } as Partial<ThreadItem> },
    { threadId: "t1", type: "status", status: "running" },
    { threadId: "t1", type: "item_update", id: "missing", patch: { text: "ignored" } as Partial<ThreadItem> },
    { threadId: "t1", type: "item_update", id: "missing", patch: { status: "done" } as Partial<ThreadItem> },
    { threadId: "t1", type: "status", status: "idle" },
  ];
  for (const event of events) journal.record(event);
  const rows = journal.since(0);
  assert.deepEqual(rows.map((row) => row.event.type), ["item", "status", "item_update"], "one row per item and per thread status");
  assert.equal((rows[0]!.event as { item: { text: string } }).item.text, "Hello");
  assert.equal((rows[1]!.event as { status: string }).status, "idle", "the latest status wins");
  assert.deepEqual((rows[2]!.event as { patch: unknown }).patch, { text: "ignored", status: "done" });
  assert.deepEqual(replayItems(rows, "t1"), replayItems(events, "t1"));
  journal.close();
});

test("since filters by thread and bounds its page size", () => {
  const journal = new EventJournal(path.join(tmpdir("modex-journal-"), "events.sqlite"));
  for (let i = 0; i < 5; i++) journal.record({ threadId: i % 2 ? "odd" : "even", type: "item", item: { id: `i${i}`, kind: "user", text: String(i), at: "2026-10-14T00:00:00.000Z" } as ThreadItem });
  assert.deepEqual(journal.since(0, { threadId: "odd" }).map((entry) => (entry.event as { item: { id: string } }).item.id), ["i1", "i3"]);
  assert.deepEqual(journal.since(0, { limit: 2 }).map((entry) => entry.seq), [1, 2]);
  assert.deepEqual(journal.since(2, { limit: 2 }).map((entry) => entry.seq), [3, 4]);
  journal.close();
  assert.doesNotThrow(() => journal.record({ threadId: "even", type: "status", status: "idle" }), "a closed journal ignores late events");
});
