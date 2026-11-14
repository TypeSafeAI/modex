import assert from "node:assert/strict";
import type { TaskContextEvidence } from "../src/shared/task-context-evidence.js";

/** Full selected-graph equality plus the one independently scoped mock-attempt receipt. */
export function admittedTaskContext(actual: TaskContextEvidence | undefined, expected: TaskContextEvidence, threadId: string, turnId: string): void {
  assert.ok(actual); const { capabilities, ...selected } = actual;
  assert.deepEqual(selected, { ...expected, revision: expected.revision + 1 });
  assert.equal(capabilities?.length, 1); const receipt = capabilities![0]!;
  assert.equal(receipt.turn.thread, threadId); assert.equal(receipt.turn.turn, turnId); assert.equal(receipt.turn.backend, "mock");
  assert.deepEqual(receipt.capability, { state: "unavailable", reason: "unsupported-adapter" });
}
