import assert from "node:assert/strict";
import { test } from "node:test";
import { UpdateInstallation } from "../src/main/engine/update-installation.js";

const release = { version: "0.0.11", url: "https://github.com/TypeSafeAI/modex/releases/tag/v0.0.11" };
const archive = { version: release.version, arch: "arm64" as const, size: 42, sha256: "ab".repeat(32) };
function harness(overrides: Partial<ConstructorParameters<typeof UpdateInstallation>[0]> = {}) {
  const events: string[] = [];
  let downloads = 0, downloadedClosed = 0, stagedClosed = 0, installs = 0;
  const service = new UpdateInstallation({ enabled: true, parent: "/private/update", runningApp: "/Applications/Modex.app", arch: "arm64",
    checker: { check: async () => release, archive: () => archive },
    changed: state => events.push(state.phase),
    download: async (_candidate, options) => { downloads++; options.progress(42); return { file: "/private/update/download.zip", directory: "/private/update/download", sha512: "verified-digest", dispose: async () => { downloadedClosed++; } }; },
    stage: async () => ({ archive: "/private/update/verified.zip", bundle: "/private/update/Modex.app", dispose: async () => { stagedClosed++; } }),
    verify: async () => {},
    restart: async () => { installs++; return { outcome: "staged" }; },
    ...overrides,
  });
  return { service, events, counts: () => ({ downloads, downloadedClosed, stagedClosed, installs }) };
}

test("installation controller coalesces downloads and authenticates before exposing Ready", async () => {
  let verified = false;
  const h = harness({ verify: async input => { assert.equal(input.version, "0.0.11"); verified = true; } });
  const first = h.service.download();
  assert.equal(first, h.service.download());
  const ready = await first;
  assert.equal(verified, true);
  assert.equal(ready.phase, "ready");
  assert.deepEqual(h.counts(), { downloads: 1, downloadedClosed: 1, stagedClosed: 0, installs: 0 });
  assert.ok(h.events.indexOf("verifying") < h.events.indexOf("ready"));
  assert.equal((await h.service.install()).phase, "staged");
  await assert.rejects(h.service.install(), /not ready/i);
  assert.equal(h.counts().installs, 1);
  await h.service.dispose();
});

test("failed publisher verification never becomes ready and removes both temporary archives", async () => {
  let fail = true;
  const h = harness({ verify: async () => { if (fail) throw new Error("wrong publisher"); } });
  assert.equal((await h.service.download()).phase, "error");
  assert.equal(h.events.includes("ready"), false);
  assert.deepEqual(h.counts(), { downloads: 1, downloadedClosed: 1, stagedClosed: 1, installs: 0 });
  await assert.rejects(h.service.install(), /not ready/i);
  fail = false;
  assert.equal((await h.service.download()).phase, "ready");
  await h.service.dispose();
});

test("cancelling during verification cannot publish its late result as ready", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const verifying = new Promise<void>(resolve => { entered = resolve; });
  const h = harness({ verify: async () => { entered(); await pending; } });
  const downloading = h.service.download();
  await verifying;
  h.service.cancel();
  finish();
  assert.equal((await downloading).phase, "available");
  assert.equal(h.events.includes("ready"), false);
  assert.equal(h.counts().stagedClosed, 1);
  await h.service.dispose();
});

test("restart preflight refusal keeps a verified candidate, while unknown failures prohibit retry", async () => {
  let fail = false;
  let calls = 0;
  const h = harness({ restart: async () => { calls++; if (fail) throw new Error("unknown native failure"); return { outcome: "blocked", message: "Close the terminal first." }; } });
  await h.service.download();
  assert.equal((await h.service.install()).phase, "ready");
  assert.equal(h.service.state().message, "Close the terminal first.");
  fail = true;
  assert.equal((await h.service.install()).phase, "uncertain");
  await assert.rejects(h.service.install(), /not ready/i);
  await assert.rejects(h.service.download(), /restart recovery/i);
  assert.equal(calls, 2);
  await h.service.dispose();
});

test("disabled builds never check or download and a missing ZIP keeps installation unavailable", async () => {
  const disabled = harness({ enabled: false, checker: { check: async () => assert.fail("network disabled"), archive: () => null } });
  assert.equal((await disabled.service.check()).phase, "disabled");
  await assert.rejects(disabled.service.download(), /disabled/i);
  const missing = harness({ checker: { check: async () => release, archive: () => null } });
  assert.equal((await missing.service.check()).phase, "available");
  assert.equal(missing.service.state().installable, false);
  assert.equal((await missing.service.download()).phase, "error");
  assert.equal(missing.counts().downloads, 0);
  await missing.service.dispose();
});

test("a second cancellation during slow cleanup cannot strand the terminal state", async () => {
  let clean!: () => void;
  let cleaning!: () => void;
  const cleanup = new Promise<void>(resolve => { clean = resolve; });
  const entered = new Promise<void>(resolve => { cleaning = resolve; });
  let finishVerify!: () => void;
  let verifying!: () => void;
  const verification = new Promise<void>(resolve => { finishVerify = resolve; });
  const prepared = new Promise<void>(resolve => { verifying = resolve; });
  const h = harness({
    stage: async () => ({ archive: "/private/update/verified.zip", bundle: "/private/update/Modex.app", dispose: async () => { cleaning(); await cleanup; } }),
    verify: async () => { verifying(); await verification; },
  });
  const work = h.service.download();
  await prepared;
  h.service.cancel();
  finishVerify();
  await entered;
  h.service.cancel();
  clean();
  await work;
  assert.equal(h.service.state().phase, "available");
  await h.service.dispose();
});

test("partial service shutdown has a distinct recovery state and cannot start another download", async () => {
  const h = harness({ restart: async () => ({ outcome: "recovery" }) });
  await h.service.download();
  assert.equal((await h.service.install()).phase, "recovery");
  assert.match(h.service.state().message!, /quit/i);
  await assert.rejects(h.service.download(), /recovery/i);
  await assert.rejects(h.service.install(), /not ready/i);
  await h.service.dispose();
});

test("late native staging updates recovery without repeating installation or regressing to uncertainty", async () => {
  const h = harness({ restart: async () => {
    h.service.observeRestart("staged");
    return { outcome: "uncertain" };
  } });
  // Ignore native observations without an admitted restart.
  h.service.observeRestart("uncertain");
  assert.equal(h.service.state().phase, "idle");
  assert.equal(h.service.state().canRestart, false);
  await h.service.download();
  assert.equal((await h.service.install()).phase, "staged");
  assert.equal(h.service.state().canRestart, true);
  h.service.observeRestart("uncertain");
  assert.equal(h.service.state().phase, "staged");
  await assert.rejects(h.service.download(), /recovery/i);
  await h.service.dispose();
});
