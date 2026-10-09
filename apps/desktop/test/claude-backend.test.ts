import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeBackend, denyMessage, toolTitle } from "../src/main/engine/backends/claude.js";
import type { ApprovalRequest } from "../src/main/engine/backends/types.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";

test("Claude attaches Pages and knowledge together with exact session tool allowlists", () => {
  const pages = { url: "http://127.0.0.1:1234/mcp/pages", instructions: "Maintain Space notes" };
  const knowledge = { url: "http://127.0.0.1:1234/mcp/knowledge", instructions: "Maintain verified knowledge" };
  for (const resume of [undefined, "previous-session"]) {
    const opts = { cwd: "/worktree", model: "", plan: false, mode: "agent" as const, pages, knowledge, resume };
    const args = ClaudeBackend.args(opts);
    assert.equal(args.filter(arg => arg === "--mcp-config").length, 1);
    assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]!), { mcpServers: {
      modex_knowledge: { type: "http", url: knowledge.url }, modex_pages: { type: "http", url: pages.url },
    } });
    assert.equal(args[args.indexOf("--append-system-prompt") + 1], `${knowledge.instructions}\n\n${pages.instructions}`);
    assert.deepEqual(args.slice(args.indexOf("--allowedTools") + 1), [
      ...["search", "read", "write", "edit", "history"].map(name => `mcp__modex_knowledge__${name}`),
      ...["search", "read", "create", "edit", "update", "trash", "restore", "history", "revert"].map(name => `mcp__modex_pages__${name}`),
    ]);
    if (resume) assert.equal(args[args.indexOf("--resume") + 1], resume);
  }
});

test("Claude attaches thread knowledge MCP and maintenance instructions without changing cwd", () => {
  const knowledge = { url: "http://127.0.0.1:1234/mcp/thread", instructions: "Maintain verified knowledge" };
  const args = ClaudeBackend.args({ cwd: "/worktree", model: "", plan: false, mode: "agent", knowledge });
  assert.deepEqual(JSON.parse(args[args.indexOf("--mcp-config") + 1]!), { mcpServers: { modex_knowledge: { type: "http", url: knowledge.url } } });
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], knowledge.instructions);
  assert.deepEqual(args.slice(args.indexOf("--allowedTools") + 1), ["search", "read", "write", "edit", "history"].map(name => `mcp__modex_knowledge__${name}`));
});

test("ClaudeBackend.args maps modes and plan onto claude -p flags", () => {
  const base = { cwd: "/w", model: "sonnet", plan: false } as const;
  assert.deepEqual(ClaudeBackend.args({ ...base, mode: "agent" }).slice(-4), ["--permission-mode", "acceptEdits", "--model", "sonnet"]);
  assert.ok(ClaudeBackend.args({ ...base, mode: "chat" }).join(" ").includes("--permission-mode manual --disallowedTools Edit Write NotebookEdit"));
  assert.ok(ClaudeBackend.args({ ...base, mode: "full-access" }).includes("bypassPermissions"));
  assert.ok(ClaudeBackend.args({ ...base, mode: "agent", plan: true }).join(" ").includes("--permission-mode plan"));
  assert.ok(ClaudeBackend.args({ ...base, mode: "agent", resume: "abc" }).join(" ").includes("--resume abc"));
  const a = ClaudeBackend.args({ ...base, mode: "agent" });
  for (const f of ["-p", "--input-format", "stream-json", "--output-format", "--include-partial-messages", "--permission-prompt-tool", "stdio"]) assert.ok(a.includes(f), f);
  assert.equal(toolTitle("Bash", { command: "npm test" }), "$ npm test");
  assert.equal(toolTitle("Edit", { file_path: "src/a.ts" }), "edit src/a.ts");
});

test("ClaudeBackend: streams deltas, tools, answers a permission request, resumes by session id", async () => {
  const proc = new FakeProcess();
  const { spawn, calls } = fakeSpawn(proc);
  const backend = new ClaudeBackend("claude", spawn);
  const { sink, events } = collectSink(["always"]);
  const ac = new AbortController();
  const run = backend.runTurn("write probe.txt", { cwd: "/repo", mode: "agent", plan: false, model: "sonnet" }, sink, ac.signal);

  const first = await proc.waitFor((l) => l.includes('"type":"user"'));
  assert.match(first, /write probe.txt/);
  assert.equal(calls[0]!.cwd, "/repo");

  proc.emitLine({ type: "system", subtype: "init", session_id: "sess-1" });
  proc.emitLine({ type: "stream_event", event: { type: "message_start", message: {} } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan: " } } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "write it." } } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "abc" } } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_stop", index: 0 } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Sure, " } } });
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "writing." } } });
  proc.emitLine({ type: "assistant", message: { content: [{ type: "thinking", thinking: "Plan: write it." }, { type: "text", text: "Sure, writing." }, { type: "tool_use", id: "tu1", name: "Write", input: { file_path: "/repo/probe.txt", content: "hi" } }] } });
  proc.emitLine({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Write", input: { file_path: "/repo/probe.txt", content: "hi" }, permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] } });
  const resp = JSON.parse(await proc.waitFor((l) => l.includes("control_response"))) as { response: { request_id: string; response: { behavior: string; updatedPermissions?: unknown[] } } };
  assert.equal(resp.response.request_id, "r1");
  assert.equal(resp.response.response.behavior, "allow");
  assert.equal(resp.response.response.updatedPermissions?.length, 1, "'always' forwards the CLI's permission suggestion");
  proc.emitLine({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "File created successfully", is_error: false }] } });
  proc.emitLine({ type: "assistant", message: { content: [{ type: "text", text: "Done." }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "sess-1", result: "Done." });
  proc.close(0);

  const r = await run;
  assert.equal(r.status, "completed");
  assert.deepEqual(events, [
    "session:sess-1",
    "think:think-1:",
    "think:think-1:Plan: ",
    "think:think-1:write it.",
    "think_done:think-1:",
    "delta:Sure, ",
    "delta:writing.",
    "assistant:Sure, writing.",
    "tool_start:tu1:write /repo/probe.txt",
    "approval:Allow Write: write /repo/probe.txt?",
    "tool_update:tu1:done:true:File created successfully",
    "assistant:Done.",
    "session:sess-1",
  ]);
});

test("ClaudeBackend: denial and failure paths", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const { sink, events } = collectSink(["no"]);
  const run = backend.runTurn("rm it", { cwd: "/repo", mode: "chat", plan: false, model: "" }, sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.emitLine({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm -rf x" } } });
  const resp = JSON.parse(await proc.waitFor((l) => l.includes("control_response"))) as { response: { response: { behavior: string } } };
  assert.equal(resp.response.response.behavior, "deny");
  proc.emitLine({ type: "system", subtype: "init", session_id: "sess-2", claude_code_version: "2.1.283", model: "claude-sonnet-5", apiKeySource: "none" });
  proc.stderr.write("stderr line\n");
  await new Promise((r) => setImmediate(r));
  proc.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, result: "boom", errors: ["boom"] });
  proc.close(1);
  const r = await run;
  assert.equal(r.status, "failed");
  assert.equal(r.error, "boom");
  assert.ok(events.includes("approval:Allow Bash: $ rm -rf x?"));
  // The failure carries what a bug report needs: the CLI build and key source it announced, the result subtype, stderr, argv.
  assert.equal(r.detail?.resultSubtype, "error_during_execution");
  assert.deepEqual(r.detail?.errors, ["boom"]);
  assert.equal(r.detail?.claudeVersion, "2.1.283");
  assert.equal(r.detail?.apiKeySource, "none");
  assert.equal(r.detail?.stderr, "stderr line");
  assert.equal(r.detail?.bin, "claude");
  assert.ok((r.detail?.argv as string[]).includes("--output-format"));
});

test("ClaudeBackend: a non-zero exit carries the exit code and stderr tail", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const run = backend.runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "" }, collectSink().sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.stderr.write("warning: something\nInvalid API key · Please run /login\n");
  await new Promise((r) => setImmediate(r));
  proc.close(1);
  const r = await run;
  assert.equal(r.status, "failed");
  assert.equal(r.error, "warning: something\nInvalid API key · Please run /login");
  assert.equal(r.detail?.exitCode, 1);
  assert.equal(r.detail?.stderr, "warning: something\nInvalid API key · Please run /login");
  assert.equal(r.detail?.bin, "claude");
});

test("ClaudeBackend: abort kills the process and reports interrupted", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const ac = new AbortController();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, collectSink().sink, ac.signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  ac.abort();
  const r = await run;
  assert.equal(r.status, "interrupted");
  assert.equal(proc.killed, true);
});

test("ClaudeBackend.args passes reasoning effort and fast mode; models advertise the effort ladder", () => {
  const base = { cwd: "/w", model: "haiku", plan: false, mode: "agent" as const };
  const plain = ClaudeBackend.args(base).join(" ");
  assert.ok(!plain.includes("--effort") && !plain.includes("--settings"));
  const tuned = ClaudeBackend.args({ ...base, effort: "xhigh", fast: true });
  assert.ok(tuned.join(" ").includes("--effort xhigh"));
  assert.equal(tuned[tuned.indexOf("--settings") + 1], '{"fastMode":true}');
  assert.deepEqual(ClaudeBackend.MODELS[0]!.efforts, ["low", "medium", "high", "xhigh", "max"]);
});

test("Stop waits for the Claude process to close before settling", async () => {
  const proc = new FakeProcess();
  proc.kill = () => { proc.killed = true; return true; };
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const abort = new AbortController();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "" }, collectSink().sink, abort.signal);
  let settled = false;
  void run.then(() => { settled = true; });
  abort.abort();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(proc.killed, true);
  assert.equal(settled, false, "SIGTERM delivery is not process termination");
  proc.close(null);
  assert.deepEqual(await run, { status: "interrupted" });
});

test("ClaudeBackend: can_use_tool carries a structured action; a rule's 'yes' allows without updatedPermissions", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  // "yes" is what the approval gate answers for an allow rule; the CLI offered a permission suggestion anyway.
  const { sink, requests } = collectSink(["yes", "yes"]);
  const run = backend.runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "" }, sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  const suggestion = [{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }];
  proc.emitLine({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" }, permission_suggestions: suggestion } });
  const r1 = JSON.parse(await proc.waitFor((l) => l.includes('"request_id":"r1"'))) as { response: { response: { behavior: string; updatedPermissions?: unknown } } };
  assert.equal(r1.response.response.behavior, "allow");
  assert.equal(r1.response.response.updatedPermissions, undefined, "a one-off yes never widens permissions");
  proc.emitLine({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } } });
  await proc.waitFor((l) => l.includes('"request_id":"r2"'));
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "ok" });
  proc.close(0);
  await run;
  assert.deepEqual(requests.map((r) => r.action), [
    { backend: "claude", tool: "Bash", title: "$ npm test", cwd: "/repo", input: { command: "npm test" } },
    { backend: "claude", tool: "Edit", title: "edit src/a.ts", cwd: "/repo", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } },
  ]);
});

test("ClaudeBackend: a rule's refusal names the rule in the deny message; a human's 'no' keeps today's", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn);
  const { sink, requests } = collectSink(["no", "no", "yes"]);
  const consulted: ApprovalRequest[] = [];
  // Stands in for the runner: the Bash request was refused by a rule, the Edit by a person.
  const refusedByRule = (req: ApprovalRequest) => { consulted.push(req); return req.action?.tool === "Bash" ? "push to\n  main" : undefined; };
  const run = backend.runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "" }, { ...sink, refusedByRule }, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  type Reply = { response: { response: { behavior: string; message?: string } } };
  proc.emitLine({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git push origin main" } } });
  const r1 = JSON.parse(await proc.waitFor((l) => l.includes('"request_id":"r1"'))) as Reply;
  assert.deepEqual(r1.response.response, { behavior: "deny", message: "The user denied this action in Modex (rule: push to main)." });
  proc.emitLine({ type: "control_request", request_id: "r2", request: { subtype: "can_use_tool", tool_name: "Edit", input: { file_path: "a.ts", old_string: "a", new_string: "b" } } });
  const r2 = JSON.parse(await proc.waitFor((l) => l.includes('"request_id":"r2"'))) as Reply;
  assert.deepEqual(r2.response.response, { behavior: "deny", message: "The user denied this action in Modex." });
  proc.emitLine({ type: "control_request", request_id: "r3", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "npm test" } } });
  const r3 = JSON.parse(await proc.waitFor((l) => l.includes('"request_id":"r3"'))) as Reply;
  assert.equal(r3.response.response.behavior, "allow");
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "ok" });
  proc.close(0);
  await run;
  assert.deepEqual(consulted, requests.slice(0, 2), "asked about the very requests it sent, and only for a 'no'");
});

test("denyMessage keeps the rule on one line and bounded", () => {
  assert.equal(denyMessage(), "The user denied this action in Modex.");
  assert.equal(denyMessage("  "), "The user denied this action in Modex.");
  const long = denyMessage("x".repeat(500));
  assert.ok(long.startsWith("The user denied this action in Modex (rule: xxx"));
  assert.ok(long.endsWith("…)."));
  assert.ok(long.length < 260);
});
