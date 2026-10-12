import assert from "node:assert/strict";
import { test } from "node:test";
import { RendererRestartPreflight, type RestartRequest } from "../src/main/engine/update-renderer-preflight.js";
import * as preflight from "../src/main/engine/update-renderer-preflight.js";

test("document binding rejects paired or replacement-document replies and saves", async () => {
  const Bound = (preflight as any).DocumentRestartPreflight;
  assert.equal(typeof Bound, "function");
  let current: object | null = {}, sent: { document: object; request: RestartRequest }[] = [];
  const original = current;
  const gate = new Bound(() => current, (document: object, request: RestartRequest) => sent.push({ document, request }));
  const preparing = gate.prepare();
  assert.equal(gate.allowsPersistence(original), true);
  assert.equal(gate.allowsPersistence(undefined), false);
  assert.equal(gate.reply({}, { id: sent[0]!.request.id, revision: 1 }), false);
  gate.reply(original, { id: sent[0]!.request.id, revision: 1 }); await preparing;
  gate.assertPrepared(); current = {};
  assert.equal(gate.allowsPersistence(original), false);
  assert.equal(gate.allowsPersistence(current), false);
  assert.throws(() => gate.assertPrepared());
  gate.release(); assert.equal(sent.length, 1, "never send old release to a replacement document");
});

test("document invalidation refuses a pending acknowledgment and release authorizes only its original document", async () => {
  const Bound = (preflight as any).DocumentRestartPreflight;
  assert.equal(typeof Bound, "function");
  const document = {}, sent: RestartRequest[] = [];
  const gate = new Bound(() => document, (_document: object, request: RestartRequest) => sent.push(request));
  const pending = gate.prepare(); const rejection = assert.rejects(pending, /changed/i);
  gate.invalidate(); await rejection; assert.equal(gate.allowsPersistence(document), false);
  assert.equal(gate.reply(document, { id: sent[0]!.id, revision: 1 }), false);
  const next = gate.prepare(); gate.reply(document, { id: sent.at(-1)!.id, revision: 2 }); await next;
  gate.release(); assert.equal(sent.at(-1)!.type, "release"); assert.equal(gate.allowsPersistence(document), false);
});

test("document persistence closes at acknowledgment while a later negative reply still revokes it", async () => {
  const document = {}, sent: RestartRequest[] = [];
  const gate = new preflight.DocumentRestartPreflight(() => document, (_document, request) => sent.push(request));
  const pending = gate.prepare(), id = sent[0]!.id;
  assert.equal(gate.allowsPersistence(document), true);
  gate.reply(document, { id, revision: 3 }); await pending;
  assert.equal(gate.allowsPersistence(document), false, "the editor flush window has ended");
  gate.assertPrepared(); assert.equal(gate.reply(document, { id, error: "Editor changed" }), true);
  assert.throws(() => gate.assertPrepared());
  gate.release();
});

test("document persistence closes after timeout without granting a new editing window", async () => {
  const document = {};
  const gate = new preflight.DocumentRestartPreflight(() => document, () => {}, 5);
  await assert.rejects(gate.prepare(), /respond/);
  assert.equal(gate.allowsPersistence(document), false); gate.release();
});

test("preflight accepts only its current document token and keeps the freeze until release", async () => {
  const messages: RestartRequest[] = [];
  const gate = new RendererRestartPreflight(message => messages.push(message));
  const first = gate.prepare();
  const id = messages[0]!.id;
  assert.equal(gate.reply({ id: "other-document", revision: 1 }), false);
  assert.equal(gate.reply({ id, revision: 3 }), true);
  assert.equal(await first, 3);
  gate.assertPrepared();
  await assert.rejects(gate.prepare(), /already/i);
  gate.release();
  assert.deepEqual(messages.at(-1), { id, type: "release" });
  assert.throws(() => gate.assertPrepared(), /changed|ready/i);
  const next = gate.prepare();
  assert.notEqual(messages.at(-1)!.id, id);
  assert.equal(gate.reply({ id, revision: 4 }), false);
  gate.reply({ id: messages.at(-1)!.id, error: "Save or close Settings first." });
  await assert.rejects(next, /Settings/);
  gate.release();
});

test("navigation invalidates a completed acknowledgment and rejects a pending preparation", async () => {
  const messages: RestartRequest[] = [];
  const gate = new RendererRestartPreflight(message => messages.push(message));
  const first = gate.prepare();
  gate.invalidate();
  await assert.rejects(first, /changed/i);
  assert.equal(gate.reply({ id: messages[0]!.id, revision: 1 }), false);
  const second = gate.prepare();
  gate.reply({ id: messages.at(-1)!.id, revision: 2 });
  await second;
  gate.invalidate();
  assert.throws(() => gate.assertPrepared(), /changed|ready/i);
});

test("timeout and malformed replies cannot authorize service teardown", async () => {
  const messages: RestartRequest[] = [];
  const gate = new RendererRestartPreflight(message => messages.push(message), 15);
  const pending = gate.prepare();
  assert.equal(gate.reply({ id: messages[0]!.id, revision: 0 }), false);
  await assert.rejects(pending, /respond/i);
  assert.throws(() => gate.assertPrepared(), /ready/i);
  assert.equal(gate.reply({ id: messages[0]!.id, revision: 2 }), false);
  gate.release();
});
