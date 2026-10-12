import assert from "node:assert/strict";
import { test } from "node:test";

async function fixture() {
  const module = "../src/main/engine/owner-removal.js", { OwnerRemoval } = await import(module);
  const requests: any[] = [], events: string[] = [], original = {};
  let document: object | undefined = original, uncertain = false;
  const drafts = { threads: [], projects: [], draft: null, selectedThreadId: null };
  const options = { current: () => document, send: (_document: object, request: unknown) => requests.push(request),
    holds: [() => { events.push("hold"); return () => { events.push("release"); }; }],
    prune: (scope: unknown, revision: number) => { assert.deepEqual(scope, { kind: "thread", id: "t" }); assert.equal(revision, 3); events.push("prune"); return { drafts, revision: 4 }; },
    snapshot: () => "store state", requiresRecovery: () => uncertain, recover: (_error: Error) => { events.push("recovery"); }, timeoutMs: 1000 };
  const removal = new OwnerRemoval(options), scope = { kind: "thread", id: "t" };
  const start = (operation = async () => { events.push("remove"); }) => { const result = removal.run(scope, operation); void result.catch(() => {}); return result; };
  const reply = (phase: string, extra: object, sender = document) => {
    const request = [...requests].reverse().find(request => request.phase === phase && request.type === "prepare"); assert.ok(request);
    return removal.reply(sender, { phase, id: request.id, ...extra });
  };
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  return { removal, options, requests, events, drafts, start, reply, tick, navigate: () => { document = {}; }, original, uncertain: () => { uncertain = true; } };
}

test("owner removal binds scope and document, and waits for canonical renderer adoption before releasing", async () => {
  const h = await fixture(), result = h.start();
  assert.deepEqual(h.events, ["hold"]); assert.equal(h.removal.active, true);
  assert.deepEqual(h.requests[0].scope, { kind: "thread", id: "t" });
  assert.equal(h.reply("prepare", { revision: 3 }, {}), false);
  h.reply("prepare", { revision: 3 }); await h.tick();
  assert.deepEqual(h.events, ["hold", "prune", "remove"]);
  assert.deepEqual(h.requests[1].result, { drafts: h.drafts, revision: 4, state: "store state" });
  h.reply("adopt", { revision: 4 }); await result;
  assert.deepEqual(h.events, ["hold", "prune", "remove", "release"]); assert.equal(h.removal.active, false);
});

test("owner removal refusal leaves owners untouched and releases the renderer", async () => {
  const h = await fixture(), result = h.start();
  h.reply("prepare", { error: "picker busy" }); await assert.rejects(result, /picker busy/);
  assert.deepEqual(h.events, ["hold", "release"]); assert.ok(h.requests.some(request => request.type === "release"));
});

test("owner removal preserves the fence when durable publication is uncertain", async () => {
  const h = await fixture();
  h.options.prune = () => { h.uncertain(); throw new Error("lost ACK"); };
  const result = h.start(); h.reply("prepare", { revision: 3 });
  await assert.rejects(result, /lost ACK/);
  assert.deepEqual(h.events, ["hold", "recovery"]); assert.equal(h.requests.some(request => request.type === "release"), false);
});

test("failed owner cleanup still adopts the pruned canonical draft before reporting its error", async () => {
  const h = await fixture(), result = h.start(async () => { h.events.push("remove"); throw new Error("worktree refused"); });
  h.reply("prepare", { revision: 3 }); await h.tick(); h.reply("adopt", { revision: 4 });
  await assert.rejects(result, /worktree refused/);
  assert.deepEqual(h.events, ["hold", "prune", "remove", "release"]);
});

test("replacement renderer after preparation cannot authorize deletion", async () => {
  const h = await fixture(), result = h.start(); h.reply("prepare", { revision: 3 }); h.navigate();
  await assert.rejects(result, /workspace|document|changed/i);
  assert.deepEqual(h.events, ["hold", "release"]);
});

test("wrong adoption revision requires read-only recovery and preserves all fences", async () => {
  const h = await fixture(), result = h.start(); h.reply("prepare", { revision: 3 }); await h.tick();
  h.reply("adopt", { revision: 5 }); await assert.rejects(result, /revision/i);
  assert.deepEqual(h.events, ["hold", "prune", "remove", "recovery"]);
});

test("concurrent removal is refused without releasing another operation's hold", async () => {
  const h = await fixture(), result = h.start();
  await assert.rejects(h.start(), /active|progress/i); assert.deepEqual(h.events, ["hold"]);
  h.reply("prepare", { error: "cancel" }); await assert.rejects(result, /cancel/);
});
