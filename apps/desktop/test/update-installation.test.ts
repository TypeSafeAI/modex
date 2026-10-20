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
  const failed = await h.service.download();
  assert.equal(failed.phase, "error");
  assert.match(failed.message!, /could not be downloaded or verified/);
  assert.equal(failed.detail, "wrong publisher", "the real reason travels with the generic message");
  assert.equal(h.events.includes("ready"), false);
  assert.deepEqual(h.counts(), { downloads: 1, downloadedClosed: 1, stagedClosed: 1, installs: 0 });
  await assert.rejects(h.service.install(), /not ready/i);
  fail = false;
  const ready = await h.service.download();
  assert.equal(ready.phase, "ready");
  assert.equal(ready.detail, undefined, "a later success clears the old reason");
  await h.service.dispose();
});

test("a failure's detail is one bounded line, and a cancellation has none", async () => {
  const long = harness({ stage: async () => { throw new Error(`Invalid package /private/update/verify-1/Modex.app/Contents/Resources/app.asar\n    at open ${"x".repeat(600)}`); } });
  const failed = await long.service.download();
  assert.equal(failed.phase, "error");
  assert.ok(failed.detail!.startsWith("Invalid package /private/update/verify-1/Modex.app/Contents/Resources/app.asar at open "));
  assert.ok(!failed.detail!.includes("\n") && failed.detail!.length <= 300);
  await long.service.dispose();
  let finish!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const verifying = new Promise<void>(resolve => { entered = resolve; });
  const cancelled = harness({ verify: async () => { entered(); await pending; throw new Error("aborted mid-verification"); } });
  const downloading = cancelled.service.download();
  await verifying;
  cancelled.service.cancel();
  finish();
  const after = await downloading;
  assert.equal(after.phase, "available");
  assert.equal(after.message, "Update preparation cancelled.");
  assert.equal(after.detail, undefined, "a cancellation is not a failure to diagnose");
  await cancelled.service.dispose();
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

/** Resolves once the controller publishes `phase`, or rejects after a short wait. */
function reached(h: ReturnType<typeof harness>, phase: string) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`never reached ${phase}: ${h.events.join(",")}`)), 1000);
    const poll = () => { if (h.events.includes(phase)) { clearTimeout(timer); resolve(); } else setImmediate(poll); };
    poll();
  });
}

test("an automatic check downloads and verifies the update without a click", async () => {
  const h = harness({ autoDownload: true });
  await h.service.check();
  await reached(h, "ready");
  assert.equal(h.service.state().phase, "ready");
  assert.equal(h.counts().downloads, 1);
  assert.equal(h.events.includes("available"), false, "an automatic download never offers a Download button first");
  await h.service.check();
  assert.equal(h.counts().downloads, 1, "a later check keeps the verified update instead of downloading again");
  assert.equal(h.counts().installs, 0, "downloading never restarts by itself");
  await h.service.dispose();
});

test("without automatic download a check only offers the update", async () => {
  const h = harness();
  assert.equal((await h.service.check()).phase, "available");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.counts().downloads, 0);
  await h.service.dispose();
});

test("a cancelled automatic download is not restarted by later checks, but a click still downloads it", async () => {
  let finish!: () => void;
  let entered!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const verifying = new Promise<void>(resolve => { entered = resolve; });
  let hold = true;
  const h = harness({ autoDownload: true, verify: async () => { if (!hold) return; entered(); await pending; } });
  await h.service.check();
  await verifying;
  h.service.cancel();
  finish();
  await reached(h, "cancelling");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.service.state().phase, "available");
  await h.service.check();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.counts().downloads, 1, "the person declined this version");
  hold = false;
  assert.equal((await h.service.download()).phase, "ready");
  await h.service.dispose();
});

test("a failed automatic download retries only after the backoff", async () => {
  let clock = 1_000_000, fail = true;
  const h = harness({ autoDownload: true, now: () => clock, verify: async () => { if (fail) throw new Error("offline"); } });
  await h.service.check();
  await reached(h, "error");
  assert.equal(h.counts().downloads, 1);
  await h.service.check();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.counts().downloads, 1, "no retry storm on every focus");
  fail = false;
  clock += 60 * 60 * 1000;
  await h.service.check();
  await reached(h, "ready");
  assert.equal(h.counts().downloads, 2);
  await h.service.dispose();
});

test("install passes the relaunch choice to the restart coordinator", async () => {
  const seen: unknown[] = [];
  const h = harness({ restart: async (_candidate, options) => { seen.push(options); return { outcome: "staged" }; } });
  await h.service.download();
  assert.equal((await h.service.install({ relaunch: false })).phase, "staged");
  assert.deepEqual(seen, [{ relaunch: false }]);
  await h.service.dispose();
});
