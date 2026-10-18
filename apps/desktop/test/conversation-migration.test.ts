import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
    // Only what changed is sent, and only for the items that changed.
    assert.deepEqual(emitted.map((event) => event.type === "item_update" ? [event.id, Object.keys(event.patch).sort()] : [event.type]),
      [["dead:5", ["outcome", "status"]], ["dead:6", ["outcome"]], ["x:agent", ["agent", "status"]]]);
    assert.equal(ran, 0, "nothing is run again");
    await runner.dispose();
  } finally { old.journal.close(); }
});

test("loading a thread with nothing to settle sends nothing and leaves its file as it was", async () => {
  const old = await legacyThread();
  try {
    const file = path.join(old.home, "app", "threads", `${old.threadId}.json`);
    const typed: ThreadItem[] = [...LEGACY, { id: "t:1", kind: "tool", name: "Bash", title: "$ ls", args: { command: "ls" }, status: "done", outcome: "succeeded", ok: true,
      exec: { command: "ls" }, origin: { thread: old.threadId, turn: "u1", attempt: "a", backend: "claude", native: { runtime: "r", item: "toolu" } }, at }];
    new Store(old.home).saveItems(old.threadId, typed);
    const inode = fs.statSync(file).ino;
    const { runner, emitted } = runnerOn(old.home, old.journal);
    assert.deepEqual(runner.items(old.threadId), typed);
    assert.deepEqual(emitted, [], "no item_update for items that did not change");
    assert.equal(fs.statSync(file).ino, inode, "the file is not rewritten");
    await runner.dispose();
  } finally { old.journal.close(); }
});

test("an item kind this Mac does not know reaches the phone as a readable, inert notice, never as null", () => {
  // After a downgrade, the state files can hold items a newer Modex wrote. One null item makes the
  // phone reject its whole snapshot, so every item must map to something it can show.
  const future = { id: "w1", kind: "widget", at: "2026-10-18T00:00:00.000Z", body: "whatever a newer Modex put here" } as unknown as ThreadItem;
  const phone = mobileItem(future);
  assert.ok(phone, "never null or undefined");
  assert.equal(phone.id, "w1");
  assert.equal(phone.kind, "notice", "a kind every phone build renders, with nothing to act on");
  assert.equal(typeof phone.text, "string");
  assert.ok(!JSON.stringify(phone).includes("whatever a newer Modex"), "an unknown item's fields are not forwarded: they may hold anything");
  assert.ok(!JSON.stringify([future, future].map(mobileItem)).includes("null"), "a snapshot with unknown items has no null entries");
});

/** Every file under `home` except the journal's own, by its bytes. */
function besideJournal(home: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (!entry.name.startsWith("events.sqlite")) files.set(path.relative(home, file), fs.readFileSync(file).toString("base64"));
    }
  };
  walk(home);
  return files;
}

// v0.1.0's journal schema, verbatim (`git show v0.1.0:apps/desktop/src/main/engine/event-journal.ts`):
// an events table, no meta table, so no identity and no cursors.
const V010_SCHEMA = `PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    type TEXT NOT NULL,
    event TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_thread ON events (thread_id, seq);`;

test("a journal v0.1.0 wrote opens with its rows, takes an identity, replays unchanged, and leaves drafts and state files alone", async () => {
  const home = tmpdir("modex-migration-v010-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  const setup = new ThreadRunner({ home, store, emit: () => {} });
  const thread = await setup.createThread(project.id, { backend: "claude", auto: false });
  store.updateThread(thread.id, { title: "Old thread", titleSource: "manual" });
  store.saveItems(thread.id, LEGACY);
  await setup.dispose();
  fs.writeFileSync(path.join(store.dir, "update-recovery.json"), JSON.stringify({ drafts: [{ threadId: thread.id, text: "half a reply" }] }));
  const file = path.join(home, "app", "events.sqlite");
  const old = new DatabaseSync(file);
  old.exec(V010_SCHEMA);
  const insert = old.prepare("INSERT INTO events (at, thread_id, type, event) VALUES (?, ?, ?, ?)");
  for (const item of LEGACY) insert.run(at, thread.id, "item", JSON.stringify({ threadId: thread.id, type: "item", item }));
  old.close();
  const files = besideJournal(home);

  const journal = new EventJournal(file, { flushMs: 5 });
  try {
    assert.match(journal.id, /^[\w-]{1,64}$/, "it gains an identity clients can resume from");
    assert.equal(journal.latest(), LEGACY.length, "every row v0.1.0 wrote is kept, and cursors continue after them");
    assert.deepEqual(replayItems(journal.since(0, { threadId: thread.id }), thread.id), LEGACY, "and replays to the saved transcript");
    assert.equal(journal.resume(undefined, undefined).entries, undefined, "a client from before cursors reloads");
    const { runner } = runnerOn(home, journal);
    assert.deepEqual(runner.items(thread.id), LEGACY, "the transcript loads with every word");
    await runner.dispose();
  } finally { journal.close(); }
  const relaunched = new EventJournal(file);
  const id = relaunched.id;
  relaunched.close();
  assert.equal(new EventJournal(file).id, id, "the identity is kept across clean relaunches");
  assert.deepEqual(besideJournal(home), files, "the draft and the state files are byte-identical");
});

test("a journal this build wrote stays usable after a downgrade: v0.1.0's and v0.2.0's own statements still read and write it", () => {
  const file = path.join(tmpdir("modex-migration-rollback-"), "events.sqlite");
  const journal = new EventJournal(file);
  journal.record({ threadId: "t1", type: "item", item: LEGACY[0]! });
  const id = journal.id;
  const cursor = journal.latest();
  journal.close();

  // v0.1.0 opening it: its schema is a subset, so it opens, reads and appends.
  const v010 = new DatabaseSync(file);
  v010.exec(V010_SCHEMA);
  v010.prepare("INSERT INTO events (at, thread_id, type, event) VALUES (?, ?, ?, ?)").run(at, "t1", "item", JSON.stringify({ threadId: "t1", type: "item", item: LEGACY[1] }));
  assert.equal((v010.prepare("SELECT seq, at, event FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(0, 10) as unknown[]).length, 2);
  v010.close();

  // v0.2.0 opening it: the same meta table; it keeps the identity and ignores the `open` flag.
  const v020 = new DatabaseSync(file);
  v020.exec(`${V010_SCHEMA}
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  v020.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('id', ?)").run("would-be-new-id");
  assert.equal((v020.prepare("SELECT value FROM meta WHERE key = ?").get("id") as { value: string }).value, id, "v0.2.0 keeps the identity this build gave it");
  assert.equal(Number((v020.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get() as { seq: number }).seq), cursor + 1);
  v020.close();

  // Back on this build: nothing the older builds did confuses it.
  const back = new EventJournal(file);
  assert.equal(back.id, id, "an older build's clean use does not look like a crash");
  assert.equal(back.since(0).length, 2);
  back.close();
});
