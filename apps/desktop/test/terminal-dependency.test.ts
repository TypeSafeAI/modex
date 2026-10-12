import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);

test("Windows PTY natural cleanup releases input and its output worker", async t => {
  // Exercise the installed dependency's actual cleanup method without a Windows
  // console. The native suite separately checks real ConPTY ownership.
  const { WindowsPtyAgent } = require("node-pty/lib/windowsPtyAgent.js");
  const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
  let terminated: Promise<number> | undefined;
  t.after(async () => { await worker.terminate(); });
  const input = new PassThrough();
  const output = new PassThrough();
  const agent = Object.assign(Object.create(WindowsPtyAgent.prototype), {
    _useConptyDll: false, _inSocket: input, _outSocket: output,
    _conoutSocketWorker: { dispose() { terminated ??= worker.terminate(); } },
    _getConsoleProcessList() { throw new Error("Exited process IDs must never be enumerated"); },
  });
  agent._cleanUpProcess();
  assert.ok(input.destroyed, "input socket leaked after natural exit");
  assert.ok(output.destroyed, "output socket leaked after natural exit");
  assert.ok(terminated, "output worker leaked after natural exit");
  await terminated;
});

test("Windows PTY ignores writes after native exit", () => {
  const { WindowsTerminal } = require("node-pty/lib/windowsTerminal.js");
  const terminal = Object.assign(Object.create(WindowsTerminal.prototype), {
    _agent: { exitCode: 23, inSocket: { destroyed: false, write() { assert.fail("write after native exit"); } } },
  });
  terminal._doWrite("late keystroke");
});

for (const outputFirst of [true, false]) {
  test(`Windows PTY exit waits for native status and output EOF (${outputFirst ? "output" : "status"} first)`, () => {
    const dependency = require("node-pty/lib/windowsPtyAgent.js");
    const OriginalAgent = dependency.WindowsPtyAgent;
    const output = new PassThrough();
    let notify = () => {};
    const agent = { exitCode: undefined as number | undefined, outSocket: output,
      onError() {}, onProcessExit(callback: () => void) { notify = callback; } };
    dependency.WindowsPtyAgent = function () { return agent; };
    let terminal;
    try { terminal = new (require("node-pty/lib/windowsTerminal.js").WindowsTerminal)("fixture", [], {}); }
    finally { dependency.WindowsPtyAgent = OriginalAgent; }
    const exits: number[] = [];
    terminal.onExit(({ exitCode }: { exitCode: number }) => exits.push(exitCode));
    output.emit("ready_datapipe");
    const close = () => output.emit("close");
    const status = () => { agent.exitCode = 23; notify(); };
    (outputFirst ? close : status)();
    assert.deepEqual(exits, [], "exit published before both inputs were known");
    (outputFirst ? status : close)();
    assert.deepEqual(exits, [23]);
    close(); status();
    assert.deepEqual(exits, [23], "duplicate terminal exit");
  });
}


test("Windows PTY handles broken input before its native exit callback", () => {
  const file = require.resolve("node-pty/lib/windowsPtyAgent.js");
  const localRequire = createRequire(file);
  const exports: Record<string, any> = {};
  vm.runInNewContext(fs.readFileSync(file, "utf8"), { exports, setTimeout, clearTimeout,
    require(name: string) {
      if (name === "fs") return { openSync: () => 1 };
      if (name === "net") return { Socket: PassThrough };
      if (name === "./utils") return { loadNativeModule: () => ({ module: {
        startProcess: () => ({ fd: -1, pty: 1, conout: "out", conin: "in" }),
      } }) };
      return localRequire(name);
    },
  }, { filename: file });
  const agent = new exports.WindowsPtyAgent("fixture", [], [], ".", 80, 24, false, false, false, {
    connectionTimeout: 5000, conoutConnectionFactory: () => ({ onReady() {}, onError() {} }),
  });
  agent._clearConnectionTimeout();
  const errors: Error[] = [];
  agent.onError((error: Error) => errors.push(error));
  assert.doesNotThrow(() => agent.inSocket.emit("error", Object.assign(new Error("closed input"), { code: "EPIPE" })));
  assert.ok(agent.inSocket.destroyed);
  assert.deepEqual(errors, []);
  const unexpected = Object.assign(new Error("unexpected input failure"), { code: "EACCES" });
  agent.inSocket.emit("error", unexpected);
  assert.deepEqual(errors, [unexpected]);
});

test("Windows PTY input errors do not substitute for output EOF", () => {
  const dependency = require("node-pty/lib/windowsPtyAgent.js");
  const OriginalAgent = dependency.WindowsPtyAgent;
  const output = new PassThrough();
  let notify = () => {}, error = () => {};
  const agent = { exitCode: undefined as number | undefined, outSocket: output,
    onError(callback: () => void) { error = callback; }, onProcessExit(callback: () => void) { notify = callback; } };
  dependency.WindowsPtyAgent = function () { return agent; };
  let terminal;
  try { terminal = new (require("node-pty/lib/windowsTerminal.js").WindowsTerminal)("fixture", [], {}); }
  finally { dependency.WindowsPtyAgent = OriginalAgent; }
  const exits: number[] = [];
  terminal.onExit(({ exitCode }: { exitCode: number }) => exits.push(exitCode));
  output.emit("ready_datapipe");
  error();
  agent.exitCode = 23;
  notify();
  assert.deepEqual(exits, []);
  output.emit("close");
  assert.deepEqual(exits, [23]);
});
