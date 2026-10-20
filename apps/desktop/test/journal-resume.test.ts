import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import https from "node:https";
import path from "node:path";
import { once } from "node:events";
import { EventJournal } from "../src/main/engine/event-journal.js";
import { DesktopHost } from "../src/main/engine/desktop-host.js";
import { DesktopClient } from "../src/main/engine/desktop-client.js";
import { CompanionServer, mobileItem } from "../src/main/engine/companion.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { MockBackend } from "../src/main/engine/backends/mock.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import type { TurnSink } from "../src/main/engine/backends/types.js";
import { replayItems } from "../src/main/engine/event-journal.js";
import type { MockStep } from "@modex/core";
import { gitRepo, tmpdir, writeScript } from "./helpers.js";

type Phone = { id: string; kind: string; text?: string; status?: string; answer?: string };
type PhoneSnapshot = { items: Phone[]; journal?: { id: string; cursor: number }; delta?: true };

/** Applies an item event as the window does: an `item` upserts by id, an `item_update` merges. */
function apply(items: ThreadItem[], event: ThreadEvent): ThreadItem[] {
  if (event.type !== "item" && event.type !== "item_update") return items;
  const id = event.type === "item" ? event.item.id : event.id;
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return event.type === "item" ? [...items, event.item] : items;
  const next = [...items];
  next[index] = event.type === "item" ? event.item : { ...items[index], ...event.patch } as ThreadItem;
  return next;
}

/** Fetches a snapshot exactly as the iPhone app does: pinned certificate, bearer token, cursor query. */
async function phoneSnapshot(pairingUri: string, home: string, threadId: string, after?: { id: string; cursor: number }): Promise<PhoneSnapshot> {
  const pairing = JSON.parse(Buffer.from(new URL(pairingUri).searchParams.get("data")!, "base64url").toString()) as { url: string; token: string; fingerprint: string };
  const url = new URL("/v1/snapshot", pairing.url);
  url.searchParams.set("threadId", threadId);
  if (after) { url.searchParams.set("journal", after.id); url.searchParams.set("after", String(after.cursor)); }
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { authorization: `Bearer ${pairing.token}` },
      ca: fs.readFileSync(path.join(home, "companion", "cert.pem")),
      checkServerIdentity: (_host, cert) => crypto.createHash("sha256").update(cert.raw).digest("hex") === pairing.fingerprint ? undefined : new Error("unpinned"),
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => res.statusCode === 200 ? resolve(JSON.parse(body) as PhoneSnapshot) : reject(new Error(`${res.statusCode} ${body}`)));
    }).on("error", reject);
  });
}

/** The phone's merge (CompanionSnapshot.merge): a changed item replaces its own, a new one appends. */
function merge(items: Phone[], changed: Phone[]): Phone[] {
  const merged = [...items];
  for (const item of changed) {
    const index = merged.findIndex((existing) => existing.id === item.id);
    if (index >= 0) merged[index] = item; else merged.push(item);
  }
  return merged;
}

const phoneView = (items: { id: string; kind: string }[]) => items.map(({ id, kind }) => ({ id, kind }));

test("a paired desktop and the phone resume after sleep with no gaps or duplicates", async () => {
  const home = tmpdir("modex-journal-resume-");
  const store = new Store(home);
  const steps: MockStep[] = [
    { thinking: "Look first.", content: "Looking.", tool_calls: [{ name: "shell", arguments: { command: "ls" } }] },
    { content: "All done." },
  ];
  store.updateSettings({ default_backend: "mock", mock_script: writeScript(steps) });
  const journal = new EventJournal(path.join(home, "app", "events.sqlite"), { flushMs: 5 });
  const runner = new ThreadRunner({ home, store, emit: (event) => journal.record(event),
    backends: { mock: new MockBackend(() => store.settings.mock_script, home, 0) } });
  const host = new DesktopHost(home, { version: "test", channels: () => [], async invoke() { return null; }, journal: () => journal });
  journal.subscribe((entries) => host.broadcastJournal(entries));
  const companion = new CompanionServer(home, { state: () => store.snapshot(), items: (id) => runner.items(id), status: (id) => runner.status(id),
    send: async () => ({ ok: true }), answer: () => {}, journal: () => journal }, () => ["127.0.0.1"], () => () => {});
  const client = new DesktopClient(() => {});
  try {
    const project = store.addProject(gitRepo());
    const thread = await runner.createThread(project.id, { mode: "agent" });
    await host.start();
    const pairingUri = (await companion.start()).pairingUri!;

    // The paired desktop loads the thread like the window: a snapshot, then live events.
    const connections: { resumed: boolean }[] = [];
    client.on("connected", (info: { resumed: boolean }) => connections.push(info));
    let desktop: ThreadItem[] = [];
    const delivered = new Map<string, number>();
    client.on("thread", (event: ThreadEvent) => {
      if (event.threadId !== thread.id) return;
      if (event.type === "item") delivered.set(event.item.id, (delivered.get(event.item.id) ?? 0) + 1);
      desktop = apply(desktop, event);
    });
    await client.pair(host.invite(), "a".repeat(64));
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    desktop = structuredClone(runner.items(thread.id));

    await runner.send(thread.id, "first turn");
    let phone = await phoneSnapshot(pairingUri, home, thread.id);
    assert.equal(phone.delta, undefined, "the first phone load is a full transcript");
    assert.ok(phone.journal, "the phone gets a cursor with its transcript");
    const waitForDesktop = async () => {
      const saved = runner.items(thread.id);
      for (let i = 0; i < 250 && JSON.stringify(desktop) !== JSON.stringify(saved); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(desktop, saved);
    };
    await waitForDesktop();
    const beforeSleep = runner.items(thread.id).length;

    // Both sleep. The Mac host keeps working: another turn runs while neither client listens.
    client.suspend();
    assert.equal(client.status().state, "offline");
    await runner.send(thread.id, "second turn while asleep");
    const during = structuredClone(runner.items(thread.id));
    assert.ok(during.length > beforeSleep, "the turn added items while the clients slept");

    // Wake. The desktop resumes after its cursor; the phone asks for what changed after its cursor.
    client.resume();
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(connections.map((info) => info.resumed), [false, true], "the wake-up resumed instead of reloading");
    await waitForDesktop();
    for (const [id, count] of delivered) assert.equal(count, 1, `item ${id} was delivered once`);
    for (const item of during.slice(beforeSleep)) assert.equal(delivered.get(item.id), 1, `item ${item.id} from the sleep reached the desktop`);

    const woke = await phoneSnapshot(pairingUri, home, thread.id, phone.journal);
    assert.equal(woke.delta, true, "the phone got changes, not a reload");
    assert.deepEqual(phoneView(woke.items), phoneView(during.slice(beforeSleep)), "only what happened during the sleep");
    phone = { ...woke, items: merge(phone.items, woke.items) };
    assert.deepEqual(phoneView(phone.items), phoneView(during), "the phone's merged transcript matches the Mac");
    assert.equal(new Set(phone.items.map((item) => item.id)).size, phone.items.length, "no duplicated items on the phone");

    const idle = await phoneSnapshot(pairingUri, home, thread.id, phone.journal);
    assert.deepEqual(idle.items, [], "a caught-up phone gets no items");

    // A cursor the journal no longer covers is told to reload, on both clients.
    const other = await phoneSnapshot(pairingUri, home, thread.id, { id: "another-journal", cursor: phone.journal!.cursor });
    assert.equal(other.delta, undefined);
    assert.deepEqual(phoneView(other.items), phoneView(during));
  } finally {
    client.dispose();
    await companion.dispose();
    await host.dispose();
    await runner.dispose();
    journal.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a desktop whose cursor the host cannot resume reloads, and a stopped journal restarts streams", async () => {
  const home = tmpdir("modex-journal-reload-");
  let journal: EventJournal | undefined = new EventJournal(path.join(home, "app", "events.sqlite"), { flushMs: 5 });
  const host = new DesktopHost(home, { version: "test", channels: () => [], async invoke() { return null; }, journal: () => journal });
  journal.subscribe((entries) => host.broadcastJournal(entries));
  const client = new DesktopClient(() => {});
  const connections: boolean[] = [];
  client.on("connected", ({ resumed }: { resumed: boolean }) => connections.push(resumed));
  const events: ThreadEvent[] = [];
  client.on("thread", (event: ThreadEvent) => events.push(event));
  try {
    await host.start();
    await client.pair(host.invite(), "a".repeat(64));
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    journal.record({ threadId: "t1", type: "status", status: "running" });
    await once(client, "thread", { signal: AbortSignal.timeout(5000) });

    // Pruned past the client's cursor: the wake-up reloads, and the missed rows are not replayed.
    client.suspend();
    for (let i = 0; i < 3; i++) journal.record({ threadId: "t1", type: "item", item: { id: `i${i}`, kind: "user", text: "x", at: new Date().toISOString() } as ThreadItem });
    journal.flush();
    (journal as unknown as { retention: { maxAgeMs: number; maxRows: number } }).retention = { maxAgeMs: 60_000, maxRows: 1 };
    journal.prune();
    client.resume();
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(connections, [false, false]);
    assert.equal(events.length, 1, "nothing is replayed to a client that must reload");

    // The journal stops: streams end, and the client reconnects without it and reloads.
    journal.close();
    journal = undefined;
    host.restartStreams();
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(connections, [false, false, false]);
    host.broadcast("thread", { threadId: "t1", type: "status", status: "idle" });
    await once(client, "thread", { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(events.at(-1), { threadId: "t1", type: "status", status: "idle" }, "events flow again without cursors");
  } finally {
    client.dispose();
    await host.dispose();
    journal?.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── Journal faults through the real host and client (CF-6, journal mechanics) ──────────────────────

const note = (id: string, text = id): ThreadItem => ({ id, kind: "user", text, at: new Date().toISOString() }) as ThreadItem;
const until = async (check: () => boolean, ms = 5000): Promise<void> => {
  for (const end = Date.now() + ms; !check(); await new Promise((resolve) => setTimeout(resolve, 20))) {
    if (Date.now() > end) throw new Error("timed out");
  }
};

/** A journal-backed host with one paired desktop client, collecting what the client sees. */
async function pairedOverJournal(prefix: string) {
  const home = tmpdir(prefix);
  let journal: EventJournal | undefined = new EventJournal(path.join(home, "app", "events.sqlite"), { flushMs: 5 });
  const host = new DesktopHost(home, { version: "test", channels: () => [], async invoke() { return null; }, journal: () => journal });
  let unsubscribe = journal.subscribe((entries) => host.broadcastJournal(entries));
  const client = new DesktopClient(() => {});
  const connections: boolean[] = [];
  client.on("connected", ({ resumed }: { resumed: boolean }) => connections.push(resumed));
  const ids: string[] = [];
  client.on("thread", (event: ThreadEvent) => { if (event.type === "item") ids.push(event.item.id); });
  await host.start();
  await client.pair(host.invite(), "a".repeat(64));
  await once(client, "connected", { signal: AbortSignal.timeout(5000) });
  return {
    home, host, client, connections, ids,
    get journal() { return journal!; },
    /** Swap in another journal, as a relaunch over the same home would. */
    replace(next: EventJournal | undefined) { unsubscribe(); journal = next; if (next) unsubscribe = next.subscribe((entries) => host.broadcastJournal(entries)); },
    async dispose() { client.dispose(); await host.dispose(); journal?.close(); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

test("a thread event too big for the client's frame buffer reloads once instead of resuming into it forever", async () => {
  const paired = await pairedOverJournal("modex-journal-big-");
  try {
    paired.journal.record({ threadId: "t1", type: "item", item: note("small") });
    await until(() => paired.ids.includes("small"));
    paired.journal.record({ threadId: "t1", type: "item", item: note("big", "y".repeat(1_100_000)) });
    await until(() => paired.connections.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 3000)); // a client that resumes into the frame reconnects again and again here
    assert.equal(paired.connections[1], false, "the client reloads state after a frame it cannot read");
    assert.ok(paired.connections.length <= 3, `it settles instead of looping (${paired.connections.length} connections)`);
    paired.journal.record({ threadId: "t1", type: "item", item: note("later") });
    await until(() => paired.ids.includes("later"));
    assert.ok(!paired.ids.includes("big"), "the oversized frame itself never arrives; the reload carries that item");
  } finally {
    await paired.dispose();
  }
});

test("Modex killed right after an approval is answered: pre-crash cursors reload on both clients, the card shows the answer, and nothing is sent again", async () => {
  const home = tmpdir("modex-journal-crash-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  const idle = { id: "claude" as const, listModels: async () => [], dispose: async () => {}, async runTurn() { return { status: "completed" as const }; } };
  const setup = new ThreadRunner({ home, store, backends: { claude: idle }, emit: () => {} });
  const thread = await setup.createThread(project.id, { backend: "claude", auto: false });
  store.updateThread(thread.id, { title: "Fixture", titleSource: "manual" });
  await setup.dispose();

  // A real Modex process: the CLI asks, the answer is saved and handed to the CLI, and the process is
  // killed before the journal's 250 ms batch is written. The paired desktop's cursor is taken first.
  const module = (name: string) => JSON.stringify(new URL(`../src/main/engine/${name}.js`, import.meta.url).href);
  const script = `import fs from "node:fs"; import path from "node:path";
    import { EventJournal } from ${module("event-journal")}; import { Store } from ${module("store")}; import { ThreadRunner } from ${module("runner")};
    const home = ${JSON.stringify(home)}, threadId = ${JSON.stringify(thread.id)};
    const journal = new EventJournal(path.join(home, "app", "events.sqlite"));
    const backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_text, _opts, sink) {
      // As a native backend does: the decision reaches the CLI through its handoff (docs/human-requests.md).
      const native = { runtime: "journal-crash", request: "deploy-1" };
      const answer = await sink.approval({ question: "Allow Bash: $ deploy?", canAlways: false, native });
      await sink.deliverRequest?.(native, async () => { fs.appendFileSync(path.join(home, "decisions.log"), answer + "\\n"); });
      process.kill(process.pid, "SIGKILL");
      return { status: "completed" };
    } };
    const runner = new ThreadRunner({ home, store: new Store(home), emit: (event) => journal.record(event), backends: { claude: backend } });
    void runner.send(threadId, "deploy");
    for (let i = 0; i < 500 && !runner.items(threadId).some((item) => item.kind === "approval"); i++) await new Promise((r) => setTimeout(r, 10));
    journal.flush();
    const card = runner.items(threadId).find((item) => item.kind === "approval");
    fs.writeFileSync(path.join(home, "pre-crash.json"), JSON.stringify({ id: journal.id, cursor: journal.latest(), card: card.id }));
    runner.answer(threadId, card.id, "yes");
    await new Promise(() => {});`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 30_000, encoding: "utf8" });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  const before = JSON.parse(fs.readFileSync(path.join(home, "pre-crash.json"), "utf8")) as { id: string; cursor: number; card: string };
  assert.equal(fs.readFileSync(path.join(home, "decisions.log"), "utf8"), "yes\n", "the CLI heard one decision");
  assert.equal((new Store(home).items(thread.id).find((item) => item.id === before.card) as { answer?: string }).answer, "yes", "the answer was saved");

  // Relaunch over the same home, with a CLI that counts every call.
  const journal = new EventJournal(path.join(home, "app", "events.sqlite"), { flushMs: 5 });
  let ran = 0;
  const counting = { ...idle, async runTurn() { ran++; return { status: "completed" as const }; } };
  const relaunched = new Store(home);
  const runner = new ThreadRunner({ home, store: relaunched, emit: (event) => journal.record(event), backends: { claude: counting } });
  const host = new DesktopHost(home, { version: "test", channels: () => [], async invoke() { return null; }, journal: () => journal });
  journal.subscribe((entries) => host.broadcastJournal(entries));
  const companion = new CompanionServer(home, { state: () => relaunched.snapshot(), items: (id) => runner.items(id), status: (id) => runner.status(id),
    send: async () => ({ ok: true }), answer: () => {}, journal: () => journal }, () => ["127.0.0.1"], () => () => {});
  const client = new DesktopClient(() => {});
  const connections: boolean[] = [];
  client.on("connected", ({ resumed }: { resumed: boolean }) => connections.push(resumed));
  try {
    assert.notEqual(journal.id, before.id, "the journal a dead process left open takes a new identity");
    await host.start();
    const pairingUri = (await companion.start()).pairingUri!;
    await client.pair(host.invite(), "a".repeat(64));
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    // The paired desktop held its pre-crash cursor across the outage.
    client.suspend();
    (client as unknown as { journal?: { id: string; cursor: number } }).journal = { id: before.id, cursor: before.cursor };
    client.resume();
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(connections, [false, false], "a pre-crash cursor reloads instead of resuming into a card that looks open");
    const phone = await phoneSnapshot(pairingUri, home, thread.id, { id: before.id, cursor: before.cursor });
    assert.equal(phone.delta, undefined, "the phone's pre-crash cursor reloads too");
    assert.equal(phone.items.find((item) => item.id === before.card)?.answer, "yes", "and its reload shows the card answered");
    assert.equal(ran, 0, "reloading, replaying and reconnecting ran nothing");
    assert.equal(fs.readFileSync(path.join(home, "decisions.log"), "utf8"), "yes\n", "and sent the CLI no second decision");
  } finally {
    client.dispose();
    await companion.dispose();
    await host.dispose();
    await runner.dispose();
    journal.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a journal write that fails while the phone reads turns journaling off: the phone and the desktop reload, and live events continue", async () => {
  const home = tmpdir("modex-journal-fail-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  let journal: EventJournal | undefined;
  const stopped: unknown[] = [];
  const host = new DesktopHost(home, { version: "test", channels: () => [], async invoke() { return null; }, journal: () => journal });
  // index.ts's wiring: the main process records into the journal while it is on and broadcasts
  // directly otherwise; a failure stops it, and streams it fed reconnect without it.
  const emit = (event: ThreadEvent) => { if (journal) journal.record(event); else host.broadcast("thread", event); };
  const idle = { id: "claude" as const, listModels: async () => [], dispose: async () => {}, async runTurn() { return { status: "completed" as const }; } };
  const runner = new ThreadRunner({ home, store, backends: { claude: idle }, emit });
  journal = new EventJournal(path.join(home, "app", "events.sqlite"), { flushMs: 60_000, onError: (error) => {
    stopped.push(error);
    const failed = journal;
    journal = undefined;
    try { failed?.close(); } catch { /* the state files remain authoritative */ }
    host.restartStreams();
  } });
  journal.subscribe((entries) => host.broadcastJournal(entries));
  const companion = new CompanionServer(home, { state: () => store.snapshot(), items: (id) => runner.items(id), status: (id) => runner.status(id),
    send: async () => ({ ok: true }), answer: () => {}, journal: () => journal }, () => ["127.0.0.1"], () => () => {});
  const client = new DesktopClient(() => {});
  const connections: boolean[] = [];
  client.on("connected", ({ resumed }: { resumed: boolean }) => connections.push(resumed));
  const events: ThreadEvent[] = [];
  client.on("thread", (event: ThreadEvent) => events.push(event));
  try {
    const thread = await runner.createThread(project.id, { backend: "claude", auto: false });
    await host.start();
    const pairingUri = (await companion.start()).pairingUri!;
    await client.pair(host.invite(), "a".repeat(64));
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    const first = await phoneSnapshot(pairingUri, home, thread.id);
    assert.ok(first.journal, "the phone holds a cursor");

    emit({ threadId: thread.id, type: "status", status: "running" }); // pending in the batch window
    (journal as unknown as { insert: { run(): never } }).insert = { run() { throw new Error("SQLITE_FULL: database or disk is full"); } };
    const after = await phoneSnapshot(pairingUri, home, thread.id, first.journal);
    assert.equal(after.delta, undefined, "the phone whose read hit the failure reloads instead of getting an error or a gap");
    assert.equal(stopped.length, 1, "the failure stopped the journal once");
    await until(() => connections.length === 2);
    assert.deepEqual(connections, [false, false], "the desktop reconnects without the journal and reloads");

    emit({ threadId: thread.id, type: "status", status: "idle" });
    await until(() => events.some((event) => event.type === "status" && event.status === "idle"));
    const later = await phoneSnapshot(pairingUri, home, thread.id, after.journal);
    assert.equal(later.delta, undefined, "with the journal off, every phone snapshot is a full transcript");
  } finally {
    client.dispose();
    await companion.dispose();
    await host.dispose();
    await runner.dispose();
    journal?.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

/** A host, phone server and paired desktop over one journal and a real thread, to probe cursors and limits. */
async function hostPhoneAndDesktop(prefix: string) {
  const home = tmpdir(prefix);
  const file = path.join(home, "app", "events.sqlite");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  let journal = new EventJournal(file, { flushMs: 5 });
  const idle = { id: "claude" as const, listModels: async () => [], dispose: async () => {}, async runTurn() { return { status: "completed" as const }; } };
  const runner = new ThreadRunner({ home, store, backends: { claude: idle }, emit: (event) => journal.record(event) });
  const host = new DesktopHost(home, { version: "test", channels: () => [], async invoke() { return null; }, journal: () => journal });
  let unsubscribe = journal.subscribe((entries) => host.broadcastJournal(entries));
  const companion = new CompanionServer(home, { state: () => store.snapshot(), items: (id) => runner.items(id), status: (id) => runner.status(id),
    send: async () => ({ ok: true }), answer: () => {}, journal: () => journal }, () => ["127.0.0.1"], () => () => {});
  const client = new DesktopClient(() => {});
  const connections: boolean[] = [];
  client.on("connected", ({ resumed }: { resumed: boolean }) => connections.push(resumed));
  const received: ThreadEvent[] = [];
  client.on("thread", (event: ThreadEvent) => received.push(event));
  const thread = await runner.createThread(project.id, { backend: "claude", auto: false });
  await host.start();
  const pairingUri = (await companion.start()).pairingUri!;
  await client.pair(host.invite(), "a".repeat(64));
  await once(client, "connected", { signal: AbortSignal.timeout(5000) });
  return {
    home, file, thread, host, client, connections, received,
    get journal() { return journal; },
    /** The desktop reconnects holding `cursor`, as after sleep; resolves whether it resumed. */
    async desktopFrom(cursor: { id: string; cursor: number }): Promise<boolean> {
      client.suspend();
      (client as unknown as { journal?: { id: string; cursor: number } }).journal = cursor;
      client.resume();
      await once(client, "connected", { signal: AbortSignal.timeout(5000) });
      return connections.at(-1)!;
    },
    phoneFrom: (cursor?: { id: string; cursor: number }) => phoneSnapshot(pairingUri, home, thread.id, cursor),
    /** The journal file is deleted and a new one opens over the same home. */
    replaceJournal() {
      unsubscribe();
      journal.close();
      for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
      journal = new EventJournal(file, { flushMs: 5 });
      unsubscribe = journal.subscribe((entries) => host.broadcastJournal(entries));
    },
    async dispose() { client.dispose(); await companion.dispose(); await host.dispose(); await runner.dispose(); journal.close(); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

test("every cursor the journal cannot honour reloads both clients: ahead of the log, pruned, and from a deleted journal", async () => {
  const at = await hostPhoneAndDesktop("modex-journal-cursors-");
  try {
    // Distinct items, so each is its own row (updates to one item would merge into one).
    for (let i = 0; i < 4; i++) at.journal.record({ threadId: at.thread.id, type: "item", item: note(`c${i}`) });
    const latest = at.journal.latest();
    const id = at.journal.id;
    // A control first: the client really does present the cursor it is given.
    assert.equal(await at.desktopFrom({ id, cursor: latest }), true, "a current cursor resumes the desktop");
    assert.equal((await at.phoneFrom({ id, cursor: latest })).delta, true, "and the phone");

    assert.equal(await at.desktopFrom({ id, cursor: latest + 50 }), false, "a cursor ahead of the log reloads the desktop");
    assert.equal((await at.phoneFrom({ id, cursor: latest + 50 })).delta, undefined, "and the phone");

    (at.journal as unknown as { retention: { maxAgeMs: number; maxRows: number } }).retention = { maxAgeMs: 60_000, maxRows: 1 };
    at.journal.prune();
    assert.equal(await at.desktopFrom({ id, cursor: 1 }), false, "a pruned cursor reloads the desktop");
    assert.equal((await at.phoneFrom({ id, cursor: 1 })).delta, undefined, "and the phone");

    at.replaceJournal();
    assert.notEqual(at.journal.id, id);
    assert.equal(await at.desktopFrom({ id, cursor: latest }), false, "a cursor from a deleted journal reloads the desktop");
    assert.equal((await at.phoneFrom({ id, cursor: latest })).delta, undefined, "and the phone");
  } finally {
    await at.dispose();
  }
});

test("a resume whose replay passes 4 MB reloads instead, and one under it replays every missed event once", async () => {
  const at = await hostPhoneAndDesktop("modex-journal-replay-");
  try {
    const big = (id: string) => ({ threadId: at.thread.id, type: "item" as const, item: note(id, "z".repeat(900_000)) });
    const missed = async (count: number, tag: string): Promise<boolean> => {
      at.journal.flush();
      const cursor = { id: at.journal.id, cursor: at.journal.latest() };
      at.client.suspend();
      for (let i = 0; i < count; i++) at.journal.record(big(`${tag}${i}`));
      at.journal.flush();
      return at.desktopFrom(cursor);
    };
    assert.equal(await missed(3, "small"), true, "about 2.7 MB missed: the desktop resumes");
    await until(() => ["small0", "small1", "small2"].every((id) => at.received.some((event) => event.type === "item" && event.item.id === id)));
    for (const id of ["small0", "small1", "small2"]) assert.equal(at.received.filter((event) => event.type === "item" && event.item.id === id).length, 1, `${id} arrived once`);
    assert.equal(await missed(5, "large"), false, "about 4.5 MB missed: the desktop reloads instead of replaying it");
    assert.ok(!at.received.some((event) => event.type === "item" && event.item.id.startsWith("large")), "nothing of the oversized replay was streamed");
  } finally {
    await at.dispose();
  }
});

test("a journal batch delivered twice reaches the paired desktop once", async () => {
  const at = await hostPhoneAndDesktop("modex-journal-twice-");
  try {
    at.journal.flush();
    const cursor = at.journal.latest();
    at.journal.record({ threadId: at.thread.id, type: "item", item: note("once") });
    at.journal.record({ threadId: at.thread.id, type: "item_update", id: "once", patch: { text: "edited" } });
    at.journal.flush();
    const batch = at.journal.since(cursor);
    at.host.broadcastJournal(batch); // the same rows again, as a retried write or a second subscriber would send them
    at.journal.record({ threadId: at.thread.id, type: "status", status: "idle" });
    await until(() => at.received.some((event) => event.type === "status" && event.status === "idle"));
    const rows = batch.filter((entry) => entry.event.threadId === at.thread.id && (entry.event.type === "item" || entry.event.type === "item_update"));
    assert.ok(rows.length >= 1);
    const mine = at.received.filter((event) => event.threadId === at.thread.id && (event.type === "item" || event.type === "item_update"));
    assert.deepEqual(mine, rows.map((entry) => entry.event), "each row applied once, though it was sent twice");
  } finally {
    await at.dispose();
  }
});

test("one mixed transcript converges on every path, survives hostile frames, and nothing is run or answered twice", async () => {
  const home = tmpdir("modex-journal-mixed-");
  const store = new Store(home);
  const project = store.addProject(gitRepo());
  const live = new EventJournal(path.join(home, "app", "events.sqlite"), { flushMs: 5 });
  // The same events through a journal that batches the whole run into one window, so a card's
  // opening and its withdrawal or answer coalesce into one row.
  const coalesced = new EventJournal(path.join(home, "batched.sqlite"), { flushMs: 60_000 });
  const emitted: ThreadEvent[] = [];
  const emit = (event: ThreadEvent) => { emitted.push(event); live.record(event); coalesced.record(event); };
  let runs = 0;
  const decisions: string[] = [];
  const sinks: TurnSink[] = [];
  const at = (item: string) => ({ runtime: "fixture", item });
  const backend = { id: "claude" as const, listModels: async () => [], dispose: async () => {}, async runTurn(_text: string, _opts: unknown, sink: TurnSink) {
    const n = ++runs;
    sinks.push(sink);
    if (n === 1) {
      sink.observe({ type: "message.start", native: at("m1"), phase: "commentary" });
      sink.observe({ type: "message.delta", native: at("m1"), text: "Looking first." });
      sink.observe({ type: "message.done", native: at("m1") });
      sink.observe({ type: "tool.start", native: at("t1"), tool: { name: "shell", title: "$ ls", args: { command: "ls" } } });
      sink.observe({ type: "tool.done", native: at("t1"), outcome: "succeeded", progress: { output: "a\nb\n" } });
      sink.observe({ type: "tool.update", native: at("t1"), progress: { output: "a late frame after the tool ended" } });
      // The decision reaches the CLI through its handoff, as a native backend's does (docs/human-requests.md).
      const native = { runtime: "fixture", request: "rm-build" };
      const answer = await sink.approval({ question: "Allow Bash: $ rm -rf build?", canAlways: false, native });
      await sink.deliverRequest?.(native, async () => { decisions.push(answer); });
      sink.observe({ type: "tool.start", native: at("t2"), tool: { name: "shell", title: "$ rm -rf build", args: { command: "rm -rf build" } } });
      sink.observe({ type: "tool.done", native: at("t2"), outcome: answer === "yes" ? "succeeded" : "denied" });
      sink.observe({ type: "message.start", native: at("m2"), phase: "final" });
      sink.observe({ type: "message.delta", native: at("m2"), text: "first try" });
      return { status: "failed" as const, error: "try again" };
    }
    // The retry reuses the first attempt's native message id, and the first attempt's sink speaks late.
    sinks[0]!.observe({ type: "message.delta", native: at("m2"), text: " (late, from attempt 1)" });
    const withdrawn = new AbortController();
    const asked = sink.approval({ question: "Allow Bash: $ deploy?", canAlways: false }, withdrawn.signal);
    withdrawn.abort(); // the CLI settles the request itself before anyone answers
    decisions.push(`withdrawn:${await asked}`);
    sink.observe({ type: "message.start", native: at("m2"), phase: "final" });
    sink.observe({ type: "message.delta", native: at("m2"), text: "second try" });
    sink.observe({ type: "message.done", native: at("m2") });
    return { status: "completed" as const };
  } };
  const runner = new ThreadRunner({ home, store, backends: { claude: backend }, emit });
  const host = new DesktopHost(home, { version: "test", channels: () => [], async invoke() { return null; }, journal: () => live });
  live.subscribe((entries) => host.broadcastJournal(entries));
  const companion = new CompanionServer(home, { state: () => store.snapshot(), items: (id) => runner.items(id), status: (id) => runner.status(id),
    send: async () => ({ ok: true }), answer: () => {}, journal: () => live }, () => ["127.0.0.1"], () => () => {});
  const client = new DesktopClient(() => {});
  const connections: boolean[] = [];
  client.on("connected", ({ resumed }: { resumed: boolean }) => connections.push(resumed));
  let desktop: ThreadItem[] = [];
  let restarted: ThreadRunner | undefined;
  try {
    const thread = await runner.createThread(project.id, { backend: "claude", auto: false });
    store.updateThread(thread.id, { title: "Fixture", titleSource: "manual" });
    client.on("thread", (event: ThreadEvent) => { if (event.threadId === thread.id) desktop = apply(desktop, event); });
    await host.start();
    const pairingUri = (await companion.start()).pairingUri!;
    await client.pair(host.invite(), "a".repeat(64));
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    desktop = structuredClone(runner.items(thread.id));

    // Attempt 1 waits on its approval: the phone loads, and the desktop sleeps through the rest.
    const turn = runner.send(thread.id, "clean up");
    await until(() => runner.items(thread.id).some((item) => item.kind === "approval"));
    const mid = await phoneSnapshot(pairingUri, home, thread.id);
    client.suspend();
    const card = runner.items(thread.id).find((item) => item.kind === "approval")!;
    runner.answer(thread.id, card.id, "yes");
    runner.answer(thread.id, card.id, "yes"); // a second click, or the phone's answer arriving late
    await turn;
    await runner.retry(thread.id);
    client.resume();
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    live.flush();
    coalesced.flush();

    const saved = new Store(home).items(thread.id);
    const fromLive = live.since(0, { threadId: thread.id });
    const fromBatched = coalesced.since(0, { threadId: thread.id });
    // Memory can hold keys set to undefined, such as a failure card's empty debug fields; the files and every
    // client see items through JSON, so the live projection is compared the same way.
    const wire = (items: ThreadItem[]) => JSON.parse(JSON.stringify(items)) as ThreadItem[];
    assert.deepEqual(wire(runner.items(thread.id)), saved, "the live projection is what a journal-off reload loads");
    assert.deepEqual(wire(replayItems(emitted, thread.id)), saved, "the live event stream folds to it");
    assert.deepEqual(replayItems(fromLive, thread.id), saved, "the journal replays to it");
    assert.deepEqual(replayItems([...fromLive, ...fromLive], thread.id), saved, "and replaying it twice changes nothing");
    assert.ok(fromBatched.length < fromLive.length, "the batched journal really coalesced");
    assert.deepEqual(replayItems(fromBatched, thread.id), saved, "the batched journal replays to it too");
    assert.deepEqual(connections, [false, true], "the desktop resumed after its sleep");
    await until(() => JSON.stringify(desktop) === JSON.stringify(saved));
    const delta = await phoneSnapshot(pairingUri, home, thread.id, mid.journal);
    assert.equal(delta.delta, true);
    assert.deepEqual(merge(mid.items, delta.items), JSON.parse(JSON.stringify(saved.map(mobileItem))), "the phone's mid-run snapshot plus its delta matches a full one");

    // What the transcript says, on every path above.
    const cards = saved.filter((item) => item.kind === "approval") as (ThreadItem & { answer?: string; withdrawn?: string })[];
    assert.deepEqual(cards.map((item) => [item.answer, Boolean(item.withdrawn)]), [["yes", false], ["no", true]], "an answered card and a withdrawn one, through coalescing");
    const tools = saved.filter((item) => item.kind === "tool") as (ThreadItem & { status: string; outcome?: string })[];
    assert.deepEqual(tools.map((item) => [item.status, item.outcome]), [["done", "succeeded"], ["done", "succeeded"]], "a late update never reopens a finished tool");
    const answers = saved.filter((item) => item.kind === "assistant") as (ThreadItem & { text: string; outcome?: string })[];
    assert.deepEqual(answers.map((item) => [item.text, item.outcome]), [["Looking first.", "succeeded"], ["first try", "unknown"], ["second try", "succeeded"]], "the old attempt's late text reaches no item");

    // Nothing ran or answered more than the user asked, through replay, reconnects and a restart.
    restarted = new ThreadRunner({ home, store: new Store(home), backends: { claude: backend }, emit: () => {} });
    assert.deepEqual(wire(restarted.items(thread.id)), saved, "a restarted Modex loads the same transcript");
    assert.equal(runs, 2, "two attempts ran: the turn and its retry");
    assert.deepEqual(decisions, ["yes", "withdrawn:no"], "the CLI heard one answer, and the withdrawn request settled no");
  } finally {
    client.dispose();
    await companion.dispose();
    await host.dispose();
    await restarted?.dispose();
    await runner.dispose();
    live.close();
    coalesced.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
