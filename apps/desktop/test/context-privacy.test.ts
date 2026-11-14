import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextPrivacy } from "../src/main/engine/context-privacy.js";
import type { TurnSink } from "../src/main/engine/backends/types.js";
import type { Observation } from "../src/shared/conversation-events.js";

const token = "01234567-89ab-4def-8123-456789abcdef", url = `http://127.0.0.1:43111/mcp/${token}`, native = { runtime: "fixture", item: "message" };
function fixture(known = new Set<string>()) {
  const events: Observation[] = [], output: string[] = [], notices: string[] = [], sessions: string[] = []; let approvals = 0, questions = 0, writes = 0;
  const sink: TurnSink = { observe: event => events.push(event), output: (_native, text) => output.push(text), notice: (_level, text) => notices.push(text), session: handle => sessions.push(handle),
    approval: async () => { approvals++; return "yes"; }, question: async () => { questions++; return { answers: { q: ["answer"] } }; }, deliverRequest: async (_native, write) => { writes++; await write(); } };
  const privacy = new ContextPrivacy(known); privacy.addConnection(url);
  return { privacy, sink: privacy.wrap(sink), events, output, notices, sessions, counts: () => ({ approvals, questions, writes }) };
}

test("every split of a private URL or token is removed before message and raw-output publication", () => {
  for (const secret of [url, token]) for (let split = 0; split <= secret.length; split++) {
    const f = fixture();
    for (const text of [`start ${secret.slice(0, split)}`, `${secret.slice(split)} done.`]) { f.sink.observe({ type: "message.delta", native, text }); f.sink.output!(native, text); }
    f.sink.observe({ type: "message.done", native }); f.privacy.finish();
    const messages = f.events.flatMap(event => event.type === "message.delta" ? [event.text] : []).join("");
    for (const result of [messages, f.output.join("")]) { assert.equal(result.includes(secret), false, `split ${split}`); assert.ok(result.startsWith("start ") && result.endsWith(" done.")); }
    assert.ok(f.events.every(event => JSON.stringify(event.native) === JSON.stringify(native)));
  }
});

test("ordinary trailing prefix characters and unrelated URLs remain exact", () => {
  const f = fixture(), text = "Keep https://example.invalid/read and enough";
  f.sink.observe({ type: "message.delta", native, text }); f.sink.observe({ type: "message.done", native }); f.privacy.finish();
  assert.equal(f.events.flatMap(event => event.type === "message.delta" ? [event.text] : []).join(""), text);
});

test("already-loaded credentials share the bounded private history across rotations", () => {
  const known = new Set<string>(), first = new ContextPrivacy(known), old = "sk-orca-old-synthetic-key", current = "sk-orca-new-synthetic-key";
  first.addCredential(old); first.finish();
  const next = new ContextPrivacy(known); next.addCredential(current);
  for (const value of [old, current]) { assert.equal(next.contains({ path: `src/${value}.ts` }), true); assert.equal(next.text(`echo ${value}`).includes(value), false); }
  for (let i = 0; i < 1000; i++) next.addCredential(current);
  assert.throws(() => next.addCredential("x".repeat(2 * 1024 * 1024)), /registry is full/);
  assert.equal(known.has("x".repeat(2 * 1024 * 1024)), false, "a refused registration must not mutate the shared guard");
});

test("an ordinary hex digest ending in eight matching characters is not a private UUID", () => {
  const f = fixture(), digest = "a".repeat(56) + token.slice(0, 8);
  assert.equal(f.privacy.contains({ digest }), false);
  assert.deepEqual(f.privacy.redact({ digest }), { digest });
});

test("terminal structured output cannot reveal a long incomplete private-token prefix", () => {
  const f = fixture(), prefix = token.slice(0, -1);
  f.sink.observe({ type: "tool.done", native, outcome: "failed", progress: { output: `truncated ${prefix}` } });
  assert.equal(JSON.stringify(f.events).includes(prefix), false);
  assert.equal(f.privacy.redact({ detail: `truncated ${prefix}` }).detail.includes(prefix), false);
});

test("finish makes every native sink method inert including late request writes", async () => {
  const f = fixture(); f.privacy.finish(); const before = JSON.stringify([f.events, f.output, f.notices, f.sessions]); let write = 0;
  f.sink.observe({ type: "message.delta", native, text: "late" }); f.sink.output!(native, "late"); f.sink.notice("error", "late"); f.sink.session("late-session");
  assert.equal(await f.sink.approval({ question: "Late?", canAlways: false }), "no");
  assert.deepEqual(await f.sink.question!({ blocking: true, questions: [] }), { withdrawn: "ended" });
  await f.sink.deliverRequest!({ runtime: "fixture", request: "late" }, async () => { write++; });
  assert.equal(write, 0); assert.deepEqual(f.counts(), { approvals: 0, questions: 0, writes: 0 }); assert.equal(JSON.stringify([f.events, f.output, f.notices, f.sessions]), before);
});

test("known values survive replacement attempts and budget refusal preserves the earlier registry", () => {
  const known = new Set<string>(), first = fixture(known); first.privacy.finish();
  const second = new ContextPrivacy(known); second.addConnection(`http://127.0.0.1:43111/mcp/11234567-89ab-4def-8123-456789abcdef`);
  assert.equal(second.redact({ error: url }).error.includes(token), false);
  assert.throws(() => second.addConnection(`http://127.0.0.1:43111/mcp/${"x".repeat(2 * 1024 * 1024)}`), /registry is full/);
  assert.equal(second.contains(url), true); assert.equal(known.has(url), true);
});
