import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { once } from "node:events";
import { EventJournal, replayItems } from "../src/main/engine/event-journal.js";
import { DesktopHost } from "../src/main/engine/desktop-host.js";
import { DesktopClient } from "../src/main/engine/desktop-client.js";
import { CompanionServer, mobileItem } from "../src/main/engine/companion.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import type { Backend, TurnSink } from "../src/main/engine/backends/types.js";
import type { ApprovalAnswer, ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { FakeProcess, fakeSpawn } from "./fakeproc.js";
import { gitRepo, tmpdir } from "./helpers.js";

/**
 * The human-request lifecycle through the event journal, snapshots, paired desktops and the phone
 * (docs/human-requests.md, CF-6 #279): a card says who answered and whether the answer reached the CLI,
 * replay and reconnect show it inert, nothing re-sends an answer, and a secret answer reaches no file.
 */

const waitFor = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };
type Card = ThreadItem & { answer?: string; answers?: Record<string, string[]>; answeredBy?: string; delivery?: string; withdrawn?: string };
const card = (items: ThreadItem[], kind: "approval" | "question" = "approval") => items.find((i) => i.kind === kind) as Card;
const lifecycle = (c: Card) => ({ answer: c.answer ?? null, answeredBy: c.answeredBy ?? null, delivery: c.delivery ?? null, withdrawn: c.withdrawn ?? null });

/** A Claude-shaped backend whose turn asks one approval and records every decision it hears. */
function asking(heard: ApprovalAnswer[]): Backend {
  return { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink: TurnSink) {
    const native = { runtime: "journal-fixture", request: "approval" };
    heard.push(await sink.approval({ native, question: "Allow Bash: $ deploy?", canAlways: false, action: { backend: "claude", tool: "Bash", title: "$ deploy", input: { command: "deploy" } } }));
    await sink.deliverRequest?.(native, async () => {});
    return { status: "completed" };
  } };
}

async function harness(backend: Backend) {
  const home = tmpdir("modex-request-journal-");
  const store = new Store(home);
  const journal = new EventJournal(path.join(home, "app", "events.sqlite"), { flushMs: 5 });
  const events: ThreadEvent[] = [];
  const runner = new ThreadRunner({ home, store, emit: (event) => { events.push(event); journal.record(event); }, backends: { [backend.id]: backend } });
  const project = store.addProject(gitRepo());
  const thread = await runner.createThread(project.id, { backend: backend.id, auto: false });
  store.updateThread(thread.id, { title: "Fixture", titleSource: "manual" });
  return { home, store, journal, runner, thread, events };
}

/** Pairs a phone with the Mac's companion and returns its HTTPS requests, made as the iPhone app makes them. */
async function phone(companion: CompanionServer, home: string) {
  const pairing = JSON.parse(Buffer.from(new URL((await companion.start()).pairingUri!).searchParams.get("data")!, "base64url").toString()) as { url: string; token: string; fingerprint: string };
  return (route: string, method = "GET", body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = https.request(new URL(route, pairing.url), {
      method, headers: { authorization: `Bearer ${pairing.token}`, ...(body ? { "content-type": "application/json" } : {}) },
      ca: fs.readFileSync(path.join(home, "companion", "cert.pem")),
      checkServerIdentity: (_host, cert) => crypto.createHash("sha256").update(cert.raw).digest("hex") === pairing.fingerprint ? undefined : new Error("unpinned"),
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test("an answered approval journals who answered and that it reached the CLI; replay, even twice, and a restart keep it inert", async () => {
  const heard: ApprovalAnswer[] = [];
  const h = await harness(asking(heard));
  try {
    const sent = h.runner.send(h.thread.id, "deploy");
    await waitFor(() => Boolean(card(h.runner.items(h.thread.id))));
    const open = card(h.runner.items(h.thread.id));
    assert.deepEqual(h.runner.answer(h.thread.id, open.id, "yes"), { ok: true });
    await sent;
    const expected = { answer: "yes", answeredBy: "desktop", delivery: "sent", withdrawn: null };
    assert.deepEqual(lifecycle(card(h.runner.items(h.thread.id))), expected, "this window");
    assert.deepEqual(lifecycle(card(new Store(h.home).items(h.thread.id))), expected, "the saved snapshot");
    h.journal.flush();
    const rows = h.journal.since(0, { threadId: h.thread.id });
    assert.deepEqual(lifecycle(card(replayItems(rows, h.thread.id))), expected, "journal replay");
    assert.deepEqual(lifecycle(card(replayItems([...rows, ...rows], h.thread.id))), expected, "every frame delivered twice");
    const onPhone = mobileItem(card(h.runner.items(h.thread.id))) as Record<string, unknown>;
    assert.deepEqual([onPhone.answer, onPhone.answeredBy, onPhone.delivery], ["yes", "desktop", "sent"], "the phone");

    // Restart: the card stays answered, a late answer is refused, and the CLI hears nothing more.
    await h.runner.dispose();
    const fresh = new ThreadRunner({ home: h.home, store: new Store(h.home), emit: () => {}, backends: { claude: asking(heard) } });
    assert.deepEqual(lifecycle(card(fresh.items(h.thread.id))), expected);
    assert.deepEqual(fresh.answer(h.thread.id, open.id, "no", "phone"), { ok: false, reason: "already-resolved" });
    assert.deepEqual(heard, ["yes"]);
    await fresh.dispose();
  } finally { await h.runner.dispose(); h.journal.close(); }
});

test("simultaneous answers from the desktop and the phone: exactly one is accepted, the other is refused, and the CLI hears one decision", async () => {
  const heard: ApprovalAnswer[] = [];
  const h = await harness(asking(heard));
  const companion = new CompanionServer(h.home, { state: () => h.store.snapshot(), items: (id) => h.runner.items(id), status: (id) => h.runner.status(id),
    send: async () => ({ ok: true }), answer: (id, item, value, by) => h.runner.answer(id, item, value, by), journal: () => h.journal }, () => ["127.0.0.1"], () => () => {});
  try {
    const request = await phone(companion, h.home);
    const sent = h.runner.send(h.thread.id, "deploy");
    await waitFor(() => Boolean(card(h.runner.items(h.thread.id))) && h.runner.status(h.thread.id) === "waiting");
    const open = card(h.runner.items(h.thread.id));
    // The phone's request is in flight while the desktop answers.
    const fromPhone = request(`/v1/threads/${h.thread.id}/answer`, "POST", { itemId: open.id, answer: "no" });
    const fromDesktop = h.runner.answer(h.thread.id, open.id, "yes");
    const phoneResult = await fromPhone;
    await sent;
    const accepted = [fromDesktop.ok, phoneResult.status === 200].filter(Boolean).length;
    assert.equal(accepted, 1, "exactly one answer is accepted");
    assert.equal(heard.length, 1, "the CLI hears one decision");
    const winner = fromDesktop.ok ? "desktop" : "phone";
    assert.equal(fromDesktop.ok ? phoneResult.status : 200, fromDesktop.ok ? 409 : 200, "the phone's losing answer is a 409");
    assert.deepEqual(lifecycle(card(h.runner.items(h.thread.id))), { answer: heard[0], answeredBy: winner, delivery: "sent", withdrawn: null });
    h.journal.flush();
    assert.equal(card(replayItems(h.journal.since(0, { threadId: h.thread.id }), h.thread.id)).answeredBy, winner, "the journal names the winner");
    const snapshot = await request(`/v1/snapshot?threadId=${h.thread.id}`);
    assert.deepEqual([snapshot.body.items.find((i: { id: string }) => i.id === open.id).answeredBy], [winner]);
  } finally { await companion.dispose(); await h.runner.dispose(); h.journal.close(); }
});

test("a paired desktop that reconnects after the decision was sent sees the card answered, and its stale answer is refused", async () => {
  const heard: ApprovalAnswer[] = [];
  const h = await harness(asking(heard));
  const host = new DesktopHost(h.home, { version: "test", channels: () => [], async invoke() { return null; }, journal: () => h.journal });
  h.journal.subscribe((entries) => host.broadcastJournal(entries));
  const client = new DesktopClient(() => {});
  const connections: boolean[] = [];
  client.on("connected", ({ resumed }: { resumed: boolean }) => connections.push(resumed));
  // The paired desktop's transcript: every thread event it received, applied as the window applies them.
  const received: ThreadEvent[] = [];
  let desktop: ThreadItem[] = [];
  client.on("thread", (event: ThreadEvent) => { received.push(event); desktop = replayItems(received, h.thread.id); });
  try {
    await host.start();
    await client.pair(host.invite(), "a".repeat(64));
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    const sent = h.runner.send(h.thread.id, "deploy");
    await waitFor(() => Boolean(card(desktop)));
    assert.deepEqual(lifecycle(card(desktop)), { answer: null, answeredBy: null, delivery: null, withdrawn: null }, "the paired desktop sees the open card");
    client.suspend();
    assert.deepEqual(h.runner.answer(h.thread.id, card(desktop).id, "yes"), { ok: true });
    await sent;
    client.resume();
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(connections, [false, true], "the wake-up resumed");
    await waitFor(() => card(desktop).delivery === "sent");
    assert.deepEqual(lifecycle(card(desktop)), { answer: "yes", answeredBy: "desktop", delivery: "sent", withdrawn: null });
    assert.deepEqual(h.runner.answer(h.thread.id, card(desktop).id, "no"), { ok: false, reason: "already-resolved" }, "a click from before the sleep");
    assert.deepEqual(heard, ["yes"], "no second native decision");
  } finally { client.dispose(); await host.dispose(); await h.runner.dispose(); h.journal.close(); }
});

test("an expired cursor reloads to a snapshot whose card says who answered and that it was sent", async () => {
  const heard: ApprovalAnswer[] = [];
  const h = await harness(asking(heard));
  try {
    const sent = h.runner.send(h.thread.id, "deploy");
    await waitFor(() => Boolean(card(h.runner.items(h.thread.id))));
    h.journal.flush();
    const cursor = h.journal.since(0).at(-1)!.seq;
    h.runner.answer(h.thread.id, card(h.runner.items(h.thread.id)).id, "no", "phone");
    await sent;
    h.journal.flush();
    (h.journal as unknown as { retention: { maxAgeMs: number; maxRows: number } }).retention = { maxAgeMs: 60_000, maxRows: 1 };
    h.journal.prune();
    assert.equal(h.journal.resume(h.journal.id, cursor, { threadId: h.thread.id }).entries, undefined, "the cursor must reload");
    assert.deepEqual(lifecycle(card(h.runner.items(h.thread.id))), { answer: "no", answeredBy: "phone", delivery: "sent", withdrawn: null });
    assert.deepEqual(heard, ["no"]);
  } finally { await h.runner.dispose(); h.journal.close(); }
});

test("an answer accepted but not yet recorded as sent when Modex died is uncertain after a restart, inert, and never sent again", async () => {
  let ran = 0;
  const backend: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, runTurn: async () => { ran++; return { status: "completed" }; } };
  const h = await harness(backend);
  const at = "2026-10-18T10:00:00.000Z";
  h.store.saveItems(h.thread.id, [
    { id: "u", kind: "user", text: "deploy", at },
    { id: "a", kind: "approval", question: "Allow Bash: $ deploy?", canAlways: false, answer: "yes", answeredBy: "phone", delivery: "sending", at },
    { id: "q", kind: "question", questions: [{ id: "q1", header: "Env", text: "Which?", options: null, allowOther: true, secret: false }], blocking: true, answers: { q1: ["staging"] }, answeredBy: "desktop", delivery: "sending", at },
    { id: "old", kind: "approval", question: "Allow Bash: $ ls?", answer: "yes", at },
  ] as ThreadItem[]);
  await h.runner.dispose();
  const events: ThreadEvent[] = [];
  const fresh = new ThreadRunner({ home: h.home, store: new Store(h.home), emit: (e) => events.push(e), backends: { claude: backend } });
  try {
    const items = fresh.items(h.thread.id);
    assert.deepEqual(lifecycle(card(items)), { answer: "yes", answeredBy: "phone", delivery: "uncertain", withdrawn: null });
    assert.equal(card(items, "question").delivery, "uncertain");
    assert.deepEqual(lifecycle(items.find((i) => i.id === "old") as Card), { answer: "yes", answeredBy: null, delivery: null, withdrawn: null }, "an answer saved before delivery was recorded stays as it was");
    assert.deepEqual(new Store(h.home).items(h.thread.id).flatMap((i) => (i as Card).delivery ?? []), ["uncertain", "uncertain"], "saved for the next process");
    assert.deepEqual(events.map((e) => e.type === "item_update" ? [e.id, e.patch] : [e.type]), [["a", { delivery: "uncertain" }], ["q", { delivery: "uncertain" }]], "and sent to every client");
    assert.deepEqual(fresh.answer(h.thread.id, "a", "no"), { ok: false, reason: "already-resolved" });
    assert.deepEqual(fresh.answerQuestion(h.thread.id, "q", { q1: ["production"] }), { ok: false, reason: "already-resolved" });
    assert.equal(ran, 0, "nothing runs or re-sends");
  } finally { await fresh.dispose(); h.journal.close(); }
});

/** A Codex app-server whose turn asks one requestUserInput question (codex-cli 0.163.0 shape) and finishes when answered. */
function codexAsking(proc: FakeProcess) {
  const replies: unknown[] = [];
  proc.stdin.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; result?: unknown; error?: unknown };
      if (msg.method === "initialize") proc.emitLine({ id: msg.id, result: { userAgent: "fake" } });
      else if (msg.method === "thread/start") proc.emitLine({ id: msg.id, result: { thread: { id: "thr" } } });
      else if (msg.method === "turn/start") {
        proc.emitLine({ id: msg.id, result: { turn: { id: "tu" } } });
        proc.emitLine({ method: "turn/started", params: { threadId: "thr", turn: { id: "tu" } } });
        proc.emitLine({ id: 7, method: "item/tool/requestUserInput", params: { threadId: "thr", turnId: "tu", itemId: "ask-1", isBlocking: true, autoResolutionMs: null, questions: [
          { id: "q-env", header: "Environment", question: "Which environment?", isOther: false, isSecret: false, options: [{ label: "staging", description: "" }, { label: "production", description: "" }] },
          { id: "q-token", header: "Token", question: "Paste the deploy token", isOther: true, isSecret: true, options: null },
        ] } });
      } else if (msg.id === 7 && !msg.method) {
        replies.push(msg.result ?? { error: msg.error });
        setImmediate(() => proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } }));
      }
    }
  });
  return replies;
}

/** Every file under `dir`, read as bytes and joined: SQLite pages, its WAL, state and thread files alike. */
const everything = (dir: string): string => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile()).map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name)).toString("latin1")).join("\n");

test("with the journal on, a secret answer reaches the CLI and no file, snapshot, phone view or event", async () => {
  const proc = new FakeProcess();
  const replies = codexAsking(proc);
  const codex = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const h = await harness(codex);
  const companion = new CompanionServer(h.home, { state: () => h.store.snapshot(), items: (id) => h.runner.items(id), status: (id) => h.runner.status(id),
    send: async () => ({ ok: true }), answer: () => {}, journal: () => h.journal }, () => ["127.0.0.1"], () => () => {});
  const secret = "tok-7f3a9c-SECRET";
  try {
    const request = await phone(companion, h.home);
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => Boolean(card(h.runner.items(h.thread.id), "question")));
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, card(h.runner.items(h.thread.id), "question").id, { "q-env": ["staging"], "q-token": [secret] }), { ok: true });
    await sent;
    assert.deepEqual(replies, [{ answers: { "q-env": { answers: ["staging"] }, "q-token": { answers: [secret] } } }], "the CLI got it");
    const answered = card(h.runner.items(h.thread.id), "question");
    assert.deepEqual([answered.answers, answered.answeredBy, answered.delivery], [{ "q-env": ["staging"], "q-token": ["(hidden)"] }, "desktop", "sent"]);
    h.journal.flush();
    const onPhone = JSON.stringify((await request(`/v1/snapshot?threadId=${h.thread.id}`)).body);
    for (const [where, text] of [["a file under MODEX_HOME", everything(h.home)], ["an emitted event", JSON.stringify(h.events)], ["the phone", onPhone]] as const) {
      assert.ok(!text.includes(secret), `the secret is not in ${where}`);
    }
  } finally { await companion.dispose(); await h.runner.dispose(); await codex.dispose(); h.journal.close(); }
});
