import test from "node:test";
import assert from "node:assert/strict";
import { previewApproval, validateRules } from "../src/main/engine/approvals/preview.js";
import { DEFAULT_APPROVAL_GATE, type ApprovalPreviewRequest } from "../src/shared/types.js";

const rule = { id: "tests", when: "run tests", decision: "allow" as const, enabled: true, project: "/project", match: "Bash: npm test*" };
const request: ApprovalPreviewRequest = { projectId: "p", rules: [rule], backend: "claude", tool: "Bash", title: "$ npm test", mode: "agent", escalation: false };
const context = { project: (id: string) => id === "p" ? { path: "/project", name: "Project" } : undefined, config: DEFAULT_APPROVAL_GATE, jev: async () => ({ transport: null, model: "jev-latest" }) };

test("preview evaluates the draft while the live gate is off and uses the stored project root", async () => {
  const before = structuredClone(request);
  const result = await previewApproval(request, context);
  assert.equal(result.decision, "allow");
  assert.equal(result.gateEnabled, false);
  assert.equal(result.jevAvailable, false);
  assert.equal(result.rule?.id, rule.id);
  assert.deepEqual(request, before);
  assert.equal((await previewApproval({ ...request, rules: [{ ...rule, project: "/other" }] }, context)).decision, "ask");
  assert.equal((await previewApproval({ ...request, rules: [{ ...rule, match: undefined }] }, context)).decision, "ask");
});

test("preview reuses Jev and preserves safety downgrades and failure diagnostics", async () => {
  let state: unknown;
  const result = await previewApproval(request, { ...context, jev: async () => ({ model: "saved-model", transport: async (req) => {
    assert.equal(req.model, "saved-model");
    state = req.state;
    return { answers: { destructive: { type: "noul", noul: 0.9 } } };
  } }) });
  assert.equal(result.decision, "ask");
  assert.equal(result.downgraded, "destructive");
  assert.equal(result.destructive, 0.9);
  assert.equal((state as { project: { name: string } }).project.name, "Project");
  assert.equal((await previewApproval({ ...request, escalation: true }, context)).downgraded, "escalation");
  const failed = await previewApproval({ ...request, rules: [{ ...rule, match: undefined }] }, { ...context, jev: async () => ({ model: "jev", transport: async () => { throw new Error("offline"); } }) });
  assert.equal(failed.decision, "ask");
  assert.match(failed.jevError!, /offline/);
  const unavailable = await previewApproval(request, { ...context, jev: async () => { throw new Error("key lookup failed"); } });
  assert.equal(unavailable.decision, "allow", "exact matches survive judge setup failure, as in the runner");
  assert.equal(unavailable.jevAvailable, false);
  assert.equal(unavailable.jevError, "key lookup failed");
});

test("preview rejects invalid inputs before resolving the judge", async () => {
  const ctx = { ...context, jev: async () => { assert.fail("must validate first"); } };
  for (const patch of [{ projectId: "missing" }, { mode: "bad" }, { backend: "mock" }, { title: "" }, { tool: "" }, { escalation: "yes" }, { rules: [{}] }]) {
    await assert.rejects(previewApproval({ ...request, ...patch }, ctx));
  }
});

test("rule validation refuses malformed rules rather than silently dropping a draft", () => {
  for (const rules of [null, [{}], [rule, rule], [{ ...rule, when: " " }], [{ ...rule, decision: "always" }], [{ ...rule, project: "relative" }], [{ ...rule, match: "*" }]]) {
    assert.throws(() => validateRules(rules));
  }
  assert.deepEqual(validateRules([{ ...rule, when: " run tests ", match: " Bash: npm test* " }]), [rule]);
  assert.deepEqual(validateRules([]), []);
});
