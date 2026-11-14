import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { TaskContextCapture, type CaptureClock } from "../src/main/engine/task-context-capture.js";
import { tmpdir } from "./helpers.js";

type Scope = "project" | "outside" | "unknown";
const observe = (capture: TaskContextCapture, cwd: string, directory: string, signal = new AbortController().signal) => Reflect.apply(Reflect.get(capture, "executionScope"), capture, [cwd, directory, signal]) as Promise<Scope>;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test("execution scope uses canonical directories, refusing outside symlinks and missing/non-directory paths", async () => {
  const capture = new TaskContextCapture(), root = tmpdir("modex-scope-root-"), outside = tmpdir("modex-scope-outside-");
  const inner = path.join(root, "inside"), link = path.join(root, "external"), file = path.join(root, "file.txt");
  await fs.mkdir(inner); await fs.symlink(outside, link, "dir"); await fs.writeFile(file, "unchanged");
  assert.equal(await observe(capture, root, inner), "project");
  assert.equal(await observe(capture, root, link), "outside");
  assert.equal(await observe(capture, root, path.join(root, "missing")), "unknown");
  assert.equal(await observe(capture, root, file), "unknown");
  assert.equal(await fs.readFile(file, "utf8"), "unchanged");
});

test("scope deadline settles callers while unresolved OS observations retain the two actual shared slots", async () => {
  const timers = new Set<() => void>(), releases: Array<() => void> = []; let entered = 0;
  const clock: CaptureClock = { now: () => 0, setTimeout: callback => { timers.add(callback); return callback; }, clearTimeout: value => { timers.delete(value as () => void); } };
  const scopeReader = async () => { entered++; await new Promise<void>(resolve => releases.push(resolve)); return "project"; };
  const capture = Reflect.construct(TaskContextCapture, [{ clock, scopeReader }]) as TaskContextCapture;
  const pending = Array.from({ length: 67 }, () => observe(capture, "/root", "/root/sub"));
  await tick(); assert.equal(entered, 2);
  assert.equal(await pending[66], "unknown", "two active plus 64 queued is the actual bound");
  for (const timeout of [...timers]) timeout();
  assert.deepEqual(await Promise.all(pending), Array(67).fill("unknown"));
  const next = observe(capture, "/root", "/root/sub"); await tick();
  assert.equal(entered, 2, "caller timeout cannot release an unresolved OS slot");
  releases[0]!(); await tick(); assert.equal(entered, 3);
  releases[2]!(); assert.equal(await next, "project");
  releases[1]!(); await tick();
});

test("aborted and relative scope requests do no directory read, and failed observations stay unknown", async () => {
  let calls = 0;
  const capture = Reflect.construct(TaskContextCapture, [{ scopeReader: async () => { calls++; throw Error("synthetic unavailable directory"); } }]) as TaskContextCapture;
  const controller = new AbortController(); controller.abort();
  assert.equal(await observe(capture, "/root", "/root/sub", controller.signal), "unknown");
  assert.equal(await observe(capture, "/root", "relative"), "unknown"); assert.equal(calls, 0);
  assert.equal(await observe(capture, "/root", "/root/sub"), "unknown"); assert.equal(calls, 1);
});
