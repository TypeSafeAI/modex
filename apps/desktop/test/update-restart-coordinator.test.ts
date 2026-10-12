import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { RestartAdmission } from "../src/main/engine/restart-admission.js";
import { AttachmentStore } from "../src/main/engine/attachments.js";
import { UpdateRecovery } from "../src/main/engine/update-recovery.js";
import { UpdateRestartCoordinator, type RestartCoordinatorOptions } from "../src/main/engine/update-restart-coordinator.js";

const candidate = { archive: "/private/test/update.zip", version: "0.0.11", size: 4, sha512: Buffer.alloc(64, 3).toString("base64") };

for (const change of ["missing", "replaced"] as const) {
  test(`restart refuses ${change} saved attachments before stopping services`, async t => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-restart-attachment-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const files = new AttachmentStore(path.join(home, "attachments"), {
      authorizeDraft: owner => owner.kind === "thread" && owner.threadId === "thread-1",
    });
    const draft = files.mintDraft({ kind: "thread", threadId: "thread-1" });
    const staged = files.stage([{ name: "draft.txt", data: Buffer.from("DATA").toString("base64") }], { draft });
    assert.deepEqual(staged.errors, []);
    const attachment = staged.staged[0]!;
    const recovery = new UpdateRecovery(home, (file, owner) => files.validateRecovery(file, owner));
    const revision = recovery.saveDrafts({ projects: [], draft: null, selectedThreadId: "thread-1",
      threads: [{ threadId: "thread-1", text: "", attachments: [attachment] }] });
    const recoveryFile = path.join(home, "update-recovery.json");
    const manifestFile = path.join(files.root, ".manifest.json");
    const before = fs.readFileSync(recoveryFile), manifestBefore = fs.readFileSync(manifestFile);
    const original = path.join(files.root, attachment.rel), preserved = path.join(home, "preserved-original");
    fs.renameSync(original, preserved);
    if (change === "replaced") fs.writeFileSync(original, "FAKE");
    const admission = new RestartAdmission();
    let drains = 0, nativeCalls = 0, releases = 0;
    const coordinator = new UpdateRestartCoordinator({
      currentVersion: "0.0.10", recovery,
      holds: [() => admission.holdForRestart()],
      // A clean autosave queue may acknowledge the existing revision without a new write.
      prepareRenderer: async () => revision,
      assertRendererPrepared: () => {},
      releaseRenderer: () => { releases++; },
      drainServices: async () => { drains++; },
      native: { state: "idle", stage: async (_snapshot, receipt) => {
        nativeCalls++;
        await receipt({ version: candidate.version, sha512: candidate.sha512, startedAt: new Date().toISOString() });
        return "staged";
      } },
      changed: () => {}, quitAndInstall: () => assert.fail("Invalid attachment must not restart the app"),
    });
    assert.equal((await coordinator.restart(candidate)).outcome, "blocked");
    assert.deepEqual({ drains, nativeCalls, releases }, { drains: 0, nativeCalls: 0, releases: 1 });
    assert.equal(await admission.run(() => "still usable"), "still usable");
    assert.deepEqual(fs.readFileSync(recoveryFile), before);
    assert.deepEqual(fs.readFileSync(manifestFile), manifestBefore);
    assert.equal(fs.readFileSync(preserved, "utf8"), "DATA");
    if (change === "replaced") assert.equal(fs.readFileSync(original, "utf8"), "FAKE");
    else assert.equal(fs.existsSync(original), false);
  });
}

function harness(t: TestContext, overrides: Partial<RestartCoordinatorOptions> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-restart-coordinator-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const recovery = new UpdateRecovery(home);
  const revision = recovery.saveDrafts({ projects: [], threads: [{ threadId: "thread-1", attachments: [], text: "preserved draft" }], selectedThreadId: "thread-1", draft: null });
  const admission = new RestartAdmission();
  const events: string[] = [];
  let nativeState: "idle" | "staging" | "staged" | "uncertain" = "idle";
  const native: RestartCoordinatorOptions["native"] = {
    get state() { return nativeState; },
    stage: async (_snapshot, receipt) => {
      await receipt({ version: candidate.version, sha512: candidate.sha512, startedAt: new Date().toISOString() });
      assert.equal(recovery.read().attempt?.outcome, "uncertain", "receipt is durable before native admission");
      nativeState = "staging";
      events.push("native");
      nativeState = "staged";
      return "staged";
    },
  };
  const coordinator = new UpdateRestartCoordinator({
    currentVersion: "0.0.10", recovery, native,
    holds: [() => { events.push("hold"); const release = admission.holdForRestart(); return () => { events.push("release"); release(); }; }],
    prepareRenderer: async () => { events.push("saved"); return revision; },
    assertRendererPrepared: () => {},
    releaseRenderer: () => { events.push("resume"); },
    drainServices: async () => { events.push("drain"); },
    changed: state => { events.push(state); },
    quitAndInstall: () => { events.push("quit"); assert.equal(recovery.read().attempt?.outcome, "staged"); },
    ...overrides,
  });
  return { coordinator, recovery, admission, events, native, revision, setNative: (state: typeof nativeState) => { nativeState = state; } };
}

test("restart saves and drains before durable native admission, then quits exactly once", async t => {
  const h = harness(t);
  assert.deepEqual(await h.coordinator.restart(candidate), { outcome: "staged" });
  assert.ok(h.events.indexOf("saved") < h.events.indexOf("drain"));
  assert.ok(h.events.indexOf("drain") < h.events.indexOf("native"));
  assert.ok(h.events.indexOf("native") < h.events.indexOf("quit"));
  assert.equal(h.events.filter(event => event === "quit").length, 1);
  assert.equal(h.admission.held, true);
  await assert.rejects(h.admission.run(() => assert.fail("late work started")), /restart/);
  await assert.rejects(h.coordinator.restart(candidate), /recovery|already/i);
});

for (const revoked of [false, true]) test(`renderer acknowledgment ${revoked ? "revoked" : "held"} while native staging determines automatic quit`, async t => {
  let valid = true, assertions = 0;
  const h = harness(t, { assertRendererPrepared: () => { assertions++; if (!valid) throw new Error("Renderer acknowledgment revoked."); } });
  h.native.stage = async (_snapshot, receipt) => {
    await receipt({ version: candidate.version, sha512: candidate.sha512, startedAt: new Date().toISOString() });
    h.setNative("staging");
    await Promise.resolve();
    valid = !revoked;
    h.setNative("staged");
    return "staged";
  };
  assert.deepEqual(await h.coordinator.restart(candidate), { outcome: "staged" });
  assert.equal(h.events.filter(event => event === "quit").length, revoked ? 0 : 1);
  assert.equal(h.recovery.read().attempt?.outcome, "staged");
  assert.equal(h.recovery.read().drafts?.threads[0]?.text, "preserved draft");
  assert.equal(h.admission.held, true); assert.equal(h.events.includes("resume"), false);
  assert.ok(assertions >= 4, "recheck the renderer after asynchronous native staging");
  h.coordinator.observeNative("staged"); h.coordinator.observeNative("uncertain");
  assert.equal(h.coordinator.state, "staged");
  assert.equal(h.events.filter(event => event === "quit").length, revoked ? 0 : 1);
});

test("renderer veto releases reversible holds and keeps services usable for a retry", async t => {
  let blocked = true;
  const h = harness(t, { prepareRenderer: async () => { if (blocked) throw new Error("Save or close Settings before restarting."); return 1; } });
  assert.deepEqual(await h.coordinator.restart(candidate), { outcome: "blocked", message: "Save or close Settings before restarting." });
  assert.equal(h.admission.held, false);
  assert.equal(h.events.includes("drain"), false);
  assert.equal(h.recovery.read().attempt, null);
  assert.ok(h.events.indexOf("release") < h.events.indexOf("resume"), "main admission must reopen before acknowledging renderer release");
  assert.equal(await h.admission.run(() => "still usable"), "still usable");
  blocked = false;
  assert.equal((await h.coordinator.restart(candidate)).outcome, "staged");
});

test("failure acquiring a later hold releases earlier ones without touching renderer or services", async t => {
  const admission = new RestartAdmission();
  const h = harness(t, { holds: [() => admission.holdForRestart(), () => { throw new Error("Close open terminal sessions before restarting."); }] });
  assert.equal((await h.coordinator.restart(candidate)).outcome, "blocked");
  assert.equal(admission.held, false);
  assert.equal(h.events.includes("saved"), false);
  assert.equal(h.events.includes("drain"), false);
});

test("partial service shutdown enters recovery without native handoff or reopening disposed services", async t => {
  const h = harness(t, { drainServices: async () => { throw new Error("one service failed after another disposed"); } });
  assert.equal((await h.coordinator.restart(candidate)).outcome, "recovery");
  assert.equal(h.admission.held, true);
  assert.equal(h.events.includes("resume"), false);
  assert.equal(h.events.includes("native"), false);
  assert.equal(h.events.includes("quit"), false);
  assert.equal(h.recovery.read().attempt, null);
  await assert.rejects(h.coordinator.restart(candidate), /recovery/i);
});

test("proven pre-native failure releases only this receipt while retaining recovery mode after shutdown", async t => {
  const h = harness(t);
  h.native.stage = async (_snapshot, receipt) => {
    await receipt({ version: candidate.version, sha512: candidate.sha512, startedAt: new Date().toISOString() });
    throw new Error("feed setup failed before checking");
  };
  assert.equal((await h.coordinator.restart(candidate)).outcome, "recovery");
  assert.equal(h.recovery.read().attempt, null);
  assert.equal(h.recovery.read().drafts?.threads[0]?.text, "preserved draft");
  assert.equal(h.admission.held, true);
  assert.equal(h.events.includes("quit"), false);
});

test("native uncertainty stays durable and late success never triggers an automatic quit", async t => {
  const h = harness(t);
  h.native.stage = async (_snapshot, receipt) => {
    await receipt({ version: candidate.version, sha512: candidate.sha512, startedAt: new Date().toISOString() });
    h.setNative("uncertain");
    return "uncertain";
  };
  assert.equal((await h.coordinator.restart(candidate)).outcome, "uncertain");
  assert.equal(h.recovery.read().attempt?.outcome, "uncertain");
  h.setNative("staged");
  h.coordinator.observeNative("staged");
  assert.equal(h.recovery.read().attempt?.outcome, "staged");
  assert.equal(h.coordinator.state, "staged");
  assert.equal(h.events.includes("quit"), false);
  h.coordinator.observeNative("uncertain");
  assert.equal(h.coordinator.state, "staged");
  await assert.rejects(h.coordinator.restart(candidate), /recovery|already/i);
});

test("concurrent restart clicks join one preparation and a late draft revision cannot be installed", async t => {
  let finish!: (revision: number) => void;
  const ready = new Promise<number>(resolve => { finish = resolve; });
  const h = harness(t, { prepareRenderer: () => ready, drainServices: async () => {
    h.recovery.saveDrafts({ projects: [], threads: [{ threadId: "thread-1", attachments: [], text: "newer input" }], selectedThreadId: "thread-1", draft: null });
  } });
  const first = h.coordinator.restart(candidate);
  const second = h.coordinator.restart(candidate);
  assert.equal(first, second);
  finish(h.revision);
  assert.equal((await first).outcome, "recovery");
  assert.equal(h.events.filter(event => event === "hold").length, 1);
  assert.equal(h.events.includes("native"), false);
  assert.equal(h.recovery.read().attempt, null);
});

test("stale renderer acknowledgment refuses restart before disposing services", async t => {
  const h = harness(t);
  h.recovery.saveDrafts({ projects: [], threads: [{ threadId: "thread-1", attachments: [], text: "newer input" }], selectedThreadId: "thread-1", draft: null });
  assert.equal((await h.coordinator.restart(candidate)).outcome, "blocked");
  assert.equal(h.events.includes("drain"), false);
  assert.equal(h.admission.held, false);
  assert.equal(h.recovery.read().attempt, null);
});

test("renderer navigation during service drain cannot admit a native update", async t => {
  let valid = true;
  const h = harness(t, { assertRendererPrepared: () => { if (!valid) throw new Error("Workspace changed."); }, drainServices: async () => { valid = false; } });
  assert.equal((await h.coordinator.restart(candidate)).outcome, "recovery");
  assert.equal(h.events.includes("native"), false);
  assert.equal(h.recovery.read().attempt, null);
  assert.equal(h.admission.held, true);
});
