import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, describeFailure, failureReport } from "../src/shared/failures.js";

const STALE = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";

test("classifyFailure reads the CLIs' own wording", () => {
  const cases: [string, string][] = [
    [STALE, "auth"],
    ["Your access token could not be refreshed. Please log out and sign in again.", "auth"],
    ["Not logged in · Please run /login", "auth"],
    ["Invalid API key · Please run /login", "auth"],
    ["401 Unauthorized", "auth"],
    ["codex: spawn codex ENOENT. Is the Codex CLI installed and on PATH?", "not_installed"],
    ["could not start claude: spawn claude EACCES", "not_installed"],
    ["429 Too Many Requests", "rate_limited"],
    ["You've hit your usage limit. Try again at 3pm.", "rate_limited"],
    ["stream disconnected before completion: error sending request", "network"],
    ["fetch failed: ECONNRESET", "network"],
    ["codex app-server exited (137) killed", "crashed"],
    ["claude exited with code 1", "crashed"],
    ["Codex was force-stopped from another thread. Send again to continue.", "crashed"],
    ["Something nobody has seen before", "unknown"],
  ];
  for (const [message, code] of cases) assert.equal(classifyFailure(message), code, message);
});

test("describeFailure: a stale Codex sign-in gets a plain summary, the login fix, and the CLI's words verbatim", () => {
  const f = describeFailure({
    backend: "codex",
    message: STALE,
    detail: { rpcCode: -32000, codexThreadId: "thr-1" },
    recovery: ["restarted codex app-server so it reads the current sign-in, then retried once: failed again"],
    context: { threadId: "t1", cwd: "/repo" },
  });
  assert.equal(f.code, "auth");
  assert.equal(f.message, STALE);
  assert.match(f.summary, /Codex is signed out, or its sign-in changed/);
  assert.match(f.hint ?? "", /codex login/);
  assert.deepEqual(f.fix, { kind: "login", label: "Sign in to Codex", command: "codex login" });
  assert.equal(f.retryable, true);
  assert.deepEqual(f.debug, { threadId: "t1", cwd: "/repo", rpcCode: -32000, codexThreadId: "thr-1" });
  const report = failureReport(f);
  for (const needle of ["Codex turn failed (auth)", STALE, "Recovery attempted:", "restarted codex app-server", '"rpcCode": -32000', '"cwd": "/repo"']) {
    assert.ok(report.includes(needle), `report lacks ${needle}:\n${report}`);
  }
});

test("describeFailure: Claude sign-in errors point at claude auth login; a missing CLI points at Settings", () => {
  const auth = describeFailure({ backend: "claude", message: "Not logged in · Please run /login" });
  assert.equal(auth.code, "auth");
  assert.deepEqual(auth.fix, { kind: "login", label: "Sign in to Claude Code", command: "claude auth login" });
  const missing = describeFailure({ backend: "claude", message: "claude: spawn claude ENOENT. Is Claude Code installed and on PATH?" });
  assert.equal(missing.code, "not_installed");
  assert.deepEqual(missing.fix, { kind: "settings", label: "Open Settings" });
  assert.match(missing.summary, /Claude Code could not be started/);
});

test("describeFailure: unknown errors keep the message as the summary; shutdown is not retryable; mock has no login fix", () => {
  const odd = describeFailure({ backend: "mock", message: "Mock backend selected but no mock script is configured (Settings → Mock script).\nsecond line" });
  assert.equal(odd.code, "unknown");
  assert.equal(odd.summary, "Mock backend selected but no mock script is configured (Settings → Mock script).");
  assert.equal(odd.hint, undefined);
  assert.equal(odd.fix, undefined);
  assert.equal(odd.retryable, true);
  assert.equal(describeFailure({ backend: "codex", message: "Modex is shutting down." }).retryable, false);
  assert.equal(describeFailure({ backend: "mock", message: "codex: not logged in" }).fix, undefined);
  assert.equal(describeFailure({ backend: "codex", message: "" }).message, "The turn failed.");
});
