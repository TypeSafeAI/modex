import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { TaskContextCapture, type CaptureReader, type CaptureClock } from "../src/main/engine/task-context-capture.js";
import { gitRepo, tmpdir } from "./helpers.js";
import type { ContextSource, ContextTarget } from "../src/shared/task-context-evidence.js";

const source: ContextSource = { kind: "human", actionId: "select-1", at: "2026-11-13T11:00:00.000Z" };
const target = (name: string): ContextTarget => ({ kind: "file", path: name });
const signal = () => new AbortController().signal;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const absentHead = async () => ({ state: "unavailable", reason: "not-repository" }) as const;
function gate() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function clock() {
  let now = Date.parse("2026-11-13T11:00:00.000Z"), serial = 0;
  const timers = new Map<number, { at: number; callback(): void }>();
  const api: CaptureClock = { now: () => now, setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { at: now + delay, callback }); return id; }, clearTimeout: id => { timers.delete(id as number); } };
  return { api, advance(ms: number) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); } } };
}

test("capture records a real file digest and HEAD observation without returning file contents", async () => {
  const cwd = gitRepo(); await fs.writeFile(path.join(cwd, "input.txt"), "abc");
  const rows = await new TaskContextCapture().capture(cwd, [target("input.txt")], source, "selected", signal());
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.revision, { state: "available", algorithm: "sha256", digest: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", bytes: 3 });
  assert.equal(rows[0]!.repository.state, "available");
  assert.deepEqual(rows[0]!.source, source); assert.equal(rows[0]!.phase, "selected");
  assert.ok(rows[0]!.finishedAt >= rows[0]!.startedAt);
  assert.equal(Object.hasOwn(rows[0]!, "body"), false);
});

test("capture retains missing, traversal, external symlink and nonregular targets as unavailable", async () => {
  const cwd = tmpdir("modex-context-files-"), outside = tmpdir("modex-context-outside-");
  await fs.writeFile(path.join(outside, "secret"), "outside");
  await fs.symlink(path.join(outside, "secret"), path.join(cwd, "link"));
  await fs.mkdir(path.join(cwd, "folder"));
  const rows = await new TaskContextCapture().capture(cwd, [target("missing"), target("../secret"), target("link"), target("folder")], source, "selected", signal());
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map(x => x.revision), [{ state: "unavailable", reason: "missing" }, { state: "unavailable", reason: "outside" }, { state: "unavailable", reason: "outside" }, { state: "unavailable", reason: "not-regular" }]);
  assert.equal(JSON.stringify(rows).includes(outside), false);
});

test("per-file bound accepts the limit and retains an oversized file's identity", async () => {
  const cwd = tmpdir("modex-context-size-");
  for (const [name, size] of [["at", 25 * 1024 * 1024], ["over", 25 * 1024 * 1024 + 1]] as const) { const f = await fs.open(path.join(cwd, name), "w"); await f.truncate(size); await f.close(); }
  const rows = await new TaskContextCapture().capture(cwd, [target("at"), target("over")], source, "selected", signal());
  assert.equal(rows[0]!.revision.state, "available");
  assert.deepEqual(rows[1]!.revision, { state: "unavailable", reason: "too-large" });
  assert.equal(rows[1]!.target.kind === "file" && rows[1]!.target.path, "over");
});

test("three concurrent batches share two actual read slots and retain all ordered targets", async () => {
  const held = gate(); let active = 0, peak = 0, started = 0;
  const reader: CaptureReader = async () => { active++; started++; peak = Math.max(peak, active); try { await held.promise; return { state: "unavailable", reason: "missing" }; } finally { active--; } };
  const service = new TaskContextCapture({ reader, head: absentHead });
  const pending = Array.from({ length: 3 }, (_, batch) => service.capture("/fixture", Array.from({ length: 4 }, (_, i) => target(`${batch}-${i}`)), source, "selected", signal()));
  await tick(); assert.equal(started, 2); held.resolve();
  const rows = await Promise.all(pending); assert.equal(peak, 2);
  assert.deepEqual(rows.map(xs => xs.map(x => x.target)), Array.from({ length: 3 }, (_, batch) => Array.from({ length: 4 }, (_, i) => target(`${batch}-${i}`))));
});

test("Stop settles callers but does not release an unresolved OS-read slot prematurely", async () => {
  const held = gate(); let started = 0;
  const reader: CaptureReader = async () => { started++; await held.promise; return { state: "unavailable", reason: "missing" }; };
  const service = new TaskContextCapture({ reader, head: absentHead });
  const stop = new AbortController();
  const first = service.capture("/fixture", [target("a"), target("b"), target("c")], source, "selected", stop.signal);
  await tick(); assert.equal(started, 2); stop.abort();
  const cancelled = await first; assert.equal(cancelled.length, 3); assert.ok(cancelled.every(x => x.revision.state === "unavailable" && x.revision.reason === "budget"));
  const later = service.capture("/fixture", [target("later")], source, "selected", signal());
  await tick(); assert.equal(started, 2, "unsettled descriptor reads still own both global slots");
  held.resolve(); await later; assert.equal(started, 3);
});

test("queue capacity and elapsed deadline retain explicit budget receipts for every target", async () => {
  const held = gate(), time = clock(); let started = 0;
  const reader: CaptureReader = async () => { started++; await held.promise; return { state: "unavailable", reason: "missing" }; };
  const service = new TaskContextCapture({ reader, head: absentHead, clock: time.api });
  const pending = Array.from({ length: 70 }, (_, i) => service.capture("/fixture", [target(`f${i}`)], source, "selected", signal()));
  await tick(); assert.equal(started, 2);
  const overflow = await Promise.all(pending.slice(66));
  assert.ok(overflow.every(xs => xs[0]!.revision.state === "unavailable" && xs[0]!.revision.reason === "budget"));
  time.advance(2000); const rows = await Promise.all(pending);
  assert.equal(rows.flat().length, 70); assert.equal(started, 2);
  assert.ok(rows.flat().every(x => x.revision.state === "unavailable" && x.revision.reason === "budget"));
  held.resolve(); await tick();
});

test("aggregate read budget keeps all five targets and never admits a fifth 25 MiB hash", async () => {
  const cwd = tmpdir("modex-context-total-");
  for (let i = 0; i < 5; i++) { const f = await fs.open(path.join(cwd, `f${i}`), "w"); await f.truncate(25 * 1024 * 1024); await f.close(); }
  const rows = await new TaskContextCapture().capture(cwd, Array.from({ length: 5 }, (_, i) => target(`f${i}`)), source, "selected", signal());
  assert.equal(rows.length, 5);
  assert.equal(rows.filter(r => r.revision.state === "available").length, 4);
  assert.deepEqual(rows[4]!.revision, { state: "unavailable", reason: "budget" });
});

test("replacement of an ancestor during a real descriptor read cannot publish an outside hash", async t => {
  const cwd = tmpdir("modex-context-rename-"), outside = tmpdir("modex-context-rename-outside-");
  await fs.mkdir(path.join(cwd, "sub"));
  await fs.writeFile(path.join(cwd, "sub/input"), "abc"); await fs.writeFile(path.join(outside, "input"), "outside");
  const originalOpen = fs.open; let replaced = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === path.join(cwd, "sub/input")) {
      const read = handle.read.bind(handle);
      t.mock.method(handle, "read", async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await read(buffer, offset, length, position);
        if (!replaced) { replaced = true; await fs.rename(path.join(cwd, "sub"), path.join(cwd, "retained")); await fs.symlink(outside, path.join(cwd, "sub")); }
        return result;
      });
    }
    return handle;
  });
  const rows = await new TaskContextCapture().capture(cwd, [target("sub/input")], source, "selected", signal());
  assert.ok(replaced); assert.deepEqual(rows[0]!.revision, { state: "unavailable", reason: "changed-during-read" });
});

test("a stalled HEAD read cannot outlive the capture deadline or erase successful file receipts", async () => {
  const time = clock(), entered = gate();
  const reader: CaptureReader = async () => { entered.resolve(); return { state: "available", algorithm: "sha256", digest: "b".repeat(64), bytes: 0 }; };
  const service = new TaskContextCapture({ reader, head: async () => new Promise(() => {}), clock: time.api });
  const pending = service.capture("/fixture", [target("a")], source, "after-native-result", signal());
  await entered.promise; await tick(); time.advance(2000);
  const rows = await pending; assert.equal(rows[0]!.revision.state, "available"); assert.deepEqual(rows[0]!.repository, { state: "unavailable", reason: "budget" });
});
