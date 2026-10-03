import { test } from "node:test";
import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { ClaudeBackend } from "../src/main/engine/backends/claude.js";
import { CodexBackend } from "../src/main/engine/backends/codex.js";
import { probe } from "../src/main/engine/backends/health.js";
import { FakeProcess } from "./fakeproc.js";

function scripted(account: unknown, missing = false, unsupported = false, authExitCode?: number) {
  const calls: string[][] = [];
  const spawnImpl = ((_bin: string, args: string[]) => {
    calls.push(args);
    const proc = new FakeProcess();
    if (args[0] === "app-server") {
      proc.stdin.on("data", (data: Buffer) => {
        const request = JSON.parse(data.toString());
        if (request.id) proc.emitLine(unsupported && request.method === "account/read"
          ? { id: request.id, error: { code: -32601, message: "SECRET" } }
          : { id: request.id, result: request.method === "initialize" ? {} : account });
      });
    } else setImmediate(() => {
      if (missing) proc.emit("error", Object.assign(new Error("SECRET"), { code: "ENOENT" }));
      else {
        proc.emitLine(args[0] === "--version" ? "CLI 1.0.0 SECRET" : account);
        proc.close(args[0] === "auth" ? (authExitCode ?? (typeof account === "object" && account !== null && "loggedIn" in account && account.loggedIn === false ? 1 : 0)) : 0);
      }
    });
    return proc;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls };
}

test("Claude static models cannot establish installation or authentication", async () => {
  const fixture = scripted({}, true);
  const backend = new ClaudeBackend("missing", fixture.spawnImpl);
  assert.ok((await backend.listModels()).length);
  const status = await backend.health();
  assert.equal(status.executable, "missing");
  assert.equal(status.version, undefined);
  assert.equal(status.authentication, "unknown");
  assert.equal(status.access, "unverified");
  assert.equal(JSON.stringify(status).includes("SECRET"), false);
});

test("Claude reads structured account status afresh, without paid turns", async () => {
  for (const loggedIn of [false, true]) {
    const fixture = scripted({ loggedIn, token: "SECRET" });
    const backend = new ClaudeBackend("path with spaces", fixture.spawnImpl);
    const status = await backend.health();
    assert.equal(status.authentication, loggedIn ? "authenticated" : "signed-out");
    assert.equal(status.version, "1.0.0");
    assert.equal(status.access, "unverified");
    await backend.health();
    assert.deepEqual(fixture.calls, [["--version"], ["auth", "status"], ["--version"], ["auth", "status"]]);
    assert.equal(JSON.stringify(status).includes("SECRET"), false);
  }
});

test("malformed and older Claude status remains unknown", async () => {
  const fixture = scripted("unsupported");
  assert.equal((await new ClaudeBackend("claude", fixture.spawnImpl).health()).authentication, "unknown");
  const conflicting = scripted({ loggedIn: true }, false, false, 1);
  assert.equal((await new ClaudeBackend("claude", conflicting.spawnImpl).health()).authentication, "unknown");
});

test("hung CLI probe is bounded and only kills the owned probe", async () => {
  const proc = new FakeProcess();
  const result = await probe("cli", ["--version"], (() => proc) as unknown as typeof spawn, 10);
  assert.equal(result.failure, "timeout");
  assert.equal(proc.killed, true);
});

test("Codex account read distinguishes signed out, authenticated, custom, unsupported", async () => {
  for (const [account, expected] of [
    [{ account: null, requiresOpenaiAuth: true }, "signed-out"],
    [{ account: { type: "chatgpt", email: "SECRET" } }, "authenticated"],
    [{ account: null, requiresOpenaiAuth: false }, "unknown"],
    [{ account: { type: "unrecognized" } }, "unknown"],
  ] as const) {
    const fixture = scripted(account);
    const backend = new CodexBackend("codex", fixture.spawnImpl);
    const status = await backend.health();
    assert.equal(status.authentication, expected);
    assert.equal(status.version, "1.0.0");
    assert.equal(status.access, "unverified");
    assert.equal(JSON.stringify(status).includes("SECRET"), false);
    assert.equal(fixture.calls.some((args) => args.includes("-p")), false);
    await backend.dispose();
  }
  const apiKey = scripted({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
  const apiKeyBackend = new CodexBackend("codex", apiKey.spawnImpl);
  assert.equal((await apiKeyBackend.health()).detail, "API key configured · model access unverified");
  await apiKeyBackend.dispose();
  const fixture = scripted({}, false, true);
  const backend = new CodexBackend("codex", fixture.spawnImpl);
  assert.equal((await backend.health()).authentication, "unsupported");
  await backend.dispose();
});
