import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, describeFailure, failureReport } from "../src/shared/failures.js";

const STALE = "Your access token could not be refreshed because you have since logged out or signed in to another account. Please sign in again.";
/** Codex hands over OpenAI's JSON error body verbatim when a ChatGPT plan token refuses a resumed thread's `agent_message` items. */
const SUBSCRIPTION_SHARING = JSON.stringify({ error: {
  message: "User subscription sharing currently supports only text, image, and file messages, item references, additional tools, compaction summaries, reasoning items, Web Search call items, developer function and custom tool call items, and programmatic tool calling items. Remove unsupported input items or use an API key instead.",
  type: "invalid_request_error", param: "input", code: "subscription_sharing_unsupported_capability",
} }, null, 2);

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
    [SUBSCRIPTION_SHARING, "unsupported_history"],
    ["The ChatGPT user has reached their Subscription Sharing usage limit.", "rate_limited"],
  ];
  for (const [message, code] of cases) assert.equal(classifyFailure(message), code, message);
});

test("describeFailure: a ChatGPT plan refusing a thread's history is not retryable and points at a new thread", () => {
  const f = describeFailure({ backend: "codex", message: SUBSCRIPTION_SHARING, detail: { codexThreadId: "thr-1" } });
  assert.equal(f.code, "unsupported_history");
  assert.equal(f.message, SUBSCRIPTION_SHARING);
  assert.match(f.summary, /ChatGPT plan connection cannot send part of this conversation's history/);
  assert.match(f.hint ?? "", /multi-agent item.*Start a new thread/s);
  assert.deepEqual(f.fix, { kind: "new-thread", label: "Start a new thread" });
  assert.equal(f.retryable, false);
  assert.ok(failureReport(f).includes("Codex turn failed (unsupported_history)"));
});

test("describeFailure: an unknown error delivered as an API JSON body summarises the message inside it", () => {
  const body = JSON.stringify({ error: { message: "The model `gpt-7-nova` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" } }, null, 2);
  const f = describeFailure({ backend: "codex", message: body });
  assert.equal(f.code, "unknown");
  assert.equal(f.summary, "The model `gpt-7-nova` does not exist or you do not have access to it.");
  assert.equal(f.message, body);
  assert.equal(describeFailure({ backend: "codex", message: "{ not json" }).summary, "{ not json");
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

test("describeFailure: recoverable outages expose a contextual resolve action", () => {
  const quota = describeFailure({ backend: "codex", message: "The ChatGPT user has reached their Subscription Sharing usage limit." });
  assert.equal(quota.code, "rate_limited");
  assert.deepEqual(quota.fix, { kind: "models", label: "Try another model" });

  const network = describeFailure({ backend: "claude", message: "stream disconnected before completion: error sending request" });
  assert.deepEqual(network.fix, { kind: "retry", label: "Retry connection" });

  const crashed = describeFailure({ backend: "codex", message: "codex app-server exited (137) killed" });
  assert.deepEqual(crashed.fix, { kind: "retry", label: "Restart and retry" });
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

test("missing mock script offers script recovery instead of installing a CLI", () => {
  const failure = describeFailure({ backend: "mock", message: "ENOENT: no such file or directory, open '/Applications/Modex Graphite Preview.app/Contents/apps/desktop/demo/mock-script.json'" });
  assert.equal(failure.code, "unknown");
  assert.equal(failure.summary, "The demo script could not be loaded.");
  assert.match(failure.hint!, /Mock script/);
  assert.equal(failure.fix?.kind, "settings");
  assert.doesNotMatch(failureReport(failure), /Install the CLI|CLI said/);
});
