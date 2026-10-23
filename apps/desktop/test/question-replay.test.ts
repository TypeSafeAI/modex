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
import { CompanionServer } from "../src/main/engine/companion.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import type { Backend } from "../src/main/engine/backends/types.js";
import type { ThreadEvent, ThreadItem } from "../src/shared/types.js";
import { FakeProcess, fakeSpawn } from "./fakeproc.js";
import { gitRepo, tmpdir } from "./helpers.js";

/**
 * A structured question across replay and reconnect (CF-6 #279, on CF-3's phone answers #373): a phone or
 * paired desktop that was away while the question was answered, withdrawn or stopped catches up through the
 * journal, or reloads when its cursor cannot be trusted, and finds the card closed. Nothing it does afterwards
 * reaches Codex, which hears exactly one reply per question, and a secret answer reaches no client or file.
 */

const waitFor = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };
type Card = ThreadItem & { kind: "question"; answers?: Record<string, string[]>; answeredBy?: string; delivery?: string; withdrawn?: string };
const question = (items: ThreadItem[]) => items.find((i) => i.kind === "question") as Card | undefined;
const lifecycle = (c: { answers?: unknown; answeredBy?: unknown; delivery?: unknown; withdrawn?: unknown }) =>
  ({ answers: c.answers ?? null, answeredBy: c.answeredBy ?? null, delivery: c.delivery ?? null, withdrawn: c.withdrawn ?? null });

/** The phone's item kinds, as the iPhone app that draws question cards names them. */
const PHONE_KINDS = "user,assistant,approval,tool,notice,question";
const SECRET = "replay-tok-5e1d-SECRET";

/**
 * A Codex app-server (codex-cli 0.163.0 shapes) whose turn asks one requestUserInput question, one of them secret.
 * It finishes the turn when answered; `withdraw()` settles the question itself, as Codex does with serverRequest/resolved.
 */
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
        if (msg.result) setImmediate(() => proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } }));
      }
    }
  });
  return {
    replies,
    withdraw() {
      proc.emitLine({ method: "serverRequest/resolved", params: { threadId: "thr", requestId: 7 } });
      setImmediate(() => proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "completed", error: null } } }));
    },
    interrupted() { proc.emitLine({ method: "turn/completed", params: { threadId: "thr", turn: { id: "tu", status: "interrupted", error: null } } }); },
  };
}

async function harness(opts: { flushMs?: number; home?: string } = {}) {
  const proc = new FakeProcess();
  const codex = codexAsking(proc);
  const backend = new CodexBackend("codex", fakeSpawn(proc).spawn);
  const home = opts.home ?? tmpdir("modex-question-replay-");
  const store = new Store(home);
  const journal = new EventJournal(path.join(home, "app", "events.sqlite"), { flushMs: opts.flushMs ?? 5 });
  const events: ThreadEvent[] = [];
  const runner = new ThreadRunner({ home, store, emit: (event) => { events.push(event); journal.record(event); }, backends: { codex: backend } });
  const thread = await runner.createThread(store.addProject(gitRepo()).id, { backend: "codex", auto: false });
  store.updateThread(thread.id, { title: "Fixture", titleSource: "manual" });
  return { home, store, journal, runner, thread, events, proc, codex, backend };
}

/** A companion wired as the Mac wires it, over this process's runner and journal (none when `journal` is false). */
function companionOver(home: string, store: Store, runner: ThreadRunner, journal: EventJournal | undefined) {
  return new CompanionServer(home, { state: () => store.snapshot(), items: (id) => runner.items(id), status: (id) => runner.status(id),
    send: async () => ({ ok: true }), answer: (id, item, value, by) => runner.answer(id, item, value, by),
    answerQuestion: (id, item, answers, by) => runner.answerQuestion(id, item, answers, by), journal: () => journal }, () => ["127.0.0.1"], () => () => {});
}

/** Pairs with the companion and returns the HTTPS requests a phone makes, naming `kinds` as the iPhone app does. */
async function phone(companion: CompanionServer, home: string, kinds?: string) {
  const pairing = JSON.parse(Buffer.from(new URL((await companion.start()).pairingUri!).searchParams.get("data")!, "base64url").toString()) as { url: string; token: string; fingerprint: string };
  const request = (route: string, method = "GET", body?: unknown) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = https.request(new URL(route, pairing.url), {
      method, headers: { authorization: `Bearer ${pairing.token}`, ...(kinds ? { "x-modex-item-kinds": kinds } : {}), ...(body ? { "content-type": "application/json" } : {}) },
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
  return request;
}

const snapshotRoute = (threadId: string, cursor?: { id: string; cursor: number }) =>
  `/v1/snapshot?threadId=${threadId}${cursor ? `&journal=${cursor.id}&after=${cursor.cursor}` : ""}`;

/** How each way a question closes while the phone is away looks on the Mac, on a phone that draws it and on one that does not. */
const ENDINGS = {
  answered: {
    close: (h: Awaited<ReturnType<typeof harness>>, id: string) => {
      assert.deepEqual(h.runner.answerQuestion(h.thread.id, id, { "q-env": ["staging"], "q-token": [SECRET] }), { ok: true });
    },
    card: { answers: { "q-env": ["staging"], "q-token": ["(hidden)"] }, answeredBy: "desktop", delivery: "sent", withdrawn: null },
    refusal: "already-resolved",
    legacy: "Answered on your Mac.",
    codex: (replies: unknown[]) => assert.deepEqual(replies, [{ answers: { "q-env": { answers: ["staging"] }, "q-token": { answers: [SECRET] } } }]),
  },
  withdrawn: {
    close: (h: Awaited<ReturnType<typeof harness>>) => h.codex.withdraw(),
    card: { answers: null, answeredBy: null, delivery: null, withdrawn: "native" },
    refusal: "withdrawn",
    legacy: "Not answered.",
    codex: (replies: unknown[]) => assert.deepEqual(replies, [], "Codex settled it itself, so nothing is sent"),
  },
  stopped: {
    close: (h: Awaited<ReturnType<typeof harness>>) => { h.runner.stop(h.thread.id); },
    card: { answers: null, answeredBy: null, delivery: null, withdrawn: "stopped" },
    refusal: "withdrawn",
    legacy: "Not answered.",
    codex: (replies: unknown[]) => { assert.equal(replies.length, 1); assert.ok("error" in (replies[0] as object), "only the withdrawal error, never an answer"); },
  },
} as const;

for (const [ending, expect] of Object.entries(ENDINGS)) {
  test(`a question ${ending} while the phone was away: its journal delta closes the card, and nothing the phone does reaches Codex`, async () => {
    const h = await harness();
    const companion = companionOver(h.home, h.store, h.runner, h.journal);
    try {
      const drawing = await phone(companion, h.home, PHONE_KINDS);
      const legacy = await phone(companion, h.home);
      const sent = h.runner.send(h.thread.id, "deploy it");
      await waitFor(() => Boolean(question(h.runner.items(h.thread.id))) && h.runner.status(h.thread.id) === "waiting");
      const open = question(h.runner.items(h.thread.id))!;
      h.journal.flush();
      const before = await drawing(snapshotRoute(h.thread.id));
      const beforeLegacy = await legacy(snapshotRoute(h.thread.id));
      const seen = before.body.items.find((i: { id: string }) => i.id === open.id);
      assert.deepEqual([seen.kind, lifecycle(seen)], ["question", { answers: null, answeredBy: null, delivery: null, withdrawn: null }], "the phone saw it open");

      // The phone sleeps. The question closes on the Mac.
      expect.close(h, open.id);
      if (ending === "stopped") { await waitFor(() => h.codex.replies.length === 1); h.codex.interrupted(); }
      await sent;
      h.journal.flush();

      const delta = await drawing(snapshotRoute(h.thread.id, before.body.journal));
      assert.equal(delta.body.delta, true, "a delta, not a reload");
      assert.deepEqual(delta.body.journal.id, before.body.journal.id);
      assert.ok(delta.body.journal.cursor > before.body.journal.cursor);
      const closed = delta.body.items.find((i: { id: string }) => i.id === open.id);
      assert.ok(closed, `the delta carries the card (items: ${delta.body.items.map((i: { id: string; kind: string }) => i.kind).join(",")})`);
      assert.deepEqual([closed.kind, lifecycle(closed)], ["question", expect.card]);
      assert.ok(!delta.body.items.some((i: { kind: string }) => i.kind === "user"), "only what changed after the cursor");

      // A phone that does not draw questions gets the same change as a notice that says how it closed.
      const legacyDelta = await legacy(snapshotRoute(h.thread.id, beforeLegacy.body.journal));
      const notice = legacyDelta.body.items.find((i: { id: string }) => i.id === open.id);
      assert.deepEqual([legacyDelta.body.delta, notice.kind, notice.text.split("\n").at(-1)], [true, "notice", expect.legacy]);

      // Taps queued from before the sleep: the drawn card's answer and the legacy approval route.
      const late = await drawing(`/v1/threads/${h.thread.id}/answer-question`, "POST", { itemId: open.id, answers: { "q-env": ["production"], "q-token": ["late"] } });
      assert.deepEqual([late.status, late.body.reason], [409, expect.refusal]);
      const legacyTap = await legacy(`/v1/threads/${h.thread.id}/answer`, "POST", { itemId: open.id, answer: "yes" });
      assert.equal(legacyTap.status, 409, "the approval route cannot answer a question");
      expect.codex(h.codex.replies);

      // Every view of the thread agrees, and none has the secret.
      const replayed = question(replayItems(h.journal.since(0, { threadId: h.thread.id }), h.thread.id))!;
      assert.deepEqual(lifecycle(replayed), lifecycle(question(h.runner.items(h.thread.id))!));
      assert.deepEqual(lifecycle(question(new Store(h.home).items(h.thread.id))!), lifecycle(replayed));
      const reloaded = await drawing(snapshotRoute(h.thread.id));
      assert.deepEqual(lifecycle(reloaded.body.items.find((i: { id: string }) => i.id === open.id)), expect.card, "a full snapshot agrees with the delta");
      for (const [where, text] of [["the delta", JSON.stringify(delta.body)], ["the legacy delta", JSON.stringify(legacyDelta.body)], ["the journal", JSON.stringify(h.journal.since(0))], ["an event", JSON.stringify(h.events)]] as const) {
        assert.ok(!text.includes(SECRET), `the secret is not in ${where}`);
      }
    } finally { await companion.dispose(); await h.runner.dispose(); await h.backend.dispose(); h.journal.close(); }
  });
}

test("a phone whose cursor is pruned, from another journal, or ahead of the log reloads to a closed card; without a journal it always gets the whole transcript", async () => {
  const h = await harness();
  const withJournal = companionOver(h.home, h.store, h.runner, h.journal);
  try {
    const request = await phone(withJournal, h.home, PHONE_KINDS);
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => Boolean(question(h.runner.items(h.thread.id))) && h.runner.status(h.thread.id) === "waiting");
    const open = question(h.runner.items(h.thread.id))!;
    h.journal.flush();
    const before = (await request(snapshotRoute(h.thread.id))).body.journal as { id: string; cursor: number };
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, open.id, { "q-env": ["staging"], "q-token": [SECRET] }, "phone"), { ok: true });
    await sent;
    h.journal.flush();
    const answered = { answers: { "q-env": ["staging"], "q-token": ["(hidden)"] }, answeredBy: "phone", delivery: "sent", withdrawn: null };

    const reloads = {
      "from another journal": { id: crypto.randomUUID(), cursor: before.cursor },
      "ahead of the log": { id: before.id, cursor: before.cursor + 10_000 },
    };
    for (const [why, cursor] of Object.entries(reloads)) {
      const poll = (await request(snapshotRoute(h.thread.id, cursor))).body;
      assert.equal(poll.delta, undefined, `a cursor ${why} reloads`);
      assert.ok(poll.items.some((i: { kind: string }) => i.kind === "user"), `the whole transcript, for a cursor ${why}`);
      assert.deepEqual(lifecycle(poll.items.find((i: { id: string }) => i.id === open.id)), answered);
    }
    (h.journal as unknown as { retention: { maxAgeMs: number; maxRows: number } }).retention = { maxAgeMs: 60_000, maxRows: 1 };
    h.journal.prune();
    const pruned = (await request(snapshotRoute(h.thread.id, before))).body;
    assert.equal(pruned.delta, undefined, "a pruned cursor reloads");
    assert.deepEqual(lifecycle(pruned.items.find((i: { id: string }) => i.id === open.id)), answered);
    const legacy = await phone(withJournal, h.home);
    const notice = (await legacy(snapshotRoute(h.thread.id, before))).body.items.find((i: { id: string }) => i.id === open.id);
    assert.deepEqual([notice.kind, notice.text.split("\n").at(-1)], ["notice", "Answered on your phone."], "a phone that does not draw questions is told where it was answered");
    await withJournal.dispose();

    const withoutJournal = companionOver(h.home, h.store, h.runner, undefined);
    try {
      const off = await phone(withoutJournal, h.home, PHONE_KINDS);
      const poll = (await off(snapshotRoute(h.thread.id, before))).body;
      assert.deepEqual([poll.journal, poll.delta], [undefined, undefined], "no cursor to keep, and no delta");
      assert.deepEqual(lifecycle(poll.items.find((i: { id: string }) => i.id === open.id)), answered);
    } finally { await withoutJournal.dispose(); }
    assert.equal(h.codex.replies.length, 1, "reloading sends nothing");
  } finally { await withJournal.dispose(); await h.runner.dispose(); await h.backend.dispose(); h.journal.close(); }
});

test("a paired desktop that slept while the phone answered resumes to the card answered on the phone, and its stale answer is refused", async () => {
  const h = await harness();
  const companion = companionOver(h.home, h.store, h.runner, h.journal);
  const host = new DesktopHost(h.home, { version: "test", channels: () => [], async invoke() { return null; }, journal: () => h.journal });
  h.journal.subscribe((entries) => host.broadcastJournal(entries));
  const client = new DesktopClient(() => {});
  const connections: boolean[] = [];
  client.on("connected", ({ resumed }: { resumed: boolean }) => connections.push(resumed));
  const received: ThreadEvent[] = [];
  let desktop: ThreadItem[] = [];
  client.on("thread", (event: ThreadEvent) => { received.push(event); desktop = replayItems(received, h.thread.id); });
  try {
    const request = await phone(companion, h.home, PHONE_KINDS);
    await host.start();
    await client.pair(host.invite(), "b".repeat(64));
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => Boolean(question(desktop)) && h.runner.status(h.thread.id) === "waiting");
    const open = question(desktop)!;
    assert.equal(open.kind, "question", "this build's paired desktop draws the card");
    client.suspend();
    const answered = await request(`/v1/threads/${h.thread.id}/answer-question`, "POST", { itemId: open.id, answers: { "q-env": ["production"], "q-token": [SECRET] } });
    assert.equal(answered.status, 200);
    await sent;
    client.resume();
    await once(client, "connected", { signal: AbortSignal.timeout(5000) });
    assert.deepEqual(connections, [false, true], "the wake-up resumed from its cursor");
    await waitFor(() => question(desktop)?.delivery === "sent");
    assert.deepEqual(lifecycle(question(desktop)!), { answers: { "q-env": ["production"], "q-token": ["(hidden)"] }, answeredBy: "phone", delivery: "sent", withdrawn: null });
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, open.id, { "q-env": ["staging"], "q-token": ["stale"] }), { ok: false, reason: "already-resolved" }, "a click from before the sleep");
    assert.deepEqual(h.codex.replies, [{ answers: { "q-env": { answers: ["production"] }, "q-token": { answers: [SECRET] } } }], "Codex hears the phone's answer once");
    assert.ok(!JSON.stringify(received).includes(SECRET), "the paired desktop never received the secret");
  } finally { client.dispose(); await host.dispose(); await companion.dispose(); await h.runner.dispose(); await h.backend.dispose(); h.journal.close(); }
});

/** A backend for the process after a crash: it counts turns, which must stay at zero. */
const counting = () => { const ran = { turns: 0 }; const backend: Backend = { id: "codex", listModels: async () => [], dispose: async () => {}, runTurn: async () => { ran.turns++; return { status: "completed" }; } }; return { ran, backend }; };

test("a crash inside the batch window after the phone's answer: the phone's old cursor reloads, the card says the phone answered, and nothing is sent again", async () => {
  // A long batch window: the answer is saved and sent, but its journal rows are still in memory when the process dies.
  const h = await harness({ flushMs: 60_000 });
  const companion = companionOver(h.home, h.store, h.runner, h.journal);
  let next: { runner: ThreadRunner; journal: EventJournal; companion: CompanionServer } | undefined;
  try {
    const request = await phone(companion, h.home, PHONE_KINDS);
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => Boolean(question(h.runner.items(h.thread.id))) && h.runner.status(h.thread.id) === "waiting");
    const open = question(h.runner.items(h.thread.id))!;
    h.journal.flush();
    const before = (await request(snapshotRoute(h.thread.id))).body.journal as { id: string; cursor: number };
    assert.equal((await request(`/v1/threads/${h.thread.id}/answer-question`, "POST", { itemId: open.id, answers: { "q-env": ["staging"], "q-token": [SECRET] } })).status, 200);
    await sent;
    // Read without since(), which would flush them.
    assert.ok((h.journal as unknown as { pending: ThreadEvent[] }).pending.some((e) => e.type === "item_update" && e.id === open.id), "the answer's rows are still unwritten");
    await companion.stop();

    // The process dies: no flush, no clean close. The next process opens the same files.
    const { ran, backend } = counting();
    const store = new Store(h.home);
    const journal = new EventJournal(path.join(h.home, "app", "events.sqlite"), { flushMs: 5 });
    const runner = new ThreadRunner({ home: h.home, store, emit: (event) => journal.record(event), backends: { codex: backend } });
    next = { journal, runner, companion: companionOver(h.home, store, runner, journal) };
    assert.notEqual(journal.id, before.id, "an unclean shutdown gives the journal a new identity");
    const after = await phone(next.companion, h.home, PHONE_KINDS);
    const poll = (await after(snapshotRoute(h.thread.id, before))).body;
    assert.equal(poll.delta, undefined, "the old cursor reloads instead of resuming past the answer");
    assert.deepEqual(lifecycle(poll.items.find((i: { id: string }) => i.id === open.id)),
      { answers: { "q-env": ["staging"], "q-token": ["(hidden)"] }, answeredBy: "phone", delivery: "sent", withdrawn: null });
    const late = await after(`/v1/threads/${h.thread.id}/answer-question`, "POST", { itemId: open.id, answers: { "q-env": ["production"], "q-token": ["again"] } });
    assert.deepEqual([late.status, late.body.reason], [409, "already-resolved"]);
    assert.equal(h.codex.replies.length, 1, "Codex heard one answer");
    assert.equal(ran.turns, 0, "the new process runs nothing");
    assert.ok(!JSON.stringify(poll).includes(SECRET));
  } finally {
    await companion.dispose(); await next?.companion.dispose(); await next?.runner.dispose(); next?.journal.close();
    await h.runner.dispose(); await h.backend.dispose(); try { h.journal.close(); } catch { /* already closed */ }
  }
});

test("an answer from the phone still being handed to Codex when Modex died reads as uncertain on the phone after a restart, and is never sent again", async () => {
  const h = await harness();
  const at = "2026-10-22T10:00:00.000Z";
  h.store.saveItems(h.thread.id, [
    { id: "u", kind: "user", text: "deploy it", at },
    { id: "q", kind: "question", questions: [{ id: "q-env", header: "Environment", text: "Which environment?", options: [{ label: "staging", description: "" }], allowOther: false, secret: false }],
      blocking: true, answers: { "q-env": ["staging"] }, answeredBy: "phone", delivery: "sending", at },
  ] as ThreadItem[]);
  await h.runner.dispose();
  h.journal.close();
  const { ran, backend } = counting();
  const store = new Store(h.home);
  const journal = new EventJournal(path.join(h.home, "app", "events.sqlite"), { flushMs: 5 });
  const runner = new ThreadRunner({ home: h.home, store, emit: (event) => journal.record(event), backends: { codex: backend } });
  const companion = companionOver(h.home, store, runner, journal);
  try {
    const drawing = await phone(companion, h.home, PHONE_KINDS);
    const legacy = await phone(companion, h.home);
    const card = (await drawing(snapshotRoute(h.thread.id))).body.items.find((i: { id: string }) => i.id === "q");
    assert.deepEqual([card.kind, lifecycle(card)], ["question", { answers: { "q-env": ["staging"] }, answeredBy: "phone", delivery: "uncertain", withdrawn: null }]);
    const notice = (await legacy(snapshotRoute(h.thread.id))).body.items.find((i: { id: string }) => i.id === "q");
    assert.match(notice.text, /Delivery uncertain\. Not resent/);
    const again = await drawing(`/v1/threads/${h.thread.id}/answer-question`, "POST", { itemId: "q", answers: { "q-env": ["staging"] } });
    assert.deepEqual([again.status, again.body.reason], [409, "already-resolved"]);
    assert.equal(ran.turns, 0);
  } finally { await companion.dispose(); await runner.dispose(); journal.close(); }
});

test("an older paired desktop, which can only approve or deny, cannot answer a question: refused, and Codex hears nothing", async () => {
  const h = await harness();
  try {
    const sent = h.runner.send(h.thread.id, "deploy it");
    await waitFor(() => Boolean(question(h.runner.items(h.thread.id))) && h.runner.status(h.thread.id) === "waiting");
    const open = question(h.runner.items(h.thread.id))!;
    // What thread:answer does for a Store build cut before CF-3 (index.ts hands it to runner.answer).
    for (const answer of ["yes", "no", "always"] as const) {
      assert.deepEqual(h.runner.answer(h.thread.id, open.id, answer, "paired-desktop"), { ok: false, reason: "invalid" });
    }
    assert.deepEqual(lifecycle(question(h.runner.items(h.thread.id))!), { answers: null, answeredBy: null, delivery: null, withdrawn: null }, "the card stays open for a client that can answer it");
    assert.deepEqual(h.codex.replies, []);
    assert.deepEqual(h.runner.answerQuestion(h.thread.id, open.id, { "q-env": ["staging"], "q-token": ["t"] }), { ok: true });
    await sent;
    assert.equal(h.codex.replies.length, 1);
  } finally { await h.runner.dispose(); await h.backend.dispose(); h.journal.close(); }
});
