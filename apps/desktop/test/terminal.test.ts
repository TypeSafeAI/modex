import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IPtyForkOptions } from "node-pty";
import { TerminalManager, isTrustedTerminalSender } from "../src/main/engine/terminal.js";
import type { TerminalEvent } from "../src/shared/types.js";
import { tmpdir } from "./helpers.js";

function harness() {
  const cwd = tmpdir("terminal");
  const events: TerminalEvent[] = [];
  const processes: (EventEmitter & { writes: string[]; sizes: number[][]; kills: number })[] = [];
  const calls: { shell: string; args: string[]; options: IPtyForkOptions }[] = [];
  const manager = new TerminalManager((id) => {
    if (id !== "one" && id !== "two") throw new Error("unknown thread");
    return cwd;
  }, (event) => events.push(event), (shell, args, options) => {
    calls.push({ shell, args, options });
    const emitter = Object.assign(new EventEmitter(), { writes: [] as string[], sizes: [] as number[][], kills: 0 });
    processes.push(emitter);
    return {
      write: (text) => { emitter.writes.push(text.toString()); },
      resize: (cols, rows) => { emitter.sizes.push([cols, rows]); },
      kill: () => { emitter.kills++; },
      onData: (fn) => { emitter.on("data", fn); return { dispose: () => { emitter.off("data", fn); } }; },
      onExit: (fn) => { emitter.on("exit", fn); return { dispose: () => { emitter.off("exit", fn); } }; },
    };
  }, { SHELL: "/bin/bash", PATH: "/bin", ELECTRON_RUN_AS_NODE: "1" });
  return { manager, events, processes, calls, cwd };
}

test("terminal starts in the thread cwd, retains history, and isolates thread sessions", () => {
  const { manager, processes, events, calls, cwd } = harness();
  const one = manager.open("one", 80, 24);
  const two = manager.open("two", 80, 24);
  assert.notEqual(one.sessionId, two.sessionId);
  assert.equal(calls[0]!.options.cwd, cwd);
  assert.equal(calls[0]!.options.env?.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(calls[0]!.options.env?.TERM, "xterm-256color");
  processes[0]!.emit("data", "hello\r\n");
  const restored = manager.open("one", 80, 24);
  assert.equal(restored.output, "hello\r\n");
  assert.equal(restored.sequence, events[0]!.sequence);
  assert.equal(processes.length, 2);
  manager.write("one", one.sessionId, "pwd\r");
  manager.resize("one", one.sessionId, 110, 30);
  assert.deepEqual(processes[0]!.writes, ["pwd\r"]);
  assert.deepEqual(processes[0]!.sizes, [[110, 30]]);
  assert.throws(() => manager.write("two", one.sessionId, "x"), /no longer active/);
  manager.dispose();
  assert.deepEqual(processes.map((p) => p.kills), [1, 1]);
});

test("terminal bounds history and validates dimensions and input before touching the process", () => {
  const { manager, processes } = harness();
  assert.throws(() => manager.open("missing", 80, 24), /unknown thread/);
  for (const cols of [0, -1, 1.5, Infinity, 501]) assert.throws(() => manager.open("one", cols, 24), /dimensions/);
  const session = manager.open("one", 80, 24);
  assert.throws(() => manager.write("one", session.sessionId, "x".repeat(65537)), /input/);
  processes[0]!.emit("data", "x".repeat(256 * 1024));
  assert.equal(manager.open("one", 80, 24).output.length, 128 * 1024);
  assert.deepEqual(processes[0]!.writes, []);
  manager.dispose();
});

test("terminal exits are replayed; close is idempotent and old close requests cannot kill replacements", () => {
  const { manager, processes, events } = harness();
  const session = manager.open("one", 80, 24);
  processes[0]!.emit("exit", { exitCode: 3 });
  assert.equal(manager.open("one", 80, 24).exitCode, 3);
  assert.equal(events.at(-1)!.type, "exit");
  assert.throws(() => manager.write("one", session.sessionId, "x"), /exited/);
  manager.close("one", session.sessionId);
  manager.open("one", 80, 24);
  manager.close("one", session.sessionId);
  assert.equal(processes[1]!.kills, 0);
  manager.dispose();
  manager.dispose();
  assert.equal(processes[1]!.kills, 1);
  assert.equal(processes[1]!.listenerCount("data"), 0);
});

test("terminal requests are trusted only from the live app window's top frame", () => {
  const mainFrame = {};
  const webContents = { mainFrame };
  const win = { isDestroyed: () => false, webContents };
  assert.equal(isTrustedTerminalSender({ sender: webContents, senderFrame: mainFrame }, win), true);
  assert.equal(isTrustedTerminalSender({ sender: webContents, senderFrame: {} }, win), false, "subframe");
  assert.equal(isTrustedTerminalSender({ sender: { mainFrame }, senderFrame: mainFrame }, win), false, "another window");
  assert.equal(isTrustedTerminalSender({ sender: webContents, senderFrame: mainFrame }, { ...win, isDestroyed: () => true }), false, "destroyed window");
  assert.equal(isTrustedTerminalSender({ sender: webContents, senderFrame: mainFrame }, null), false, "no window");
});
