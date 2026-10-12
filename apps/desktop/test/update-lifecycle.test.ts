import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { RestartAdmission } from "../src/main/engine/restart-admission.js";
import { UpdateInstallation } from "../src/main/engine/update-installation.js";
import { MacUpdateHandoff } from "../src/main/engine/update-mac-handoff.js";
import { UpdateRecovery } from "../src/main/engine/update-recovery.js";
import { UpdateRestartCoordinator } from "../src/main/engine/update-restart-coordinator.js";
import { readUpdateStartup } from "../src/main/engine/update-startup.js";
import { tmpdir } from "./helpers.js";

// Exercise the actual lifecycle services together, including the private HTTP feed
// and durable receipt. Native events and publisher verification are simulated: this
// is deliberately not evidence of a signed Squirrel installation or relaunch.
class NativeEvents extends EventEmitter {
  feed = "";
  checks = 0;
  private started!: () => void;
  readonly checked = new Promise<void>(resolve => { this.started = resolve; });
  setFeedURL(input: { url: string }): void { this.feed = input.url; }
  checkForUpdates(): void { this.checks++; this.started(); }
}
async function fixture(t: TestContext) {
  const home = tmpdir("update-lifecycle-");
  const archive = path.join(home, "verified.zip");
  const bytes = Buffer.from("simulated authenticated snapshot");
  await fs.writeFile(archive, bytes, { mode: 0o600 });
  const digest = createHash("sha512").update(bytes).digest("base64");
  const native = new NativeEvents();
  const recovery = new UpdateRecovery(home);
  const admission = new RestartAdmission();
  let prepares = 0, drains = 0, quits = 0;
  let installation!: UpdateInstallation;
  const handoff = new MacUpdateHandoff(native, state => coordinator.observeNative(state), 5_000);
  const coordinator = new UpdateRestartCoordinator({
    currentVersion: "0.0.10", native: handoff, recovery,
    holds: [() => admission.holdForRestart()],
    prepareRenderer: async () => {
      prepares++;
      return recovery.saveDrafts({ threads: [{ threadId: "thread-1", text: "unsent draft", attachments: [] }], projects: [], selectedThreadId: "thread-1", draft: null });
    },
    assertRendererPrepared: () => {}, releaseRenderer: () => {},
    drainServices: async () => { drains++; },
    changed: state => installation.observeRestart(state),
    quitAndInstall: () => { quits++; assert.equal(recovery.read().attempt?.outcome, "staged"); },
  });
  const release = { version: "0.0.11", url: "https://github.com/TypeSafeAI/modex/releases/tag/v0.0.11" };
  installation = new UpdateInstallation({
    enabled: true, parent: home, runningApp: "/simulated/Modex.app", arch: "arm64",
    checker: { check: async () => release, archive: () => ({ version: release.version, arch: "arm64", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }) },
    changed: () => {}, restart: candidate => coordinator.restart(candidate),
    download: async (_candidate, options) => { options.progress(bytes.length); return { file: archive, directory: home, sha512: digest, dispose: async () => {} }; },
    stage: async () => ({ archive, bundle: "/simulated/candidate/Modex.app", dispose: async () => {} }),
    verify: async () => {},
  });
  t.after(async () => {
    native.emit("error", new Error("test cleanup"));
    await installation.dispose();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { home, archive, bytes, native, recovery, admission, installation, counts: () => ({ prepares, drains, quits }) };
}

test("lifecycle refuses accepted work, then saves, hands off one snapshot and restores drafts only at the target version", async t => {
  const h = await fixture(t);
  assert.equal((await h.installation.check()).phase, "available");
  assert.equal((await h.installation.download()).phase, "ready");
  let finish!: () => void;
  const pending = h.admission.run(() => new Promise<void>(resolve => { finish = resolve; }));
  assert.equal((await h.installation.install()).phase, "ready");
  assert.deepEqual(h.counts(), { prepares: 0, drains: 0, quits: 0 });
  assert.equal(h.native.checks, 0);
  finish();
  await pending;
  const installing = h.installation.install();
  assert.equal(h.installation.install(), installing);
  await h.native.checked;
  assert.equal(h.recovery.read().attempt?.outcome, "uncertain");
  await assert.rejects(h.admission.run(() => assert.fail("work admitted during handoff")), /restart/i);
  const feed = await (await fetch(h.native.feed)).json() as { url: string; name: string };
  assert.deepEqual(Buffer.from(await (await fetch(feed.url)).arrayBuffer()), h.bytes);
  h.native.emit("update-downloaded", {}, "", feed.name, new Date(), feed.url);
  assert.equal((await installing).phase, "staged");
  assert.deepEqual(h.counts(), { prepares: 1, drains: 1, quits: 1 });
  assert.equal(h.native.checks, 1);
  // New store instances model the process boundary; app replacement is not simulated.
  const old = readUpdateStartup(new UpdateRecovery(h.home), "0.0.10");
  assert.equal(old.recovery?.outcome, "staged");
  assert.equal(old.drafts?.threads[0]?.text, "unsent draft");
  const target = readUpdateStartup(new UpdateRecovery(h.home), "0.0.11");
  assert.equal(target.recovery, null);
  assert.equal(target.drafts?.threads[0]?.text, "unsent draft");
  assert.equal(h.recovery.read().attempt?.outcome, "installed");
});

test("lifecycle preserves uncertainty across startup and late success updates the UI without another native attempt or quit", async t => {
  const h = await fixture(t);
  await h.installation.download();
  const installing = h.installation.install();
  await h.native.checked;
  const feed = await (await fetch(h.native.feed)).json() as { url: string; name: string };
  h.native.emit("error", new Error("native state unknown after admission"));
  assert.equal((await installing).phase, "uncertain");
  const interrupted = readUpdateStartup(new UpdateRecovery(h.home), "0.0.10");
  assert.equal(interrupted.recovery?.outcome, "uncertain");
  assert.equal(interrupted.drafts?.threads[0]?.text, "unsent draft");
  await assert.rejects(h.installation.download(), /recovery/i);
  await assert.rejects(h.installation.install(), /not ready/i);
  h.native.emit("update-downloaded", {}, "", feed.name, new Date(), feed.url);
  assert.equal(h.installation.state().phase, "staged");
  assert.equal(h.recovery.read().attempt?.outcome, "staged");
  assert.equal(h.admission.held, true);
  assert.deepEqual(h.counts(), { prepares: 1, drains: 1, quits: 0 });
  assert.equal(h.native.checks, 1);
  h.native.emit("error", new Error("late unrelated failure"));
  assert.equal(h.installation.state().phase, "staged");
});
