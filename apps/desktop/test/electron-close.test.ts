import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { closeWithDiagnostics } from "./support/electron-close.js";

function fixture() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  let calls = 0;
  const child = { pid: 4321, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  return { child, resolve, reject, calls: () => calls, app: { close: () => { calls++; return pending; }, process: () => child } };
}

test("an ordinary Electron close cancels diagnostics and runs once", async () => {
  const f = fixture();
  let samples = 0;
  const closing = closeWithDiagnostics(f.app, "/unused", { afterMs: 5, sample: async () => { samples++; } });
  f.resolve();
  await closing;
  await delay(20);
  assert.equal(samples, 0);
  assert.equal(f.calls(), 1);
});

test("pending Electron close samples its live child without settling or retrying close", async () => {
  const f = fixture();
  let sampled!: () => void;
  const observation = new Promise<void>(resolve => { sampled = resolve; });
  let settled = false;
  let samples = 0;
  let argumentsSeen: { pid: number; output: string } | undefined;
  const closing = closeWithDiagnostics(f.app, "/diagnostic-output", { afterMs: 5, sample: async (pid, output) => {
    argumentsSeen = { pid, output };
    samples++;
    sampled();
  } });
  void closing.then(() => { settled = true; });
  await observation;
  assert.deepEqual(argumentsSeen, { pid: f.child.pid, output: "/diagnostic-output" });
  assert.equal(settled, false);
  assert.equal(f.calls(), 1);
  await delay(20);
  assert.equal(samples, 1);
  f.resolve();
  await closing;
});

test("a failed diagnostic preserves the original Electron close rejection", async () => {
  const f = fixture();
  let sampled!: () => void;
  const observation = new Promise<void>(resolve => { sampled = resolve; });
  const original = new Error("original close failure");
  const closing = closeWithDiagnostics(f.app, "/unused", { afterMs: 5, sample: async () => {
    sampled();
    throw new Error("sampler unavailable");
  } });
  const rejected = assert.rejects(closing, error => error === original);
  await observation;
  f.reject(original);
  await rejected;
  assert.equal(f.calls(), 1);
});

test("an exited child is not sampled even while Electron close remains pending", async () => {
  const f = fixture();
  f.child.exitCode = 0;
  let samples = 0;
  const closing = closeWithDiagnostics(f.app, "/unused", { afterMs: 5, sample: async () => { samples++; } });
  await delay(20);
  assert.equal(samples, 0);
  f.resolve();
  await closing;
  assert.equal(f.calls(), 1);
});

test("an unavailable process handle does not replace the original close operation", async () => {
  let calls = 0;
  const app = { process: () => { throw new Error("process handle unavailable"); }, close: async () => { calls++; } };
  await closeWithDiagnostics(app, "/unused", { afterMs: 5, sample: async () => { assert.fail("no child to sample"); } });
  assert.equal(calls, 1);
});
