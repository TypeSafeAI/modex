import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { EventJournal } from "../src/main/engine/event-journal.js";
import { CompanionServer } from "../src/main/engine/companion.js";
import { Store } from "../src/main/engine/store.js";
import { ThreadRunner } from "../src/main/engine/runner.js";
import type { Backend } from "../src/main/engine/backends/types.js";
import type { ThreadEvent } from "../src/shared/types.js";
import { gitRepo, tmpdir } from "./helpers.js";

/**
 * A card still open when Modex stopped (docs/human-requests.md, docs/event-journal.md, CF-6 #279): the
 * phone's first poll after the restart must show it closed, although nobody has opened its thread on the
 * Mac yet. The new process closes such a card only when it first reads the thread, after the poll has
 * already read its cursor, so the journal itself has to send the phone back to a full snapshot.
 */

const waitFor = async (check: () => boolean) => { for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5)); assert.ok(check()); };

/** A Claude-shaped backend whose turn asks one approval and waits for an answer that never comes. */
const asking: Backend = { id: "claude", listModels: async () => [], dispose: async () => {}, async runTurn(_t, _o, sink) {
  await sink.approval({ question: "Allow Bash: $ deploy?", canAlways: false, action: { backend: "claude", tool: "Bash", title: "$ deploy", input: { command: "deploy" } } });
  return { status: "completed" };
} };

/** A process's companion over the given runner and journal, and the phone's HTTPS requests to it. */
async function phoneOf(home: string, store: Store, runner: ThreadRunner, journal: EventJournal) {
  const companion = new CompanionServer(home, { state: () => store.snapshot(), items: (id) => runner.items(id), status: (id) => runner.status(id),
    send: async () => ({ ok: true }), answer: (id, item, value, by) => runner.answer(id, item, value, by), journal: () => journal }, () => ["127.0.0.1"], () => () => {});
  const pairing = JSON.parse(Buffer.from(new URL((await companion.start()).pairingUri!).searchParams.get("data")!, "base64url").toString()) as { url: string; token: string; fingerprint: string };
  const get = (route: string) => new Promise<{ status: number; body: any }>((resolve, reject) => {
    const req = https.request(new URL(route, pairing.url), {
      headers: { authorization: `Bearer ${pairing.token}` }, ca: fs.readFileSync(path.join(home, "companion", "cert.pem")),
      checkServerIdentity: (_host, cert) => crypto.createHash("sha256").update(cert.raw).digest("hex") === pairing.fingerprint ? undefined : new Error("unpinned"),
    }, (res) => {
      let text = "";
      res.on("data", (chunk) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end();
  });
  return { companion, get };
}

for (const ending of ["crash", "quit"] as const) {
  test(`after a ${ending}, the phone's first poll shows a card that was open as closed`, async () => {
    const home = tmpdir("modex-request-crash-");
    const file = path.join(home, "app", "events.sqlite");
    const store = new Store(home);
    const journal = new EventJournal(file, { flushMs: 5 });
    const runner = new ThreadRunner({ home, store, emit: (event: ThreadEvent) => journal.record(event), backends: { claude: asking } });
    const before = await phoneOf(home, store, runner, journal);
    let after: Awaited<ReturnType<typeof phoneOf>> | undefined;
    let next: { runner: ThreadRunner; journal: EventJournal } | undefined;
    try {
      const thread = await runner.createThread(store.addProject(gitRepo()).id, { backend: "claude", auto: false });
      void runner.send(thread.id, "deploy");
      await waitFor(() => runner.status(thread.id) === "waiting");
      await new Promise((r) => setTimeout(r, 30));
      const seen = await before.get(`/v1/snapshot?threadId=${thread.id}`);
      const open = seen.body.items.find((item: { kind: string }) => item.kind === "approval");
      assert.ok(open && !open.answer, "the phone saw the card open");
      await before.companion.stop();
      // A crash leaves the journal open and the card unanswered on disk; a quit stops the turn first.
      if (ending === "quit") { await runner.dispose(); journal.close(); }

      const restarted = new Store(home);
      next = { journal: new EventJournal(file, { flushMs: 5 }), runner: undefined! };
      next.runner = new ThreadRunner({ home, store: restarted, emit: (event: ThreadEvent) => next!.journal.record(event), backends: { claude: asking } });
      after = await phoneOf(home, restarted, next.runner, next.journal);
      const poll = await after.get(`/v1/snapshot?threadId=${thread.id}&journal=${seen.body.journal.id}&after=${seen.body.journal.cursor}`);
      const card = poll.body.items.find((item: { id: string }) => item.id === open.id);
      assert.ok(card, `the first poll after the ${ending} carries the card (delta: ${poll.body.delta ?? false}, items: ${poll.body.items.length})`);
      assert.ok(card.withdrawn, "and it is closed, with nothing left to approve");
    } finally {
      await after?.companion.stop();
      await next?.runner.dispose();
      try { next?.journal.close(); } catch { /* already closed */ }
      if (ending === "crash") { await runner.dispose(); try { journal.close(); } catch { /* already closed */ } }
    }
  });
}
