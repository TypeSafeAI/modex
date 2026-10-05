import { test } from "node:test";
import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { ClaudeLogin } from "../src/main/engine/claude-login.js";
import { FakeProcess } from "./fakeproc.js";

function fixture(finalStatus: boolean, hang = false) {
  const children: FakeProcess[] = [];
  const calls: { bin: string; args: string[] }[] = [];
  let checks = 0;
  const spawnImpl = ((bin: string, args: string[]) => {
    calls.push({ bin, args });
    const child = new FakeProcess(); children.push(child);
    setImmediate(() => {
      if (args[1] === "status") { const loggedIn = checks++ > 0 && finalStatus; child.emitLine({ loggedIn, token: "SECRET" }); child.close(loggedIn ? 0 : 1); }
      else if (!hang) child.close(0);
    });
    return child;
  }) as unknown as typeof spawn;
  return { spawnImpl, children, calls };
}

test("Claude login uses the exact executable and confirms status without exposing credentials", async () => {
  const f = fixture(true);
  const result = await new ClaudeLogin(f.spawnImpl).run("/path with spaces/claude");
  assert.equal(result.status, "authenticated");
  assert.deepEqual(f.calls.map((call) => call.args), [["auth", "status"], ["auth", "login"], ["auth", "status"]]);
  assert.ok(f.calls.every((call) => call.bin === "/path with spaces/claude"));
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});

test("a successful login exit alone does not mean authenticated", async () => {
  assert.equal((await new ClaudeLogin(fixture(false).spawnImpl).run("claude")).status, "failed");
});

test("login is serialized; cancellation only stops its owned child", async () => {
  const f = fixture(false, true); const login = new ClaudeLogin(f.spawnImpl);
  const pending = login.run("claude");
  while (f.children.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await login.run("claude")).status, "busy");
  login.cancel();
  assert.equal((await pending).status, "cancelled");
  assert.equal(f.children[0]!.killed, false);
  assert.equal(f.children[1]!.killed, true);
});

test("hung login times out and terminates its own child", async () => {
  const f = fixture(false, true);
  assert.equal((await new ClaudeLogin(f.spawnImpl, 15).run("claude")).status, "timeout");
  assert.equal(f.children[1]!.killed, true);
});

test("older CLI status never falls through to a coding prompt", async () => {
  const f = fixture(false);
  const spawnImpl = ((_bin: string, _args: string[]) => {
    const child = new FakeProcess(); setImmediate(() => { child.emitLine("old cli help"); child.close(1); }); return child;
  }) as unknown as typeof spawn;
  assert.equal((await new ClaudeLogin(spawnImpl).run("claude")).status, "unsupported");
  assert.equal(f.calls.length, 0);
});

test("null account status returns unsupported without starting login", async () => {
  let calls = 0;
  const spawnImpl = ((_bin: string, _args: string[]) => {
    calls++;
    const child = new FakeProcess();
    setImmediate(() => { child.emitLine(null); child.close(0); });
    return child;
  }) as unknown as typeof spawn;
  assert.equal((await new ClaudeLogin(spawnImpl).run("claude")).status, "unsupported");
  assert.equal(calls, 1);
});
