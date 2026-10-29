import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * Product admission of local execution stays closed until #379 AC6 is qualified: Codex's redirect handling
 * and managed-policy precedence (LM-5, #380). Main therefore never constructs `LocalExecution`; the runner
 * seam exists for fixtures and explicitly requested native qualification only, and without it every local
 * selection or persisted target is refused (runner-local-models tests). No flag or renderer option opens it.
 */
test("main does not wire local execution into the product runner", () => {
  const source = fs.readFileSync(new URL("../../src/main/index.ts", import.meta.url), "utf8");
  assert.equal(/local-models\/execution\.js/.test(source), false, "main/index.ts imports the local execution module");
  assert.equal(/new LocalExecution\(/.test(source), false, "main/index.ts constructs LocalExecution");
  assert.equal(/localExecution\s*[:,}]/.test(source), false, "main/index.ts injects localExecution into the runner");
});
