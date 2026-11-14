import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, type SpawnOptions } from "node:child_process";
import type { QuestionReply } from "../src/main/engine/backends/types.js";
import { setTimeout as delay } from "node:timers/promises";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function wire(proc: FakeProcess, hold: ReadonlySet<string> = new Set()): void {
  let threads = 0;
  proc.stdin.on("data", data => {
    for (const line of data.toString().split("\n")) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (hold.has(m.method)) continue;
      if (m.method === "initialize") proc.emitLine({ id: m.id, result: { userAgent: "synthetic-transport" } });
      else if (m.method === "model/list") proc.emitLine({ id: m.id, result: { data: [] } });
      else if (m.method === "account/read") proc.emitLine({ id: m.id, result: { account: { type: "chatgpt" } } });
      else if (m.method === "account/rateLimits/read") proc.emitLine({ id: m.id, result: { rateLimits: {} } });
      else if (["config/read", "configRequirements/read", "thread/backgroundTerminals/terminate"].includes(m.method)) proc.emitLine({ id: m.id, result: {} });
      else if (m.method === "thread/backgroundTerminals/list") proc.emitLine({ id: m.id, result: { data: [] } });
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

test("a queued old initialize continuation cannot use the replacement", async () => {
  const old = new FakeProcess(), next = new FakeProcess(); wire(old, new Set(["initialize"])); wire(next);
  const backend = new CodexBackend("fixture", fakeSpawn([old, next]).spawn);
  const first = backend.listModels().then(() => "success", () => "failed");
  await old.waitFor(line => line.includes('"initialize"'));
  const request = old.sent(m => m.method === "initialize")[0]!;
  old.emitLine({ id: request.id, result: { userAgent: "old" } });
  const disposing = backend.dispose(), replacement = backend.listModels();
  try {
    assert.equal(await first, "failed"); await replacement; await disposing;
    assert.equal(next.sent(m => m.method === "initialized").length, 1);
    assert.equal(next.sent(m => m.method === "model/list").length, 1);
  } finally { await disposing; await replacement; await backend.dispose(); }
});

/** Dispose in the microtask between readiness resolving and its caller continuing. */
function replaceAfterReady(old: FakeProcess, replace: () => void): void {
  const original = old.stdin.write.bind(old.stdin);
  old.stdin.write = ((chunk: unknown, ...args: unknown[]) => {
    if (String(chunk).includes('"method":"initialized"')) {
      const callback = args.find(value => typeof value === "function") as () => void;
      setImmediate(() => { callback(); queueMicrotask(replace); });
      return true;
    }
    return Reflect.apply(original, old.stdin, [chunk, ...args]);
  }) as typeof old.stdin.write;
}

for (const kind of ["models", "quota", "account"] as const) test(`a disposed ready generation cannot migrate its ${kind} read`, async () => {
  const old = new FakeProcess(), next = new FakeProcess(); wire(old); wire(next);
  const servers = fakeSpawn([old, next]);
  const spawn = ((file: string, args: string[], options: SpawnOptions) => {
    if (args.includes("--version")) {
      const version = new FakeProcess();
      setImmediate(() => { version.emitRaw("codex-cli 0.164.0\n"); version.close(0); });
      return fakeSpawn(version).spawn(file, args, options);
    }
    return servers.spawn(file, args, options);
  }) as typeof servers.spawn;
  const backend = new CodexBackend("fixture", spawn);
  let disposing: Promise<void> | undefined, replacement: Promise<unknown> | undefined;
  replaceAfterReady(old, () => { disposing = backend.dispose(); replacement = backend.listModels(); });
  const first = kind === "account" ? backend.health().then(value => value.authentication)
    : (kind === "models" ? backend.listModels() : backend.quota()).then(() => "success", () => "failed");
  try {
    assert.equal(await first, kind === "account" ? "unknown" : "failed");
    await disposing; await replacement;
    assert.equal(next.sent(m => m.method === "initialized").length, 1);
    assert.equal(next.sent(m => m.method === "model/list").length, 1);
    assert.equal(next.sent(m => m.method === "account/read" || m.method === "account/rateLimits/read").length, 0);
  } finally { await disposing; await replacement; await backend.dispose(); }
});

test("an old thread-open reply cannot publish a session or start a replacement turn", async () => {
  const old = new FakeProcess(), next = new FakeProcess(); wire(old, new Set(["thread/start"])); wire(next);
  const backend = new CodexBackend("fixture", fakeSpawn([old, next]).spawn), sessions: string[] = [];
  const { sink } = collectSink();
  const running = backend.runTurn("synthetic", { cwd: "/fixture", mode: "chat", plan: false, model: "" }, { ...sink, session: value => { sessions.push(value); } }, new AbortController().signal);
  await old.waitFor(line => line.includes('"thread/start"'));
  const request = old.sent(m => m.method === "thread/start")[0]!;
  old.emitLine({ id: request.id, result: { thread: { id: "old-thread" }, model: "old-model" } });
  const disposing = backend.dispose(), replacement = backend.listModels();
  // The baseline may incorrectly start a turn on next. Complete only that synthetic turn so the RED cannot hang.
  next.stdin.on("data", bytes => { for (const line of bytes.toString().split("\n")) {
    if (!line.trim()) continue; const m = JSON.parse(line);
    if (m.method === "turn/start") setImmediate(() => next.emitLine({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: `tu-${m.params.threadId}`, status: "completed" } } }));
  } });
  try {
    assert.equal((await running).status, "failed"); await replacement; await disposing;
    assert.deepEqual(sessions, []);
    assert.equal(next.sent(m => m.method === "turn/start").length, 0);
  } finally { await disposing; await replacement; await backend.dispose(); await running; }
});

test("old configuration replies cannot admit execution on a replacement", async () => {
  const old = new FakeProcess(), next = new FakeProcess(); wire(old, new Set(["config/read", "configRequirements/read"])); wire(next);
  let admitted = 0;
  const backend = new CodexBackend("fixture", fakeSpawn([old, next]).spawn, { args: [], env: {}, redact: value => value, local: { provider: "fixture", model: "selected", admit: () => { admitted++; } } });
  const running = backend.runTurn("synthetic", { cwd: "/fixture", mode: "chat", plan: false, model: "selected" }, collectSink().sink, new AbortController().signal);
  await old.waitFor(line => line.includes('"configRequirements/read"'));
  for (const m of old.sent(m => m.method === "config/read" || m.method === "configRequirements/read")) old.emitLine({ id: m.id, result: {} });
  const disposing = backend.dispose(), replacement = backend.listModels();
  next.stdin.on("data", bytes => { for (const line of bytes.toString().split("\n")) {
    if (!line.trim()) continue; const m = JSON.parse(line);
    if (m.method === "turn/start") setImmediate(() => next.emitLine({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: `tu-${m.params.threadId}`, status: "completed" } } }));
  } });
  try {
    assert.equal((await running).status, "failed"); await replacement; await disposing;
    assert.equal(admitted, 0);
    assert.equal(next.sent(m => m.method === "thread/start" || m.method === "turn/start").length, 0);
  } finally { await disposing; await replacement; await backend.dispose(); await running; }
});

test("an old terminal-list reply cannot terminate a replacement's process", async () => {
  const old = new FakeProcess(), next = new FakeProcess(); wire(old, new Set(["thread/backgroundTerminals/list"])); wire(next);
  const backend = new CodexBackend("fixture", fakeSpawn([old, next]).spawn);
  const running = backend.runTurn("synthetic", { cwd: "/fixture", mode: "chat", plan: false, model: "" }, collectSink().sink, new AbortController().signal);
  await old.waitFor(line => line.includes('"turn/start"')); await tick();
  const start = old.sent(m => m.method === "turn/start")[0]!;
  const threadId = start.params.threadId, turnId = `tu-${threadId}`;
  old.emitLine({ method: "item/started", params: { threadId, turnId, item: { type: "commandExecution", id: "old-command", command: "synthetic", cwd: "/fixture", status: "inProgress" } } });
  old.emitLine({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: "interrupted" } } });
  await old.waitFor(line => line.includes('"thread/backgroundTerminals/list"'));
  const list = old.sent(m => m.method === "thread/backgroundTerminals/list")[0]!;
  old.emitLine({ id: list.id, result: { data: [{ itemId: "old-command", processId: "old-process" }] } });
  const disposing = backend.dispose(), replacement = backend.listModels();
  try {
    await running; await replacement; await disposing;
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(next.sent(m => m.method === "thread/backgroundTerminals/terminate").length, 0);
    assert.equal(next.sent(m => m.method === "thread/backgroundTerminals/list").length, 0);
  } finally { await disposing; await replacement; await backend.dispose(); await running; }
});

test("withdrawing an old native question cannot reply through the replacement", async () => {
  const old = new FakeProcess(), next = new FakeProcess(); wire(old); wire(next);
  const backend = new CodexBackend("fixture", fakeSpawn([old, next]).spawn), { sink } = collectSink();
  let displayed = false;
  const running = backend.runTurn("synthetic", { cwd: "/fixture", mode: "chat", plan: false, model: "" }, { ...sink, question: (_request, withdrawn) => new Promise<QuestionReply>(resolve => {
    displayed = true; withdrawn?.addEventListener("abort", () => resolve({ withdrawn: "native" }), { once: true });
  }) }, new AbortController().signal);
  await old.waitFor(line => line.includes('"turn/start"')); await tick();
  const start = old.sent(m => m.method === "turn/start")[0]!;
  old.emitLine({ id: 777, method: "item/tool/requestUserInput", params: { threadId: start.params.threadId, turnId: `tu-${start.params.threadId}`, itemId: "old-question", questions: [{ id: "q", header: "Choice", question: "Pick one", isOther: false, isSecret: false, options: [{ label: "a", description: "" }, { label: "b", description: "" }] }] } });
  for (let i = 0; i < 5 && !displayed; i++) await tick(); assert.equal(displayed, true);
  const disposing = backend.dispose(), replacement = backend.listModels();
  try {
    await running; await replacement; await disposing;
    for (let i = 0; i < 5; i++) await tick();
    assert.equal(next.sent(m => m.id === 777 && !m.method).length, 0);
  } finally { await disposing; await replacement; await backend.dispose(); await running; }
});

test("an old stale-auth failure cannot recover on or terminate a replacement", async () => {
  const old = new FakeProcess(), next = new FakeProcess(), unintended = new FakeProcess();
  wire(old, new Set(["thread/start"])); wire(next); wire(unintended);
  for (const peer of [next, unintended]) peer.stdin.on("data", bytes => { for (const line of bytes.toString().split("\n")) {
    if (!line.trim()) continue; const m = JSON.parse(line);
    if (m.method === "turn/start") setImmediate(() => peer.emitLine({ method: "turn/completed", params: { threadId: m.params.threadId, turn: { id: `tu-${m.params.threadId}`, status: "completed" } } }));
  } });
  const spawn = fakeSpawn([old, next, unintended]), backend = new CodexBackend("fixture", spawn.spawn);
  const running = backend.runTurn("synthetic", { cwd: "/fixture", mode: "chat", plan: false, model: "" }, collectSink().sink, new AbortController().signal);
  await old.waitFor(line => line.includes('"thread/start"'));
  const open = old.sent(m => m.method === "thread/start")[0]!;
  old.emitLine({ id: open.id, error: { code: -32000, message: "Your access token could not be refreshed because you have signed in to another account." } });
  const disposing = backend.dispose(), replacement = backend.listModels().then(() => "success", () => "failed");
  try {
    assert.equal((await running).status, "failed");
    assert.equal(next.killed, false); assert.equal(spawn.calls.length, 2);
    assert.equal(next.sent(m => m.method === "thread/start" || m.method === "turn/start").length, 0);
  } finally {
    await disposing; await replacement; await backend.dispose(); await running;
  }
});

test("an exited server with held stdio cannot be replaced before close", async () => {
  const old = new FakeProcess(), next = new FakeProcess(); wire(old); wire(next); old.holdStdio = true;
  const spawn = fakeSpawn([old, next]), backend = new CodexBackend("fixture", spawn.spawn);
  let ended = false;
  const running = backend.runTurn("synthetic", { cwd: "/fixture", mode: "chat", plan: false, model: "" }, collectSink().sink, new AbortController().signal).then(result => { ended = true; return result; });
  await old.waitFor(line => line.includes('"turn/start"')); await tick(); old.close(0); await tick();
  try {
    await assert.rejects(backend.listModels(), /closing/);
    assert.equal(spawn.calls.length, 1); assert.equal(ended, false);
    old.releaseStdio(); assert.equal((await running).status, "failed");
    assert.deepEqual(await backend.listModels(), []); assert.equal(spawn.calls.length, 2);
  } finally { old.releaseStdio(); await backend.dispose(); await running; }
});

test("a child that closes before initialization cannot report the previous agent version", async () => {
  const old = new FakeProcess(), next = new FakeProcess(); wire(old); wire(next, new Set(["initialize"]));
  const backend = new CodexBackend("fixture", fakeSpawn([old, next]).spawn);
  await backend.listModels(); await backend.dispose();
  const pending = backend.listModels();
  await next.waitFor(line => line.includes('"initialize"')); next.close(0);
  try {
    await assert.rejects(pending, error => {
      assert.equal((error as { detail: Record<string, unknown> }).detail.userAgent, null);
      return true;
    });
  } finally { await backend.dispose(); }
});
