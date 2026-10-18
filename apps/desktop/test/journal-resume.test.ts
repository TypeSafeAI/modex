import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { once } from "node:events";
import { EventJournal } from "../src/main/engine/event-journal.js";
import { DesktopHost } from "../src/main/engine/desktop-host.js";
import { DesktopClient } from "../src/main/engine/desktop-client.js";
import { CompanionServer } from "../src/main/engine/companion.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { MockBackend } from "../src/main/engine/backends/mock.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import type { MockStep } from "@modex/core";
import { gitRepo, tmpdir, writeScript } from "./helpers.js";

type Phone = { id: string; kind: string; text?: string; status?: string };
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
