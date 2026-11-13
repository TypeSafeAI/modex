import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TaskContextAgents, type TaskContextLease } from "../src/main/engine/task-context-agents.js";
import { Store } from "../src/main/engine/store.js";
import type { TaskContextProposal } from "../src/shared/task-context-tools.js";
import { gitRepo, tmpdir } from "./helpers.js";

function fixture(t: TestContext) {
  const store = new Store(tmpdir("modex-context-proposals-")), project = store.addProject(gitRepo()), other = store.addProject(gitRepo()), now = new Date().toISOString();
  const thread = store.addThread({ id: randomUUID(), projectId: project.id, title: "Context", cwd: project.path, backend: "claude", claudeAccount: "cli", mode: "chat", plan: true, model: "", status: "idle", createdAt: now, updatedAt: now });
  const own = store.space.projectFor(project.id)!, foreign = store.space.projectFor(other.id)!;
  const note = store.space.create({ containerId: own.id, title: "Own", markdown: "never-return-private-body" });
  const foreignNote = store.space.create({ containerId: foreign.id, title: "Foreign", markdown: "foreign-private-body" });
  const agents = new TaskContextAgents({ store }), receipts: TaskContextProposal[] = [], stop = new AbortController(); let current = true;
  const binding = { turn: { thread: thread.id, turn: "user-1", attempt: "attempt-1", backend: "claude" as const, account: "cli" }, projectId: project.id, cwd: project.path,
    isCurrent: () => current, accept: (proposal: TaskContextProposal) => { receipts.push(structuredClone(proposal)); return { receiptId: proposal.receiptId, accepted: proposal.refs.length, refIds: proposal.refs.map(() => randomUUID()) }; } };
  t.after(() => agents.dispose());
  return { store, project, other, thread, own, foreign, note, foreignNote, agents, receipts, stop, binding, replace: () => { current = false; } };
}
async function call(lease: TaskContextLease, id: string | number, args: unknown, name = "propose_refs") {
  const response = await fetch(lease.connection.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }) });
  const text = await response.text(), body = (text ? JSON.parse(text) : {}) as { result?: { isError?: boolean; content?: { text: string }[] }; error?: unknown };
  return { status: response.status, body, result: body.result, value: !body.result?.isError && body.result?.content?.[0]?.text ? JSON.parse(body.result.content[0].text) as Record<string, unknown> : undefined };
}
const file = (p = "src/new.ts", role: "file" | "test" = "file") => ({ target: { kind: "file", path: p }, role });

test("independent file/test/Note proposals expose one metadata tool and no body or approval authority", async t => {
  const f = fixture(t), lease = await f.agents.prepare(f.binding, f.stop.signal), settings = structuredClone(f.store.settings), thread = structuredClone(f.thread);
  const client = new Client({ name: "proposal-fixture", version: "1" }); t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(lease.connection.url)));
  assert.deepEqual((await client.listTools()).tools.map(tool => tool.name), ["propose_refs"]);
  // Generic Notes readers reconcile full bodies and may write an index. Proposal scope must not call them.
  for (const method of ["settle", "readFile", "list", "tree", "pageRels", "projectFor", "history", "create", "save"] as const) t.mock.method(f.store.space, method, () => { throw new Error(`Unexpected Notes body/recovery API: ${method}`); });
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => { if (typeof args[0] === "string" && /\.(md|ts|txt)$/.test(args[0])) assert.fail("proposal read a content body"); return read(...args); });
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => { if (typeof args[0] === "string" && /\.(md|ts|txt)$/.test(args[0])) assert.fail("proposal opened a content body"); return open(...args); });
  const result = await call(lease, "independent-1", { refs: [file(), file("test/new.test.ts", "test"), { target: { kind: "note", pageId: f.note.id }, role: "note" }] });
  assert.equal(result.result?.isError, undefined); assert.equal(result.value?.accepted, 3); assert.equal(f.receipts.length, 1);
  assert.deepEqual(f.receipts[0]!.refs.map(ref => ref.role), ["file", "test", "note"]); assert.equal(f.receipts[0]!.requestId, "independent-1");
  assert.equal("nativeLink" in f.receipts[0]!, false);
  assert.equal(JSON.stringify(result.body).includes("never-return-private-body"), false); assert.equal(JSON.stringify(f.receipts).includes(new URL(lease.connection.url).pathname.split("/").at(-1)!), false);
  assert.deepEqual(f.store.settings, settings); assert.deepEqual(f.store.thread(f.thread.id), thread);
});

test("duplicate request IDs replay one receipt, canonical key order is equivalent, changed payload is refused", async t => {
  const f = fixture(t), lease = await f.agents.prepare(f.binding, f.stop.signal);
  const first = await call(lease, 41, { refs: [file()] }); assert.equal(first.result?.isError, undefined);
  const second = await call(lease, 41, { refs: [{ role: "file", target: { path: "src/new.ts", kind: "file" } }] });
  assert.deepEqual(second.value, first.value); assert.equal(f.receipts.length, 1);
  const changed = await call(lease, 41, { refs: [file("other.ts")] }); assert.equal(changed.result?.isError, true); assert.equal(f.receipts.length, 1);
  await call(lease, 42, { refs: [file()] }); assert.equal(f.receipts.length, 2); assert.notEqual(f.receipts[0]!.receiptId, f.receipts[1]!.receiptId);
});

test("concurrent duplicates share the pending acceptance instead of recording twice", async t => {
  const f = fixture(t), lease = await f.agents.prepare(f.binding, f.stop.signal), actual = fsp.realpath;
  let release!: () => void, entered!: () => void, heldOnce = false;
  const held = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  t.mock.method(fsp, "realpath", async (...args: Parameters<typeof fsp.realpath>) => { if (!heldOnce) { heldOnce = true; entered(); await held; } return actual(...args); });
  const first = call(lease, "same", { refs: [file()] }); await started;
  const second = call(lease, "same", { refs: [file()] }); release();
  const results = await Promise.all([first, second]); assert.equal(results[0]!.result?.isError, undefined); assert.deepEqual(results[0]!.value, results[1]!.value); assert.equal(f.receipts.length, 1);
});

test("an ambiguous acceptance failure is cached and its private error is never returned", async t => {
  const f = fixture(t); let accepts = 0;
  f.binding.accept = () => { accepts++; throw new Error("private /Users/example/secrets/provider.key"); };
  const lease = await f.agents.prepare(f.binding, f.stop.signal);
  const first = await call(lease, "uncertain", { refs: [file()] }), second = await call(lease, "uncertain", { refs: [file()] });
  assert.equal(first.result?.isError, true); assert.deepEqual(second.body, first.body); assert.equal(accepts, 1);
  assert.equal(JSON.stringify(first.body).includes("provider.key"), false);
});

test("the per-attempt metadata budget refuses further proposals but retains earlier replay receipts", async t => {
  const f = fixture(t), lease = await f.agents.prepare(f.binding, f.stop.signal), target = `${"d".repeat(180)}/${"e".repeat(180)}`;
  const args = { refs: Array.from({ length: 100 }, () => file(target)) };
  const first = await call(lease, "budget-0", args); assert.equal(first.result?.isError, undefined);
  let refused = false;
  for (let i = 1; i < 80; i++) { const result = await call(lease, `budget-${i}`, args); if (result.result?.isError) { refused = true; assert.match(JSON.stringify(result.body), /budget/); break; } }
  assert.equal(refused, true); assert.ok(f.receipts.length > 1 && f.receipts.length < 80);
  const accepted = f.receipts.length; assert.deepEqual((await call(lease, "budget-0", args)).value, first.value); assert.equal(f.receipts.length, accepted);
});

test("private route tokens cannot be retained through a proposal request ID or target", async t => {
  const f = fixture(t), lease = await f.agents.prepare(f.binding, f.stop.signal), token = new URL(lease.connection.url).pathname.split("/").at(-1)!;
  for (const [id, args] of [[token, { refs: [file()] }], ["target", { refs: [file(`src/${token}.ts`)] }]] as const) {
    const result = await call(lease, id, args); assert.ok(result.result?.isError === true || result.status === 400); assert.equal(JSON.stringify(result.body).includes(token), false);
  }
  assert.equal(f.receipts.length, 0);
});

test("strict proposal arguments refuse invented provenance, bodies, permissions, bad roles and path traversal", async t => {
  const f = fixture(t), lease = await f.agents.prepare(f.binding, f.stop.signal);
  const invalid = [null, {}, { refs: [] }, { refs: [file()], origin: "native" }, { refs: [file()], permissions: "write" }, { refs: [{ ...file(), rationale: "raw body" }] },
    { refs: [{ ...file(), role: "verified" }] }, { refs: [file("../private")] }, { refs: [file("/private/secret")] }, { refs: [{ target: { kind: "file", path: "a.ts", body: "secret" }, role: "file" }] },
    { refs: [{ target: { kind: "note", pageId: f.note.id }, role: "test" }] }, { refs: Array.from({ length: 101 }, () => file()) }];
  for (const [index, args] of invalid.entries()) { const result = await call(lease, `invalid-${index}`, args); assert.ok(result.result?.isError === true || result.body.error, `invalid proposal ${index}`); }
  assert.equal((await call(lease, "unknown", { refs: [file()] }, "read")).result?.isError, true); assert.equal(f.receipts.length, 0);
});

test("proposal body bytes and exact loopback host/origin are checked before accepting", async t => {
  const f = fixture(t), lease = await f.agents.prepare(f.binding, f.stop.signal);
  const body = JSON.stringify({ jsonrpc: "2.0", id: "oversize", method: "tools/call", params: { name: "propose_refs", arguments: { refs: [file("a".repeat(65536))] } } });
  assert.equal((await fetch(lease.connection.url, { method: "POST", headers: { "Content-Type": "application/json" }, body })).status, 413);
  for (const headers of [{ Origin: "https://foreign.invalid" }, { Host: "localhost:9999" }] as Record<string, string>[]) {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(lease.connection.url, { method: "POST", headers: { "Content-Type": "application/json", ...headers } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject); req.end("{}");
    });
    assert.equal(status, 403);
  }
  assert.equal(f.receipts.length, 0);
});

test("foreign, moved and deleted Note identities cannot become scoped proposals", async t => {
  const f = fixture(t), lease = await f.agents.prepare(f.binding, f.stop.signal);
  const args = (pageId: string) => ({ refs: [{ target: { kind: "note", pageId }, role: "note" }] });
  assert.equal((await call(lease, "foreign", args(f.foreignNote.id))).result?.isError, true);
  f.store.space.moveNodes([f.note.id], f.foreign.id);
  assert.equal((await call(lease, "moved", args(f.note.id))).result?.isError, true);
  assert.equal((await call(lease, "missing", args(randomUUID()))).result?.isError, true); assert.equal(f.receipts.length, 0);
});

test("file proposals cannot cross a symlink outside the bound coding workspace", async t => {
  const f = fixture(t), outside = tmpdir("modex-proposal-outside-"); fs.symlinkSync(outside, path.join(f.project.path, "escape"));
  const lease = await f.agents.prepare(f.binding, f.stop.signal);
  assert.equal((await call(lease, "escape", { refs: [file("escape/missing.ts")] })).result?.isError, true);
  assert.equal(f.receipts.length, 0);
});

test("fresh attempt routes revoke old tokens without letting old request identity bind the replacement", async t => {
  const f = fixture(t), first = await f.agents.prepare(f.binding, f.stop.signal); await first.close();
  const second = await f.agents.prepare({ ...f.binding, turn: { ...f.binding.turn, attempt: "attempt-2" } }, new AbortController().signal);
  assert.notEqual(first.connection.url, second.connection.url); assert.equal((await fetch(first.connection.url)).status, 404);
  assert.equal((await call(second, "same-request", { refs: [file()] })).result?.isError, undefined); assert.equal(f.receipts.length, 1);
});

for (const change of ["stop", "attempt", "project", "account", "cwd"] as const) test(`a delayed body after ${change} cannot record a proposal`, async t => {
  const f = fixture(t), lease = await f.agents.prepare(f.binding, f.stop.signal), url = new URL(lease.connection.url);
  const response = new Promise<number>(resolve => {
    const req = http.request(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" } }, res => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
    req.on("error", () => resolve(499)); req.write('{"jsonrpc":"2.0","id":"late","method":"tools/call","params":');
    void new Promise<void>(r => setImmediate(r)).then(() => {
      if (change === "stop") f.stop.abort(); else if (change === "attempt") f.replace(); else if (change === "project") f.store.updateThread(f.thread.id, { projectId: f.other.id });
      else if (change === "account") f.store.updateThread(f.thread.id, { claudeAccount: "other-account" }); else f.store.updateThread(f.thread.id, { cwd: f.other.path });
      req.end(JSON.stringify({ name: "propose_refs", arguments: { refs: [file()] } }) + "}");
    });
  });
  await response; assert.equal(f.receipts.length, 0);
});
