import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import { NotesStore } from "../src/main/engine/notes-store.js";
import { PagesAgents, type PagesReadReceipt, type PagesLease } from "../src/main/engine/pages-agents.js";
import { TaskContextCapture } from "../src/main/engine/task-context-capture.js";
import { isTaskContextEvidence } from "../src/shared/task-context-evidence.js";
import type { TurnRef } from "../src/shared/conversation-events.js";
import type { SpacePageVersion } from "../src/shared/space.js";
import { tmpdir } from "./helpers.js";

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
function fixture(t: TestContext, capture = new TaskContextCapture()) {
  const home = tmpdir("modex-context-pages-"), space = new NotesStore(path.join(home, "notes"));
  const project = space.linkProject({ id: "project", name: "Own", path: home }), other = space.linkProject({ id: "other", name: "Other", path: "/other" });
  let page = space.create({ containerId: project.id, title: "Current", markdown: "current-1" });
  while (page.revision < 9) page = space.save({ ...page, markdown: `current-${page.revision + 1}` });
  const foreign = space.create({ containerId: other.id, title: "Foreign", markdown: "foreign-body" });
  let enabled = true, current = true;
  const receipts: PagesReadReceipt[] = [], turn = { id: "thread", projectId: "project", mode: "agent" as "agent" | "chat", plan: false };
  const agents = new PagesAgents({ space, notes: space, capture, enabled: () => enabled, scope: id => { const p = space.projectFor(id); return p ? { id: p.id, rel: p.rel } : null; } });
  t.after(() => agents.dispose());
  const begin = (attempt = "A") => agents.prepare(turn, () => assert.fail("Read observation must not write Notes"), undefined, {
    attempt: { thread: turn.id, turn: "U", attempt, backend: "codex" } satisfies TurnRef, cwd: home, isCurrent: () => current, observed: receipt => { receipts.push(receipt); },
  });
  return { home, space, page, foreign, project, other, turn, agents, receipts, begin, enable: (v: boolean) => { enabled = v; }, current: (v: boolean) => { current = v; } };
}
async function call(lease: PagesLease, id: string | number, name: string, args: Record<string, unknown>) {
  const response = await fetch(lease.connection.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
  assert.equal(response.status, 200);
  return await response.json() as { id: string | number; result: { isError?: boolean; content: { text: string }[] } };
}
function historical(f: ReturnType<typeof fixture>, revision: number, text: string): SpacePageVersion {
  return { page: { ...f.page, revision, markdown: text }, actor: "human", summary: `revision-${revision}`, checkpointAt: f.page.updatedAt };
}

test("history receipts hash each exact returned body/revision rather than the current Note", async t => {
  const f = fixture(t);
  t.mock.method(f.space, "history", () => [historical(f, 4, "historical-four"), historical(f, 8, "historical-eight")]);
  const lease = await f.begin(); t.after(() => lease.close());
  const response = await call(lease, "history-7", "history", { id: f.page.id });
  assert.equal(response.result.isError, undefined); assert.equal(f.page.revision, 9);
  assert.deepEqual(JSON.parse(response.result.content[0]!.text).versions.map((v: SpacePageVersion) => v.page.revision), [8, 4]);
  assert.equal(f.receipts.length, 1); const receipt = f.receipts[0]!;
  assert.equal(receipt.source.method, "history"); assert.equal(receipt.source.requestId, "history-7");
  assert.equal(receipt.source.leaseId, lease.leaseId); assert.notEqual(lease.leaseId, new URL(lease.connection.url).pathname.split("/").at(-1));
  assert.deepEqual(receipt.captures.map(c => c.noteVersion?.revision), [8, 4]);
  assert.deepEqual(receipt.captures.map(c => c.revision), [
    { state: "available", algorithm: "sha256", digest: digest("historical-eight"), bytes: 16, noteRevision: 8 },
    { state: "available", algorithm: "sha256", digest: digest("historical-four"), bytes: 15, noteRevision: 4 },
  ]);
  assert.ok(receipt.captures.every(c => c.phase === "after-notes-read"));
  const metadata = JSON.stringify(receipt); for (const body of ["historical-four", "historical-eight", "current-9"]) assert.equal(metadata.includes(body), false);
  assert.equal(receipt.source.nativeLink, undefined);
  assert.ok(isTaskContextEvidence({ revision: 1, refs: [{ id: "note-ref", target: { kind: "note", pageId: f.page.id }, relations: [{ kind: "read", provenance: "observed", source: receipt.source }], captureIds: receipt.captures.map(c => c.id) }], captures: receipt.captures, checks: [] }));
});

test("each returned history version retains its identity when the shared hash budget expires", async t => {
  const capture = new TaskContextCapture({ clock: { now: () => Date.now(), setTimeout: callback => { callback(); return 0; }, clearTimeout: () => {} } });
  const f = fixture(t, capture); t.mock.method(f.space, "history", () => [historical(f, 4, "four"), historical(f, 8, "eight")]);
  const lease = await f.begin(); t.after(() => lease.close()); await call(lease, 8, "history", { id: f.page.id });
  assert.equal(f.receipts.length, 1);
  assert.deepEqual(f.receipts[0]!.captures.map(c => ({ revision: c.noteVersion?.revision, hash: c.revision })), [
    { revision: 8, hash: { state: "unavailable", reason: "budget" } }, { revision: 4, hash: { state: "unavailable", reason: "budget" } },
  ]);
});

test("search is discovery; disabled, foreign and metadata-only history reads never create body observations", async t => {
  const f = fixture(t), lease = await f.begin(); t.after(() => lease.close());
  await call(lease, 1, "search", { query: "current" }); assert.equal(f.receipts.length, 0);
  assert.equal((await call(lease, 2, "history", { id: f.foreign.id })).result.isError, true);
  f.enable(false); assert.equal((await call(lease, 3, "read", { id: f.page.id })).result.isError, true); f.enable(true);
  t.mock.method(f.space, "history", () => [{ page: { id: f.page.id, revision: 8, updatedAt: f.page.updatedAt }, actor: "human", summary: "metadata" } as SpacePageVersion]);
  await call(lease, 4, "history", { id: f.page.id }); assert.equal(f.receipts.length, 0);
  await call(lease, 5, "read", { id: f.page.id }); assert.equal(f.receipts.length, 1);
  assert.equal(f.receipts[0]!.source.method, "read"); assert.equal(f.receipts[0]!.captures[0]!.noteVersion?.revision, 9);
});

test("a wrong historical page identity refuses the result without observing another page's body", async t => {
  const f = fixture(t), lease = await f.begin(); t.after(() => lease.close());
  t.mock.method(f.space, "history", () => [{ page: f.foreign, actor: "human", summary: "wrong page" }]);
  assert.equal((await call(lease, "wrong-page", "history", { id: f.page.id })).result.isError, true); assert.equal(f.receipts.length, 0);
});

test("fresh attempt leases rotate routes and reject late old-lease capture results", async t => {
  let enter!: () => void, resume!: () => void, pause = true;
  const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { resume = r; }), actual = new TaskContextCapture();
  const capture = new class extends TaskContextCapture { override async captureNotes(...args: Parameters<TaskContextCapture["captureNotes"]>) { if (pause) { enter(); await held; } return actual.captureNotes(...args); } };
  const f = fixture(t, capture), first = await f.begin("A"); t.after(() => { resume(); return first.close(); });
  assert.ok(first.leaseId, "observed Notes leases need a public attempt identity");
  const old = call(first, "old-read", "read", { id: f.page.id });
  await Promise.race([entered, old.then(() => { throw new Error("Notes read returned before observer capture"); })]);
  await first.close(); pause = false;
  const next = await f.begin("B"); t.after(() => next.close());
  assert.notEqual(next.connection.url, first.connection.url); assert.notEqual(next.leaseId, first.leaseId);
  await call(next, "new-read", "read", { id: f.page.id }); resume(); assert.equal((await old).result.isError, true);
  assert.equal(f.receipts.length, 1); assert.equal(f.receipts[0]!.source.turn.attempt, "B");
});

test("Notes file receipts hash the exact returned text without exposing it to the observer", async t => {
  const f = fixture(t), file = path.join(f.home, "reference.txt"), body = "returned-file-body";
  fs.writeFileSync(file, body); const imported = await f.space.importFiles(f.project.id, [file]); assert.equal(imported.errors.length, 0);
  const id = imported.imported[0]!.id, lease = await f.begin(); t.after(() => lease.close());
  const response = await call(lease, "file-read", "read_file", { id }); assert.equal(response.result.isError, undefined);
  assert.equal(JSON.parse(response.result.content[0]!.text).text, body);
  assert.equal(f.receipts.length, 1); const receipt = f.receipts[0]!, capture = receipt.captures[0]!;
  assert.equal(receipt.source.method, "read_file"); assert.deepEqual(capture.target, { kind: "notes-file", id });
  assert.deepEqual(capture.revision, { state: "available", algorithm: "sha256", digest: digest(body), bytes: Buffer.byteLength(body) });
  assert.equal(JSON.stringify(receipt).includes(body), false);
});

test("an edit while hashing cannot change the response or the revision/body recorded for it", async t => {
  const actual = new TaskContextCapture(); let change = () => {};
  const capture = new class extends TaskContextCapture { override async captureNotes(...args: Parameters<TaskContextCapture["captureNotes"]>) { change(); return actual.captureNotes(...args); } };
  const f = fixture(t, capture), shared = { ...f.page }; t.mock.method(f.space, "list", () => [shared]);
  change = () => { shared.markdown = "edited-after-read"; shared.revision = 10; };
  const lease = await f.begin(); t.after(() => lease.close()); const response = await call(lease, "read-9", "read", { id: f.page.id });
  const returned = JSON.parse(response.result.content[0]!.text); assert.equal(returned.revision, 9); assert.equal(returned.markdown, "current-9");
  assert.equal(f.receipts[0]!.captures[0]!.noteVersion?.revision, 9);
  assert.deepEqual(f.receipts[0]!.captures[0]!.revision, { state: "available", algorithm: "sha256", digest: digest("current-9"), bytes: 9, noteRevision: 9 });
});

for (const action of ["disable", "move", "replace"] as const) {
  test(`a ${action} during read capture refuses the response and cannot attach an observation`, async t => {
    let enter!: () => void, resume!: () => void;
    const entered = new Promise<void>(r => { enter = r; }), held = new Promise<void>(r => { resume = r; }), actual = new TaskContextCapture();
    const capture = new class extends TaskContextCapture { override async captureNotes(...args: Parameters<TaskContextCapture["captureNotes"]>) { enter(); await held; return actual.captureNotes(...args); } };
    const f = fixture(t, capture), lease = await f.begin(); t.after(() => { resume(); return lease.close(); });
    const pending = call(lease, `held-${action}`, "read", { id: f.page.id });
    await Promise.race([entered, pending.then(() => { throw new Error("Read returned before its capture"); })]);
    if (action === "disable") f.enable(false);
    if (action === "move") f.space.moveNodes([f.page.id], f.other.id);
    if (action === "replace") f.current(false);
    resume(); assert.equal((await pending).result.isError, true); assert.equal(f.receipts.length, 0);
  });
}

test("history observes only the requested returned page and never follows nextOffset", async t => {
  const f = fixture(t); let current = f.page; while (current.revision < 31) current = f.space.save({ ...current, markdown: `current-${current.revision + 1}` });
  let reads = 0; t.mock.method(f.space, "history", () => { reads++; return Array.from({ length: 25 }, (_, i) => historical(f, i + 1, `body-${i + 1}`)); });
  const lease = await f.begin(); t.after(() => lease.close()); const response = await call(lease, "first-page", "history", { id: f.page.id });
  assert.equal(JSON.parse(response.result.content[0]!.text).nextOffset, 20); assert.equal(reads, 1); assert.equal(f.receipts.length, 1);
  assert.deepEqual(f.receipts[0]!.captures.map(c => c.noteVersion?.revision), Array.from({ length: 20 }, (_, i) => 25 - i));
});

test("observed read leases preserve the initial Plan ceiling and never publish private route tokens", async t => {
  const f = fixture(t); f.turn.plan = true; const preparing = f.begin(); f.turn.plan = false;
  const lease = await preparing; t.after(() => lease.close()); const before = f.space.list();
  assert.equal((await call(lease, 1, "create", { title: "denied", markdown: "body", summary: "not allowed" })).result.isError, true);
  assert.deepEqual(f.space.list(), before); assert.equal(f.receipts.length, 0);
  const privateToken = new URL(lease.connection.url).pathname.split("/").at(-1)!;
  assert.equal((await call(lease, privateToken, "read", { id: f.page.id })).result.isError, true); assert.equal(f.receipts.length, 0);
  await call(lease, "allowed-read", "read", { id: f.page.id }); assert.equal(f.receipts.length, 1);
  assert.equal(JSON.stringify(f.receipts).includes(privateToken), false);
});
