import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function wire(proc: FakeProcess): void {
  let threads = 0;
  proc.stdin.on("data", data => {
    for (const line of data.toString().split("\n")) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.method === "initialize") proc.emitLine({ id: m.id, result: { userAgent: "synthetic-transport" } });
      else if (m.method === "model/list") proc.emitLine({ id: m.id, result: { data: [] } });
      else if (m.method === "thread/start") proc.emitLine({ id: m.id, result: { thread: { id: `thr-${++threads}` }, model: m.params.model, modelProvider: m.params.modelProvider } });
      else if (m.method === "turn/start") {
        proc.emitLine({ id: m.id, result: { turn: { id: `tu-${m.params.threadId}` } } });
        proc.emitLine({ method: "turn/started", params: { threadId: m.params.threadId, turn: { id: `tu-${m.params.threadId}` } } });
      }
    }
  });
}

test("a failed initialize pipe settles before the RPC timeout", async () => {
  const proc = new FakeProcess();
  proc.stdin.on("error", () => {}); // Test lifecycle separately; real-pipe controls detect uncaught errors.
  proc.stdin._write = (_chunk, _encoding, callback) => callback(Object.assign(new Error("private-input-sentinel"), { code: "EPIPE" }));
  const backend = new CodexBackend("fixture", fakeSpawn(proc).spawn);
  const discovery = backend.listModels().then(() => "success", () => "failed");
  try {
    assert.equal(await Promise.race([discovery, delay(1000).then(() => "pending")]), "failed");
    assert.ok(proc.killed);
  } finally { await backend.dispose(); await discovery; }
});

test("late old-stream errors stay consumed after replacement startup", async () => {
  const old = new FakeProcess(), current = new FakeProcess();
  wire(old); wire(current);
  const backend = new CodexBackend("fixture", fakeSpawn([old, current]).spawn);
  try {
    assert.deepEqual(await backend.listModels(), []);
    await backend.dispose();
    assert.deepEqual(await backend.listModels(), []);
    assert.doesNotThrow(() => old.stdin.emit("error", Object.assign(new Error("late-private-sentinel"), { code: "EPIPE" })));
    assert.deepEqual(await backend.listModels(), []);
    assert.equal(current.killed, false);
  } finally { await backend.dispose(); }
});

test("Stop after pipe failure retains the active turn until the child closes", async () => {
  const proc = new FakeProcess(); wire(proc);
  proc.holdStdio = true; proc.ignore.add("SIGKILL"); proc.stdin.on("error", () => {});
  const backend = new CodexBackend("fixture", fakeSpawn(proc).spawn), control = new AbortController();
  let settled = false;
  const running = backend.runTurn("synthetic fixture", { cwd: "/fixture", mode: "chat", plan: false, model: "" }, collectSink().sink, control.signal).then(result => { settled = true; return result; });
  try {
    await proc.waitFor(line => line.includes('"turn/start"')); await tick();
    proc.stdin._write = (_chunk, _encoding, callback) => callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    control.abort(); await tick();
    void backend.forceStop(); await tick();
    assert.equal(proc.exitCode, null);
    assert.equal(settled, false, "signal submission cannot release turn ownership before closure");
    proc.ignore.clear(); proc.close(null, "SIGKILL"); proc.releaseStdio(); await running;
  } finally {
    proc.ignore.clear(); proc.close(null, "SIGKILL"); proc.releaseStdio(); await running; await backend.dispose();
  }
});

test("closing input before initialized's write callback settles setup", async () => {
  const proc = new FakeProcess(); wire(proc);
  const original = proc.stdin.write.bind(proc.stdin);
  proc.stdin.write = ((chunk: unknown, ...args: unknown[]) => {
    if (String(chunk).includes('"method":"initialized"')) {
      setImmediate(() => proc.stdin.emit("close"));
      return false; // A local callback is deliberately missing; closure must reject its receipt.
    }
    return Reflect.apply(original, proc.stdin, [chunk, ...args]);
  }) as typeof proc.stdin.write;
  const backend = new CodexBackend("fixture", fakeSpawn(proc).spawn);
  const discovery = backend.listModels().then(() => "success", () => "failed");
  try {
    assert.equal(await Promise.race([discovery, delay(1000).then(() => "pending")]), "failed");
  } finally { await backend.dispose(); }
});

test("setup cancellation cannot release a failed generation before closure", async () => {
  const proc = new FakeProcess(); wire(proc);
  const spawn = fakeSpawn(proc), backend = new CodexBackend("fixture", spawn.spawn);
  await backend.listModels();
  proc.holdStdio = true; proc.ignore.add("SIGKILL");
  proc.stdin._write = (_chunk, _encoding, callback) => callback(Object.assign(new Error("private-setup-body"), { code: "EPIPE" }));
  const control = new AbortController(); let settled = false;
  const running = backend.runTurn("synthetic", { cwd: "/fixture", mode: "chat", plan: false, model: "" }, collectSink().sink, control.signal).then(result => { settled = true; return result; });
  try {
    await tick(); control.abort(); await tick();
    assert.equal(settled, false);
    await assert.rejects(backend.listModels(), error => String(error).includes("transport") && !JSON.stringify(error).includes("private-setup-body"));
    assert.equal(spawn.calls.length, 1);
    proc.ignore.clear(); proc.close(null, "SIGKILL"); await tick();
    assert.equal(settled, false, "exit without closed stdio still retains this generation");
    proc.releaseStdio(); assert.notEqual((await running).status, "completed");
  } finally { proc.ignore.clear(); proc.close(null, "SIGKILL"); proc.releaseStdio(); await running; await backend.dispose(); }
});

test("a failed shared server holds both turns, rejects replacement, and ignores late old events", async () => {
  const old = new FakeProcess(), next = new FakeProcess(); wire(old); wire(next);
  old.holdStdio = true; old.ignore.add("SIGKILL");
  const spawn = fakeSpawn([old, next]), backend = new CodexBackend("fixture", spawn.spawn);
  const control = new AbortController(), settled: string[] = [];
  const first = backend.runTurn("first", { cwd: "/one", mode: "chat", plan: false, model: "" }, collectSink().sink, control.signal).then(result => { settled.push(result.status); return result; });
  const second = backend.runTurn("second", { cwd: "/two", mode: "chat", plan: false, model: "" }, collectSink().sink, new AbortController().signal).then(result => { settled.push(result.status); return result; });
  try {
    for (let i = 0; i < 20 && old.sent(m => m.method === "turn/start").length < 2; i++) await tick();
    const starts = old.sent(m => m.method === "turn/start"); assert.equal(starts.length, 2);
    old.stdin._write = (_chunk, _encoding, callback) => callback(Object.assign(new Error("private-shared-body"), { code: "EPIPE" }));
    control.abort(); await tick();
    for (const m of starts) old.emitLine({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: `tu-${m.params.threadId}`, status: "completed" } } });
    old.emit("error", new Error("termination has not been confirmed")); await tick();
    assert.deepEqual(settled, []);
    await assert.rejects(backend.listModels(), /transport/); assert.equal(spawn.calls.length, 1);
    await backend.forceStop(); await tick(); assert.deepEqual(settled, []);
    old.ignore.clear(); old.close(null, "SIGKILL"); await tick(); assert.deepEqual(settled, []);
    old.releaseStdio();
    assert.equal((await first).status, "interrupted");
    const failed = await second; assert.equal(failed.status, "failed"); assert.match(failed.error ?? "", /transport/);
    assert.equal(JSON.stringify(failed).includes("private-shared-body"), false);
    assert.deepEqual(await backend.listModels(), []); assert.equal(spawn.calls.length, 2);
    old.stdin.emit("error", Object.assign(new Error("late-private-body"), { code: "EPIPE" }));
    old.stdout.emit("data", Buffer.from(JSON.stringify({ method: "turn/completed", params: { threadId: "old", turn: { status: "completed" } } }) + "\n"));
    old.emit("close", null, "SIGKILL"); await tick();
    assert.deepEqual(await backend.listModels(), []); assert.equal(next.killed, false);
  } finally { old.ignore.clear(); old.close(null, "SIGKILL"); old.releaseStdio(); await Promise.all([first, second]); await backend.dispose(); }
});

for (const phase of ["initialize", "stop"] as const) test(`real Node pipe: ${phase} failure is handled without an uncaught error or retry`, () => {
  // Never construct Node's special stdin stream: direct synchronous fd0 reads allow a real close
  // without the libuv active-reader assertion or stdin.destroy()'s special stdio behavior.
  const peer = `const fs = require('node:fs');
    const emit = value => console.log(JSON.stringify(value));
    function read() { let line = ''; const byte = Buffer.alloc(1);
      while (!line.endsWith('\\n')) { try { if (!fs.readSync(0, byte, 0, 1, null)) process.exit(0); line += byte.toString(); }
        catch (error) { if (error.code !== 'EAGAIN') throw error; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1); } }
      return JSON.parse(line); }
    while (true) { const m = read();
      if (m.method === 'initialize') {
        if (${JSON.stringify(phase)} === 'initialize') fs.closeSync(0);
        emit({id:m.id,result:{userAgent:'synthetic-closed-input'}});
        if (${JSON.stringify(phase)} === 'initialize') break;
      } else if (m.method === 'thread/start') emit({id:m.id,result:{thread:{id:'thr'},model:m.params.model,modelProvider:m.params.modelProvider}});
      else if (m.method === 'turn/start') { emit({id:m.id,result:{turn:{id:'tu'}}}); fs.closeSync(0);
        emit({method:'turn/started',params:{threadId:'thr',turn:{id:'tu'}}}); break; }
    }
    setInterval(() => {}, 1000);`;
  const probe = `import {spawn} from 'node:child_process';
    import {CodexBackend} from ${JSON.stringify(new URL("../src/main/engine/backends/codex.js", import.meta.url).href)};
    import {collectSink} from ${JSON.stringify(new URL("./fakeproc.js", import.meta.url).href)};
    const control = new AbortController(); let child, starts = 0;
    const spawnImpl = (_bin, _args, options) => { starts++; child = spawn(process.execPath, ['-e', ${JSON.stringify(peer)}], options);
      let output = ''; child.stdout.on('data', bytes => { output += bytes; if (output.includes('turn/started')) setImmediate(() => control.abort()); }); return child; };
    process.on('uncaughtExceptionMonitor', error => { console.error('UNCAUGHT:'+error.code); child?.kill('SIGKILL'); });
    process.on('SIGTERM', () => { child?.kill('SIGKILL'); process.exit(124); });
    const backend = new CodexBackend('synthetic-fixture', spawnImpl);
    let result;
    try { if (${JSON.stringify(phase)} === 'initialize') { try { await backend.listModels(); result = {status:'unexpected-success'}; }
        catch (error) { result = {status:'failed',message:error.message}; } }
      else result = await backend.runTurn('synthetic fixture', {cwd:process.cwd(),mode:'chat',plan:false,model:''}, collectSink().sink, control.signal);
    } finally { await backend.dispose(); }
    console.log(JSON.stringify({status:result.status,message:result.message,starts}));`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 5000, maxBuffer: 256 * 1024 });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr.includes("UNCAUGHT:"), false);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.status, phase === "initialize" ? "failed" : "interrupted");
  assert.equal(result.starts, 1, "transport failure cannot retry on another server");
  if (phase === "initialize") assert.match(result.message, /transport/i);
});
