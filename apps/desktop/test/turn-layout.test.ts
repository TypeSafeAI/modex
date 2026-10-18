import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutTurn } from "../src/shared/turn-layout.js";
import type { ThreadItem } from "../src/shared/types.js";
import type { ExecutionOutcome, ItemOrigin, MessagePhase } from "../src/shared/conversation-events.js";

const at = "2026-10-18T07:00:00.000Z";
const origin = (attempt: string, item: string): ItemOrigin => ({ thread: "T", turn: "U", attempt, backend: "codex", native: { runtime: "R", item } });
const say = (id: string, text: string, phase: MessagePhase, outcome: ExecutionOutcome = "succeeded", attempt = "A1"): ThreadItem =>
  ({ id, kind: "assistant", text, phase, outcome, origin: origin(attempt, id), at });
const tool = (id: string, outcome: ExecutionOutcome, attempt = "A1"): ThreadItem =>
  ({ id, kind: "tool", name: "shell", title: id, args: {}, status: outcome === "running" ? "running" : "done", outcome, ...(outcome === "succeeded" ? { ok: true } : outcome === "failed" || outcome === "denied" ? { ok: false } : {}), origin: origin(attempt, id), at });
const think = (id: string, outcome: ExecutionOutcome = "succeeded", attempt = "A1"): ThreadItem =>
  ({ id, kind: "thinking", text: "", reasoning: "summary", status: outcome === "running" ? "running" : "done", outcome, origin: origin(attempt, id), at });

test("a legacy turn keeps the last-reply heuristic and folds the work before it", () => {
  const items: ThreadItem[] = [
    { id: "a1", kind: "assistant", text: "Looking.", at },
    { id: "t1", kind: "tool", name: "shell", title: "$ ls", args: {}, status: "done", ok: true, at },
    { id: "r1", kind: "thinking", text: "x", status: "done", at },
    { id: "a2", kind: "assistant", text: "Done.", at },
  ];
  const idle = layoutTurn(items, { busy: false });
  assert.equal(idle.final, 3);
  assert.equal(idle.typed, false);
  assert.deepEqual(idle.work, [true, true, true, false]);
  assert.deepEqual(idle.live, [false, false, false, false]);
  assert.deepEqual(layoutTurn(items, { busy: true }).live, [false, false, false, true], "a running legacy turn streams into its newest item");
});

test("a typed turn's final answer is its final-phase message; commentary and successful tools fold, a denial stays", () => {
  const items = [say("c1", "Checking one.", "commentary"), tool("t1", "succeeded"), say("c2", "Checking two.", "commentary"), tool("t2", "denied"), say("f", "Done.", "final")];
  const layout = layoutTurn(items, { busy: false });
  assert.equal(layout.final, 4);
  assert.equal(layout.typed, true);
  assert.deepEqual(layout.work, [true, true, true, false, false]);
});

test("a final answer is never taken from array position: a commentary after the final stays out of the fold", () => {
  const items = [say("f", "Answer.", "final"), say("c", "One more note.", "commentary")];
  assert.equal(layoutTurn(items, { busy: false }).final, 0);
});

test("a typed turn with no final answer folds nothing", () => {
  const items = [say("c1", "Starting.", "commentary", "interrupted"), tool("t1", "succeeded")];
  const layout = layoutTurn(items, { busy: false });
  assert.equal(layout.final, -1);
  assert.deepEqual(layout.work, [false, false]);
});

test("every item still running is live, not only the newest", () => {
  const items = [tool("t1", "running"), say("c1", "Running the tests", "commentary", "running"), think("r1", "running")];
  assert.deepEqual(layoutTurn(items, { busy: true }).live, [true, true, true]);
  assert.deepEqual(layoutTurn([tool("t1", "succeeded"), say("f", "ok", "final")], { busy: true }).live, [false, false], "settled typed items are not live while the turn runs");
});

test("attempts stay distinct: each later attempt is marked, and only the latest attempt can supply the final answer", () => {
  const failure: ThreadItem = { id: "n", kind: "notice", level: "error", text: "Turn failed", at };
  const items = [say("old-f", "Stale answer.", "final", "succeeded", "A1"), tool("old-t", "failed", "A1"), failure, say("c", "Again.", "commentary", "succeeded", "A2"), say("f", "Fresh answer.", "final", "succeeded", "A2")];
  const layout = layoutTurn(items, { busy: false });
  assert.deepEqual(layout.attemptStart, [null, null, null, 2, null]);
  assert.equal(layout.final, 4);
  assert.deepEqual(layout.work, [true, false, false, true, false], "the failed tool and the failure card stay visible");
  const superseded = [say("old-f", "Stale answer.", "final", "succeeded", "A1"), say("c", "Partial", "commentary", "interrupted", "A2")];
  assert.equal(layoutTurn(superseded, { busy: false }).final, -1, "an earlier attempt's answer is not this attempt's");
});

test("typed unspecified messages never invent a final answer", () => {
  const items = [say("a1", "Looking.", "unspecified"), tool("t1", "succeeded"), say("a2", "Done.", "unspecified")];
  const layout = layoutTurn(items, { busy: false });
  assert.equal(layout.final, -1);
  assert.deepEqual(layout.work, [false, false, false]);
});

test("pending requests, notices, failures, interruptions and unknown work never fold", () => {
  const pending: ThreadItem = { id: "p", kind: "approval", question: "Allow?", at };
  const answered: ThreadItem = { id: "q", kind: "approval", question: "Allow?", answer: "yes", at };
  const notice: ThreadItem = { id: "n", kind: "notice", level: "warn", text: "Heads up", at };
  const items = [pending, answered, notice, tool("f", "failed"), tool("i", "interrupted"), tool("u", "unknown"), tool("s", "succeeded"), say("a", "Done.", "final")];
  assert.deepEqual(layoutTurn(items, { busy: false }).work, [false, true, false, false, false, false, true, false]);
});

for (const outcome of ["running", "failed", "denied", "interrupted", "unknown"] as const) {
  test(`typed ${outcome} messages and reasoning remain visible before a final answer`, () => {
    const items = [say("partial", "Partial output", "commentary", outcome), think("reason", outcome), say("answer", "Answer", "final")];
    assert.deepEqual(layoutTurn(items, { busy: false }).work, [false, false, false]);
  });
}
