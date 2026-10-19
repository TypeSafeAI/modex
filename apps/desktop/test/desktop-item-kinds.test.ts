import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { once } from "node:events";
import { DesktopHost } from "../src/main/engine/desktop-host.js";
import { DesktopClient, type DesktopCredentials } from "../src/main/engine/desktop-client.js";
import { DESKTOP_PROTOCOL } from "../src/shared/desktop-protocol.js";
import type { JournalEntry } from "../src/main/engine/event-journal.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";

/**
 * Item kinds a paired desktop cannot draw (CF-6 #279, finding 6). Store builds cut before CF-3, such as
 * TestFlight Store 0.0.8, have no `question` or `plan` in their renderer and show nothing for one, so a
 * thread looks stuck. A current client names the kinds it draws; the host sends one that names none any
 * other kind as a notice it can read, through every path a transcript reaches it.
 */

const at = "2026-10-19T10:00:00.000Z";
const question = { id: "q", kind: "question", blocking: true, at,
  questions: [{ id: "env", header: "Env", text: "Which environment?", options: null, allowOther: true, secret: false }] } as ThreadItem;
const plan = { id: "p", kind: "plan", from: "native", revision: 1, at,
  steps: [{ text: "Read the config", status: "completed" }, { text: "Deploy", status: "pending" }] } as unknown as ThreadItem;
const reply = { id: "a", kind: "assistant", text: "Checking.", at } as ThreadItem;

async function connected(client: DesktopClient): Promise<void> {
  if (client.status().state === "connected") return;
  await once(client, "connected", { signal: AbortSignal.timeout(5000) });
}

/** Requests made the way Store builds before CF-3 make them: same token and protocol, no item kinds. */
function legacy(credentials: DesktopCredentials) {
  const options = (route: string, method: string) => ({ hostname: "127.0.0.1", port: credentials.port, path: route, method, rejectUnauthorized: false,
    headers: { Authorization: `Bearer ${credentials.token}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) } });
  const invoke = (channel: string, payload: unknown) => new Promise<unknown>((resolve, reject) => {
    const req = https.request(options("/invoke", "POST"), (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve((JSON.parse(text) as { value: unknown }).value));
    });
    req.on("error", reject);
    req.end(JSON.stringify({ channel, payload, protocol: DESKTOP_PROTOCOL }));
  });
  /** Opens the event stream and collects each thread event it carries. */
  const events = (route = "/events") => new Promise<{ thread: ThreadEvent[]; close: () => void }>((resolve, reject) => {
    const thread: ThreadEvent[] = [];
    const req = https.get(options(route, "GET"), (res) => {
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (/^event: connected$/m.test(frame)) resolve({ thread, close: () => req.destroy() });
          else if (/^event: thread$/m.test(frame) && data) thread.push(JSON.parse(data) as ThreadEvent);
        }
      });
    });
    req.on("error", reject);
  });
  return { invoke, events };
}

const waitFor = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };
const noticeOf = (item: ThreadItem | undefined) => item as (ThreadItem & { kind: "notice"; text: string }) | undefined;

test("a paired desktop that names no item kinds gets a question or a plan as a notice; a current one gets them as they are", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-desktop-kinds-"));
  const items: ThreadItem[] = [reply, question, plan];
  let credentials: DesktopCredentials | undefined;
  const client = new DesktopClient((value) => { credentials = value; });
  const source = { version: "0.2.0", channels: () => ["thread:items"],
    async invoke(channel: string) { return channel === "thread:items" ? items : undefined; },
    item: (_threadId: string, id: string) => items.find((item) => item.id === id) };
  const host = new DesktopHost(home, source);
  let stream: { thread: ThreadEvent[]; close: () => void } | undefined;
  try {
    await host.start();
    await client.pair(host.invite(), "a".repeat(64)); await connected(client);
    const old = legacy(credentials!);

    // A thread's transcript, as each client loads it.
    assert.deepEqual(await client.invoke("thread:items", { threadId: "t1" }), items, "a current client gets every kind unchanged");
    const loaded = await old.invoke("thread:items", { threadId: "t1" }) as ThreadItem[];
    assert.deepEqual(loaded[0], reply, "a kind it draws is unchanged");
    assert.deepEqual(loaded.map((item) => [item.id, item.kind]), [["a", "assistant"], ["q", "notice"], ["p", "notice"]]);
    assert.match(noticeOf(loaded[1])!.text, /Which environment\?/);
    assert.match(noticeOf(loaded[1])!.text, /answer it/i, "it says where to answer");
    assert.match(noticeOf(loaded[2])!.text, /Plan · 1 of 2 reported done/);

    // Live events: a new question, then its answer.
    stream = await old.events();
    const live = once(client, "thread", { signal: AbortSignal.timeout(2000) });
    host.broadcast("thread", { threadId: "t1", type: "item", item: question });
    assert.deepEqual((await live)[0], { threadId: "t1", type: "item", item: question });
    await waitFor(() => stream!.thread.length === 1);
    const shown = stream.thread[0] as Extract<ThreadEvent, { type: "item" }>;
    assert.deepEqual([shown.item.id, shown.item.kind], ["q", "notice"]);

    items[1] = { ...question, answers: { env: ["staging"] }, answeredBy: "desktop", delivery: "sent" } as ThreadItem;
    const patch = { answers: { env: ["staging"] }, answeredBy: "desktop", delivery: "sent" } as Partial<ThreadItem>;
    const answered = once(client, "thread", { signal: AbortSignal.timeout(2000) });
    host.broadcast("thread", { threadId: "t1", type: "item_update", id: "q", patch });
    assert.deepEqual((await answered)[0], { threadId: "t1", type: "item_update", id: "q", patch });
    await waitFor(() => stream!.thread.length === 2);
    const update = stream.thread[1] as Extract<ThreadEvent, { type: "item" }>;
    assert.equal(update.type, "item", "an update to an item it cannot draw arrives as the whole notice, which it replaces by id");
    assert.match(noticeOf(update.item)!.text, /Answered/);

    // An update to a kind it draws is unchanged.
    host.broadcast("thread", { threadId: "t1", type: "item_update", id: "a", patch: { text: "Checking. Done." } });
    await waitFor(() => stream!.thread.length === 3);
    assert.deepEqual(stream.thread[2], { threadId: "t1", type: "item_update", id: "a", patch: { text: "Checking. Done." } });
  } finally { stream?.close(); client.dispose(); await host.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("journal replay and journaled events reach a paired desktop that names no item kinds as notices too", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-desktop-kinds-journal-"));
  const entries: JournalEntry[] = [{ seq: 1, at, event: { threadId: "t1", type: "item", item: question } }];
  let credentials: DesktopCredentials | undefined;
  const client = new DesktopClient((value) => { credentials = value; });
  const source = { version: "0.2.0", channels: () => [], async invoke() {},
    journal: () => ({ resume: (id?: string, after?: number) => id === "j" && after !== undefined ? { id: "j", latest: 1, entries: entries.filter((e) => e.seq > after) } : { id: "j", latest: 1 } }),
    item: () => question };
  const host = new DesktopHost(home, source);
  let stream: { thread: ThreadEvent[]; close: () => void } | undefined;
  try {
    await host.start();
    await client.pair(host.invite(), "a".repeat(64)); await connected(client);
    stream = await legacy(credentials!).events("/events?journal=j&after=0");
    await waitFor(() => stream!.thread.length === 1);
    const replayed = stream.thread[0] as Extract<ThreadEvent, { type: "item" }>;
    assert.deepEqual([replayed.item.id, replayed.item.kind], ["q", "notice"], "replay");
    host.broadcastJournal([{ seq: 2, at, event: { threadId: "t1", type: "item", item: plan } }]);
    await waitFor(() => stream!.thread.length === 2);
    assert.deepEqual([(stream.thread[1] as Extract<ThreadEvent, { type: "item" }>).item.kind], ["notice"], "a journaled event");
  } finally { stream?.close(); client.dispose(); await host.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});
