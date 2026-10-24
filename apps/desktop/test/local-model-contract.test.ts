import test from "node:test";
import assert from "node:assert/strict";
import { capabilityStatus, modelKey, threadTarget, type QualificationConfiguration, type CapabilityEvidence } from "../src/shared/local-models.js";

const configuration: QualificationConfiguration = {
  schema: 1, harness: "codex", cliVersion: "0.163.0",
  model: { schema: 1, connection: { id: "local-a", revision: 1 }, id: "org/Model:Q4 exact" },
  runtime: { name: "fixture", version: "1", modelRevision: "weights-1", templateRevision: "template-1", toolParserRevision: "parser-1" },
  settingsRevision: "settings-1", effectiveContextTokens: 32768,
  effectiveSettings: { providerId: "fixture-provider", reasoningEffort: "low", reasoningSummary: null, serviceTier: null,
    approvalPolicy: "untrusted", sandbox: "read-only", networkAccess: false, writableRoots: [], toolsetRevision: "native-tools-1" },
};
const evidence: CapabilityEvidence = { capability: "tools", status: "supported", source: "native-test", configuration, receipt: "fixture-receipt", observedAt: "2026-10-22T00:00:00Z" };

test("model identity preserves opaque names and separates endpoints and revisions", () => {
  const model = configuration.model;
  assert.notEqual(modelKey(model), modelKey({ ...model, connection: { id: "local-b", revision: 1 } }));
  assert.notEqual(modelKey(model), modelKey({ ...model, connection: { id: "local-a", revision: 2 } }));
  assert.notEqual(modelKey(model), modelKey({ ...model, id: model.id.toLowerCase() }));
  assert.notEqual(modelKey({ ...model, id: "a:b", connection: { id: "c", revision: 1 } }), modelKey({ ...model, id: "b", connection: { id: "c:a", revision: 1 } }));
});

test("legacy threads keep harness, model, account and resume semantics without migration writes", () => {
  for (const backend of ["codex", "claude", "mock"] as const) {
    const thread = { backend, model: "original", sessionHandle: "native-session", codexAccount: "cli" };
    const before = JSON.stringify(thread);
    assert.deepEqual(threadTarget(thread), { kind: "legacy", backend, model: "original", account: "cli", resume: "native-session" });
    assert.equal(JSON.stringify(thread), before);
  }
  assert.deepEqual(threadTarget({ backend: "codex" }), { kind: "legacy", backend: "codex", model: undefined, account: undefined, resume: undefined });
});

test("metadata, a greeting and other capabilities cannot qualify native tool use", () => {
  assert.equal(capabilityStatus("tools", configuration, []), "unknown");
  assert.equal(capabilityStatus("tools", configuration, [{ ...evidence, source: "metadata" }]), "unknown");
  assert.equal(capabilityStatus("resume", configuration, [evidence]), "unknown");
  assert.equal(capabilityStatus("tools", configuration, [evidence]), "supported");
  assert.equal(capabilityStatus("tools", configuration, [{ ...evidence, status: "unsupported" }]), "unsupported");
});

test("qualification expires when any tested native configuration changes or is unknown", () => {
  const changes: QualificationConfiguration[] = [
    { ...configuration, cliVersion: "next" }, { ...configuration, harness: "claude" },
    { ...configuration, model: { ...configuration.model, id: "another" } },
    { ...configuration, model: { ...configuration.model, connection: { id: "local-a", revision: 2 } } },
    { ...configuration, settingsRevision: "settings-2" }, { ...configuration, effectiveContextTokens: 8192 },
    ...["version", "modelRevision", "templateRevision", "toolParserRevision"].flatMap(key => [
      { ...configuration, runtime: { ...configuration.runtime, [key]: "changed" } },
      { ...configuration, runtime: { ...configuration.runtime, [key]: null } },
    ]),
  ];
  for (const changed of changes) assert.equal(capabilityStatus("tools", changed, [evidence]), "unknown");
  const unknown = { ...configuration, runtime: { ...configuration.runtime, modelRevision: null } };
  assert.equal(capabilityStatus("tools", unknown, [{ ...evidence, configuration: unknown }]), "unknown");
});

test("conflicting, unreceipted or undated observations cannot certify support", () => {
  assert.equal(capabilityStatus("tools", configuration, [evidence, { ...evidence, status: "unsupported" }]), "unknown");
  assert.equal(capabilityStatus("tools", configuration, [{ ...evidence, receipt: "" }]), "unknown");
  assert.equal(capabilityStatus("tools", configuration, [{ ...evidence, observedAt: "invalid" }]), "unknown");
});

test("additive local targets preserve exact identity and refuse corrupt targets rather than cloud fallback", () => {
  const localTarget = { schema: 1 as const, harness: "codex" as const, model: configuration.model };
  assert.deepEqual(threadTarget({ backend: "codex", localTarget }), { kind: "local", target: localTarget });
  for (const target of [null, {}, { ...localTarget, schema: 2 }, { ...localTarget, harness: "claude" }, { ...localTarget, model: { ...configuration.model, connection: { id: "a", revision: 0 } } }]) {
    assert.throws(() => threadTarget({ backend: "codex", localTarget: target }), /local target/i);
  }
});

test("qualification binds effective settings values, not just a caller-supplied revision", () => {
  for (const settings of [
    { ...configuration.effectiveSettings, providerId: "another" },
    { ...configuration.effectiveSettings, reasoningEffort: "high" },
    { ...configuration.effectiveSettings, reasoningSummary: "detailed" },
    { ...configuration.effectiveSettings, serviceTier: "fast" },
    { ...configuration.effectiveSettings, approvalPolicy: "never" },
    { ...configuration.effectiveSettings, sandbox: "workspace-write" as const },
    { ...configuration.effectiveSettings, networkAccess: true },
    { ...configuration.effectiveSettings, writableRoots: ["/another-root"] },
    { ...configuration.effectiveSettings, toolsetRevision: "tools-2" },
  ]) assert.equal(capabilityStatus("tools", { ...configuration, effectiveSettings: settings }, [evidence]), "unknown");
});
