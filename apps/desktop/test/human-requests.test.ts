import { test } from "node:test";
import assert from "node:assert/strict";
import {
  actionDigest, answerNote, codexAnswerResponse, codexQuestions, emptyRequests, publicAnswers, register, resolve, settle, validateAnswers, withdraw,
  type HumanRequest, type RequestBinding,
} from "../src/shared/human-requests.js";

/**
 * Human requests (docs/human-requests.md): one local resolution per request, bound to the identity
 * and exact action it was asked for; stale, duplicate, withdrawn or changed requests never authorise
 * anything, and an uncertain send is never reported as done.
 */

const binding: RequestBinding = { thread: "T", turn: "U", attempt: "A1", backend: "codex", runtime: "R1", nativeRequestId: "17" };
const action = { backend: "codex", tool: "command", title: "$ npm test", input: { command: "npm test" } };
const approval: HumanRequest = { kind: "approval", id: "req-1", binding, action, digest: actionDigest(action), canAlways: true };
const yes = { kind: "approval" as const, answer: "yes" as const };

test("two clients answer one request: the first wins, the second is told it is already resolved", () => {
  let state = register(emptyRequests(), approval);
  const first = resolve(state, "req-1", yes, { binding, digest: approval.digest, by: "desktop" });
  assert.equal(first.ok, true);
  state = first.state;
  assert.equal(state.requests["req-1"]!.state, "resolving");
  const second = resolve(state, "req-1", { kind: "approval", answer: "no" }, { binding, digest: approval.digest, by: "phone" });
  assert.deepEqual([second.ok, second.ok ? null : second.reason], [false, "already-resolved"]);
  assert.equal(second.state, state, "the loser changes nothing");
  state = settle(state, "req-1", "sent");
  assert.deepEqual([state.requests["req-1"]!.state, state.requests["req-1"]!.by, state.requests["req-1"]!.resolution], ["resolved", "desktop", yes]);
  const late = resolve(state, "req-1", yes, { binding, digest: approval.digest, by: "phone" });
  assert.deepEqual([late.ok, late.ok ? null : late.reason], [false, "already-resolved"]);
});

test("a wrong thread, account, attempt or runtime, an unknown id or a changed action authorises nothing", () => {
  const state = register(emptyRequests(), approval);
  const reason = (r: ReturnType<typeof resolve>) => (r.ok ? "ok" : r.reason);
  assert.equal(reason(resolve(state, "nope", yes, { binding, digest: approval.digest, by: "desktop" })), "unknown");
  for (const wrong of [{ thread: "T2" }, { attempt: "A2" }, { runtime: "R2" }, { account: "other" }, { nativeRequestId: "18" }] as Partial<RequestBinding>[]) {
    assert.equal(reason(resolve(state, "req-1", yes, { binding: { ...binding, ...wrong }, digest: approval.digest, by: "desktop" })), "wrong-identity", JSON.stringify(wrong));
  }
  const changed = actionDigest({ ...action, input: { command: "npm test && rm -rf /" } });
  assert.equal(reason(resolve(state, "req-1", yes, { binding, digest: changed, by: "desktop" })), "changed-action");
  assert.equal(reason(resolve(state, "req-1", { kind: "question", answers: {} }, { binding, digest: approval.digest, by: "desktop" })), "invalid", "a question answer cannot answer an approval");
});

test("Stop withdraws pending requests; one already being sent becomes uncertain, never resolved", () => {
  const second: HumanRequest = { ...approval, id: "req-2", binding: { ...binding, nativeRequestId: "18" } };
  let state = register(register(emptyRequests(), approval), second);
  state = resolve(state, "req-1", yes, { binding, digest: approval.digest, by: "desktop" }).state;
  state = withdraw(state, { thread: "T", attempt: "A1" });
  assert.equal(state.requests["req-1"]!.state, "uncertain", "the answer may or may not have reached the CLI");
  assert.equal(state.requests["req-2"]!.state, "withdrawn");
  assert.equal(settle(state, "req-1", "sent").requests["req-1"]!.state, "uncertain", "a later send result does not upgrade it");
  const late = resolve(state, "req-2", yes, { binding: second.binding, digest: second.digest, by: "desktop" });
  assert.deepEqual([late.ok, late.ok ? null : late.reason], [false, "withdrawn"]);
  assert.equal(settle(register(emptyRequests(), approval), "req-1", "uncertain").requests["req-1"]!.state, "pending", "only a resolving request settles");
});

const params = {
  threadId: "thr", turnId: "tu", itemId: "it", isBlocking: true, autoResolutionMs: null,
  questions: [
    { id: "q-env", header: "Environment", question: "Which environment?", isOther: false, isSecret: false, options: [{ label: "staging", description: "Safe" }, { label: "production", description: "Live" }] },
    { id: "q-note", header: "Note", question: "Anything else?", isOther: true, isSecret: false, options: null },
    { id: "q-token", header: "Token", question: "Paste the token", isOther: true, isSecret: true, options: null },
  ],
};

test("Codex requestUserInput (codex-cli 0.163.0, experimental) maps to typed questions; malformed requests map to nothing", () => {
  const mapped = codexQuestions(params);
  assert.ok(mapped);
  assert.equal(mapped.blocking, true);
  assert.deepEqual(mapped.questions.map((q) => [q.id, q.header, q.text, q.options?.map((o) => o.label) ?? null, q.allowOther, q.secret]), [
    ["q-env", "Environment", "Which environment?", ["staging", "production"], false, false],
    ["q-note", "Note", "Anything else?", null, true, false],
    ["q-token", "Token", "Paste the token", null, true, true],
  ]);
  for (const bad of [null, {}, { questions: "x" }, { questions: [{ id: "", question: "?" }] }, { questions: [{ id: "a", question: 3 }] }, { questions: [{ id: "a", header: "h", question: "q", options: [{ label: 1 }] }] }]) {
    assert.equal(codexQuestions(bad), null, JSON.stringify(bad));
  }
});

test("answers are checked against the questions: every question answered, choices from their options unless other is allowed", () => {
  const { questions } = codexQuestions(params)!;
  const good = { "q-env": ["staging"], "q-note": ["ship it"], "q-token": ["s3cr3t"] };
  assert.deepEqual(validateAnswers(questions, good), { ok: true, answers: good });
  for (const [bad, why] of [
    [{ "q-env": ["staging"], "q-note": ["x"] }, /Token/],
    [{ ...good, "q-env": ["prod"] }, /Environment/],
    [{ ...good, "q-env": [] }, /Environment/],
    [{ ...good, extra: ["x"] }, /unknown question/i],
    [{ ...good, "q-note": [3] }, /Note/],
  ] as const) {
    const result = validateAnswers(questions, bad as unknown as Record<string, unknown>);
    assert.equal(result.ok, false);
    assert.match((result as { error: string }).error, why);
  }
  assert.deepEqual(codexAnswerResponse(good), { answers: { "q-env": { answers: ["staging"] }, "q-note": { answers: ["ship it"] }, "q-token": { answers: ["s3cr3t"] } } });
});

test("a secret answer never appears in what is shown, saved or exported", () => {
  const { questions } = codexQuestions(params)!;
  const shown = publicAnswers(questions, { "q-env": ["staging"], "q-note": ["ship it"], "q-token": ["s3cr3t"] });
  assert.deepEqual(shown, { "q-env": ["staging"], "q-note": ["ship it"], "q-token": ["(hidden)"] });
  assert.ok(!JSON.stringify(shown).includes("s3cr3t"));
});

test("a closed card says when the phone answered and when nobody can tell whether the CLI got the answer", () => {
  assert.equal(answerNote({}), null, "answered here, or before these fields existed");
  assert.equal(answerNote({ answeredBy: "desktop", delivery: "sent" }), null);
  assert.equal(answerNote({ answeredBy: "phone", delivery: "sent" }), "Answered on your phone.");
  assert.equal(answerNote({ answeredBy: "desktop", delivery: "uncertain" }), "Modex stopped before it could confirm the agent received this answer.");
  assert.equal(answerNote({ answeredBy: "phone", delivery: "uncertain" }), "Answered on your phone. Modex stopped before it could confirm the agent received this answer.");
});
