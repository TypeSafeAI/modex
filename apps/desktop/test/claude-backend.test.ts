import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ClaudeBackend, denyMessage, fastModeOf, toolTitle, userContent } from "../src/main/engine/backends/claude.js";
import type { ApprovalRequest } from "../src/main/engine/backends/types.js";
import { FakeProcess, fakeSpawn, collectSink, flushClaude, scriptedClaudeQuery } from "./fakeproc.js";
import { PNG_B64, tmpdir } from "./helpers.js";
import { fileURLToPath } from "node:url";
import { claudeCall } from "../src/main/engine/backends/usage.js";

test("attached images become base64 blocks on the user message; text and other files stay as text", () => {
  assert.equal(userContent("hi"), "hi");
  assert.equal(userContent("hi", [{ name: "a.pdf", mime: "application/pdf", kind: "file", path: "/x/a.pdf" }]), "hi");
  const png = path.join(tmpdir(), "shot.png");
  fs.writeFileSync(png, Buffer.from(PNG_B64, "base64"));
  const shot = { name: "shot.png", mime: "image/png" as const, kind: "image" as const, path: png };
  assert.deepEqual(userContent("what is this?", [shot, { name: "a.pdf", mime: "application/pdf", kind: "file", path: "/x/a.pdf" }]), [
    { type: "text", text: "what is this?" },
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_B64 } },
  ]);
  // The API rejects an empty text block, so an image-only message carries only the image.
  assert.deepEqual((userContent("  ", [shot]) as { type: string }[]).map((b) => b.type), ["image"]);
});

test("ClaudeBackend writes attached images into the user message", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery);
  const png = path.join(tmpdir(), "shot.png");
  fs.writeFileSync(png, Buffer.from(PNG_B64, "base64"));
  const run = backend.runTurn("what is this?", { cwd: "/repo", mode: "chat", plan: false, model: "", attachments: [{ name: "shot.png", mime: "image/png", kind: "image", path: png }] }, collectSink().sink, new AbortController().signal);
  const first = JSON.parse(await proc.waitFor((l) => l.includes('"type":"user"'))) as { message: { content: { type: string; source?: { data: string } }[] } };
  assert.deepEqual(first.message.content.map((b) => b.type), ["text", "image"]);
  assert.equal(first.message.content[1]!.source!.data, PNG_B64);
  proc.emitLine({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s", num_turns: 1 });
  assert.equal((await run).status, "completed");
});

test("Claude attaches Pages and knowledge together with exact session tool allowlists", () => {
  const pages = { url: "http://127.0.0.1:1234/mcp/pages", instructions: "Maintain Space notes" };
  const knowledge = { url: "http://127.0.0.1:1234/mcp/knowledge", instructions: "Maintain verified knowledge" };
  for (const resume of [undefined, "previous-session"]) {
    const opts = { cwd: "/worktree", model: "", plan: false, mode: "agent" as const, pages, knowledge, resume };
    const session = ClaudeBackend.sessionOptions(opts);
    assert.deepEqual(session.mcpServers, {
      modex_knowledge: { type: "http", url: knowledge.url }, modex_pages: { type: "http", url: pages.url },
    });
    assert.equal(session.systemPrompt && typeof session.systemPrompt === "object" && "append" in session.systemPrompt ? session.systemPrompt.append : undefined, `${knowledge.instructions}\n\n${pages.instructions}`);
    assert.deepEqual(session.allowedTools, [
      ...["search", "read", "write", "edit", "history"].map(name => `mcp__modex_knowledge__${name}`),
      ...["search", "read", "create", "edit", "update", "trash", "restore", "history", "revert", "list", "create_folder", "move", "read_file"].map(name => `mcp__modex_pages__${name}`),
    ]);
    if (resume) assert.equal(session.resume, resume);
    assert.deepEqual(session.settingSources, ["user", "project", "local"]);
  }
});

test("Claude attaches thread knowledge MCP and maintenance instructions without changing cwd", () => {
  const knowledge = { url: "http://127.0.0.1:1234/mcp/thread", instructions: "Maintain verified knowledge" };
  const session = ClaudeBackend.sessionOptions({ cwd: "/worktree", model: "", plan: false, mode: "agent", knowledge });
  assert.deepEqual(session.mcpServers, { modex_knowledge: { type: "http", url: knowledge.url } });
  assert.equal(session.systemPrompt && typeof session.systemPrompt === "object" && "append" in session.systemPrompt ? session.systemPrompt.append : undefined, knowledge.instructions);
  assert.deepEqual(session.allowedTools, ["search", "read", "write", "edit", "history"].map(name => `mcp__modex_knowledge__${name}`));
});

test("ClaudeBackend.sessionOptions maps modes and plan onto Agent SDK permissionMode", () => {
  const base = { cwd: "/w", model: "sonnet", plan: false } as const;
  assert.equal(ClaudeBackend.sessionOptions({ ...base, mode: "agent" }).permissionMode, "acceptEdits");
  assert.equal(ClaudeBackend.sessionOptions({ ...base, mode: "agent" }).model, "sonnet");
  const chat = ClaudeBackend.sessionOptions({ ...base, mode: "chat" });
  assert.equal(chat.permissionMode, "default");
  assert.deepEqual(chat.disallowedTools, ["Edit", "Write", "NotebookEdit"]);
  const full = ClaudeBackend.sessionOptions({ ...base, mode: "full-access" });
  assert.equal(full.permissionMode, "bypassPermissions");
  assert.equal(full.allowDangerouslySkipPermissions, true);
  assert.equal(ClaudeBackend.sessionOptions({ ...base, mode: "agent", plan: true }).permissionMode, "plan");
  assert.equal(ClaudeBackend.sessionOptions({ ...base, mode: "agent", resume: "abc" }).resume, "abc");
  const a = ClaudeBackend.sessionOptions({ ...base, mode: "agent" });
  assert.equal(a.includePartialMessages, true);
  assert.equal(a.forwardSubagentText, true);
  assert.equal(a.persistSession, true);
  assert.deepEqual(a.settingSources, ["user", "project", "local"]);
  assert.deepEqual(a.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.deepEqual(a.tools, { type: "preset", preset: "claude_code" });
  assert.equal(toolTitle("Bash", { command: "npm test" }), "$ npm test");
  assert.equal(toolTitle("Edit", { file_path: "src/a.ts" }), "edit src/a.ts");
});

test("ClaudeBackend: streams deltas, tools, answers a permission request, resumes by session id", async () => {
  const proc = new FakeProcess();
  const { spawn, calls } = fakeSpawn(proc);
  const backend = new ClaudeBackend("claude", spawn, {}, scriptedClaudeQuery);
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
  proc.emitLine({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Write", tool_use_id: "tu1", input: { file_path: "/repo/probe.txt", content: "hi" }, permission_suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] } });
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
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery);
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
  assert.equal((r.detail?.sdk as { permissionMode?: string })?.permissionMode, "default");
});

test("ClaudeBackend: a non-zero exit carries the exit code and stderr tail", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery);
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

test("ClaudeBackend: abort kills a Claude that ignores the interrupt and reports interrupted", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, { interruptGraceMs: 10 }, scriptedClaudeQuery);
  const ac = new AbortController();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, collectSink().sink, ac.signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  ac.abort();
  const r = await run;
  assert.equal(r.status, "interrupted");
  assert.equal(proc.killed, true);
});

test("ClaudeBackend: Stop that Claude honours ends on the interrupted turn's result, without a kill", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, { interruptGraceMs: 5_000 }, scriptedClaudeQuery);
  const { sink, events } = collectSink();
  const ac = new AbortController();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, sink, ac.signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  // Like the CLI, the fake exits once its input ends.
  proc.stdin.on("finish", () => proc.close(0));
  proc.emitLine({ type: "system", subtype: "init", session_id: "s" });
  ac.abort();
  await proc.waitFor((l) => l.includes('"subtype":"interrupt"'));
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "late" } } });
  proc.emitLine({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "s", num_turns: 1 });
  assert.deepEqual(await run, { status: "interrupted" });
  assert.equal(proc.killed, false, "a clean interrupt needs no signal");
  assert.ok(!events.includes("delta:late"), "nothing reaches the thread after Stop");
});

test("ClaudeBackend: Stop with messages still in flight settles the turn", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, { interruptGraceMs: 10 }, scriptedClaudeQuery);
  const ac = new AbortController();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, collectSink().sink, ac.signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  // A streamed token is already on the wire when the user presses Stop.
  proc.emitLine({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } } });
  ac.abort();
  const r = await Promise.race([run, new Promise((res) => setTimeout(() => res("hung"), 2000))]);
  assert.deepEqual(r, { status: "interrupted" });
});

test("ClaudeBackend: a permission request Claude withdraws aborts its approval and gets no answer", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, { backgroundIdleMs: 20 }, scriptedClaudeQuery);
  const { sink, events } = collectSink();
  let withdrawn: AbortSignal | undefined;
  const waiting = { ...sink, approval: (req: Parameters<typeof sink.approval>[0], cancelled?: AbortSignal) => {
    events.push(`approval:${req.question}`);
    withdrawn = cancelled;
    return new Promise<"no">((r) => cancelled?.addEventListener("abort", () => r("no")));
  } };
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, waiting, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.emitLine({ type: "assistant", message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "ls" } }] } });
  proc.emitLine({ type: "control_request", request_id: "r1", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "tu1", input: { command: "ls" } } });
  while (!withdrawn) await flushClaude();
  assert.equal(withdrawn.aborted, false);
  proc.emitLine({ type: "control_cancel_request", request_id: "r1" });
  while (!withdrawn.aborted) await flushClaude();
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "ok", num_turns: 1 });
  const r = await run;
  assert.equal(r.status, "completed");
  assert.ok(!proc.written.some((l) => l.includes("control_response")), "a withdrawn request gets no answer");
});

test("ClaudeBackend: a launch error fails the turn and closes the session", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery);
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "" }, collectSink().sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  let ended = false;
  proc.stdin.on("finish", () => { ended = true; });
  proc.emit("error", Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" }));
  const r = await run;
  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /ENOENT\. Is Claude Code installed and on PATH\?/);
  assert.equal(r.detail?.errno, "ENOENT");
  await flushClaude();
  assert.equal(ended, true, "the SDK session is closed, not left waiting on the prompt");
});

test("ClaudeBackend.sessionOptions passes reasoning effort and fast mode; models advertise the effort ladder", () => {
  const base = { cwd: "/w", model: "haiku", plan: false, mode: "agent" as const };
  const plain = ClaudeBackend.sessionOptions(base);
  assert.equal(plain.effort, undefined);
  assert.equal(plain.settings, undefined);
  const tuned = ClaudeBackend.sessionOptions({ ...base, effort: "xhigh", fast: true });
  assert.equal(tuned.effort, "xhigh");
  assert.deepEqual(tuned.settings, { fastMode: true });
  assert.deepEqual(ClaudeBackend.MODELS[0]!.efforts, ["low", "medium", "high", "xhigh", "max"]);
});

test("only Opus advertises fast mode, which Claude Code runs on Opus 4.8 and newer only", () => {
  assert.deepEqual(ClaudeBackend.MODELS.filter((m) => m.serviceTiers?.includes("fast")).map((m) => m.id), ["opus"]);
});

test("ClaudeBackend reports fast mode as the CLI did, from a captured turn whose account has no usage credits", async () => {
  const lines = fs.readFileSync(fileURLToPath(new URL("../../test/fixtures/usage/claude-fast-off.jsonl", import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const proc = new FakeProcess();
  const run = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery).runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "opus", fast: true }, collectSink().sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  for (const line of lines) proc.emitLine(line);
  const result = await run;
  assert.equal(result.status, "completed");
  assert.deepEqual(result.fastMode, { on: false, why: "fast mode requires usage credits (extra_usage_disabled)" });
});

test("fastModeOf words each state; the latest init or result wins", async () => {
  assert.equal(fastModeOf(undefined, undefined), undefined);
  assert.deepEqual(fastModeOf("on", undefined), { on: true });
  assert.deepEqual(fastModeOf("cooldown", undefined), { on: false, why: "fast mode is cooling down after a rate limit" });
  assert.deepEqual(fastModeOf("off", "preference"), { on: false, why: "fast mode is disabled by your organization (preference)" });
  assert.deepEqual(fastModeOf("off", "something_new"), { on: false, why: "Claude Code reported something_new" });
  assert.deepEqual(fastModeOf("off", undefined), { on: false, why: "Claude Code reported fast mode off" });
  const proc = new FakeProcess();
  const run = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery).runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "opus", fast: true }, collectSink().sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.emitLine({ type: "system", subtype: "init", session_id: "s", fast_mode_state: "on" });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s", fast_mode_state: "cooldown", num_turns: 1 });
  assert.deepEqual((await run).fastMode, { on: false, why: "fast mode is cooling down after a rate limit" });
});

test("Stop waits for the Claude process to close before settling", async () => {
  const proc = new FakeProcess();
  proc.kill = () => { proc.killed = true; return true; };
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, { interruptGraceMs: 10 }, scriptedClaudeQuery);
  const abort = new AbortController();
  const run = backend.runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "" }, collectSink().sink, abort.signal);
  let settled = false;
  void run.then(() => { settled = true; });
  await proc.waitFor((l) => l.includes('"type":"user"'));
  abort.abort();
  // Stop asks first; a Claude that has not stopped within the grace window is killed.
  await proc.waitFor((l) => l.includes('"subtype":"interrupt"'));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(proc.killed, true);
  assert.equal(settled, false, "SIGTERM delivery is not process termination");
  proc.close(null);
  assert.deepEqual(await run, { status: "interrupted" });
});

test("ClaudeBackend: can_use_tool carries a structured action; a rule's 'yes' allows without updatedPermissions", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery);
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
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "ok", num_turns: 1 });
  proc.close(0);
  await run;
  assert.deepEqual(requests.map((r) => r.action), [
    { backend: "claude", tool: "Bash", title: "$ npm test", cwd: "/repo", input: { command: "npm test" } },
    { backend: "claude", tool: "Edit", title: "edit src/a.ts", cwd: "/repo", input: { file_path: "src/a.ts", old_string: "a", new_string: "b" } },
  ]);
});

test("ClaudeBackend: a rule's refusal names the rule in the deny message; a human's 'no' keeps today's", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery);
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
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "ok", num_turns: 1 });
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

const tokens = (read: number, write: number, input: number, output = 1) => ({ input_tokens: input, cache_creation_input_tokens: write, cache_read_input_tokens: read, output_tokens: output });

test("ClaudeBackend reports usage: first call, last call's context, each id once, sub-agents excluded", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery);
  const run = backend.runTurn("go", { cwd: "/repo", mode: "agent", plan: false, model: "opus" }, collectSink().sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.emitLine({ type: "assistant", parent_tool_use_id: null, session_id: "s", message: { id: "m1", content: [], usage: tokens(40_000, 500, 3) } });
  proc.emitLine({ type: "assistant", parent_tool_use_id: null, session_id: "s", message: { id: "m1", content: [], usage: tokens(40_000, 500, 3) } });
  proc.emitLine({ type: "assistant", parent_tool_use_id: "toolu_agent", session_id: "s", message: { id: "sub1", content: [], usage: tokens(0, 9_000, 9) } });
  proc.emitLine({ type: "assistant", parent_tool_use_id: null, session_id: "s", message: { id: "m2", content: [], usage: tokens(40_500, 1_200, 2) } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s", usage: { output_tokens: 850 } });
  const result = await run;
  assert.deepEqual(result.usage, { first: { cacheRead: 40_000, cacheWrite: 500, uncached: 3 }, contextTokens: 41_702, outputTokens: 850, calls: 2, totals: { input: 5, cached: 80_500, cacheWrite: 1_700 } });
});

test("ClaudeBackend usage spans the follow-up turn after background work", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery);
  const run = backend.runTurn("run it in the background", { cwd: "/repo", mode: "agent", plan: false, model: "sonnet" }, collectSink(["yes"]).sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  proc.emitLine({ type: "system", subtype: "init", session_id: "s" });
  proc.emitLine({ type: "assistant", message: { id: "a1", usage: tokens(30_000, 100, 1, 5), content: [{ type: "tool_use", id: "tu-bg", name: "Bash", input: { command: "npm test", run_in_background: true } }] } });
  proc.emitLine({ type: "system", subtype: "task_started", task_id: "bash-1", tool_use_id: "tu-bg", task_type: "local_bash", is_backgrounded: true });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "Started.", usage: { output_tokens: 40 } });
  proc.emitLine({ type: "system", subtype: "task_notification", task_id: "bash-1", tool_use_id: "tu-bg", status: "completed" });
  proc.emitLine({ type: "system", subtype: "init", session_id: "s" });
  proc.emitLine({ type: "assistant", message: { id: "a2", usage: tokens(30_100, 300, 1, 5), content: [{ type: "text", text: "Tests passed." }] } });
  proc.emitLine({ type: "result", subtype: "success", is_error: false, session_id: "s", result: "Done.", usage: { output_tokens: 60 } });
  const result = await run;
  assert.deepEqual(result.usage, { first: { cacheRead: 30_000, cacheWrite: 100, uncached: 1 }, contextTokens: 30_401, outputTokens: 100, calls: 2, totals: { input: 2, cached: 60_100, cacheWrite: 400 } });
  proc.close(0);
});

test("ClaudeBackend reads usage from a captured stream-json turn; a turn without usage reports none", async () => {
  const lines = fs.readFileSync(fileURLToPath(new URL("../../test/fixtures/usage/claude-turn.jsonl", import.meta.url)), "utf8").trim().split("\n").map((l) => JSON.parse(l) as { type: string; message?: { id: string; usage: Record<string, number> }; usage?: { output_tokens: number } });
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery);
  const run = backend.runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "haiku" }, collectSink().sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  for (const line of lines) proc.emitLine(line);
  const result = await run;
  const calls = [...new Map(lines.filter((l) => l.type === "assistant").map((l) => [l.message!.id, l.message!.usage])).values()];
  const last = claudeCall(calls.at(-1)!);
  assert.deepEqual(result.usage, {
    first: claudeCall(calls[0]!),
    contextTokens: last.cacheRead + last.cacheWrite + last.uncached,
    outputTokens: lines.find((l) => l.type === "result")!.usage!.output_tokens,
    calls: calls.length,
    totals: calls.map((u) => claudeCall(u!)).reduce((t, c) => ({ input: t.input + c.uncached, cached: t.cached + c.cacheRead, cacheWrite: t.cacheWrite + c.cacheWrite }), { input: 0, cached: 0, cacheWrite: 0 }),
  });
  assert.ok(result.usage!.first.cacheRead > 0, "the captured resumed turn read the cache");

  const bare = new FakeProcess();
  const none = new ClaudeBackend("claude", fakeSpawn(bare).spawn, {}, scriptedClaudeQuery).runTurn("go", { cwd: "/repo", mode: "chat", plan: false, model: "" }, collectSink().sink, new AbortController().signal);
  await bare.waitFor((l) => l.includes('"type":"user"'));
  bare.emitLine({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "s", num_turns: 1 });
  assert.deepEqual(await none, { status: "completed" });
});

test("ClaudeBackend drops the CLI's synthetic credit refusal reply and fails the turn with its words", async () => {
  const proc = new FakeProcess();
  const backend = new ClaudeBackend("claude", fakeSpawn(proc).spawn, {}, scriptedClaudeQuery);
  const { sink, events } = collectSink();
  const run = backend.runTurn("hi", { cwd: "/repo", mode: "chat", plan: false, model: "fable" }, sink, new AbortController().signal);
  await proc.waitFor((l) => l.includes('"type":"user"'));
  const refusal = "You're out of usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.";
  proc.emitLine({ type: "assistant", error: "rate_limit", message: { id: "m1", model: "<synthetic>", content: [{ type: "text", text: refusal }] }, session_id: "s" });
  proc.emitLine({ type: "result", subtype: "success", is_error: true, result: refusal, num_turns: 1, session_id: "s" });
  const result = await run;
  assert.equal(result.status, "failed");
  assert.equal(result.error, refusal);
  assert.ok(!events.some((e) => e.startsWith("assistant:")), "no reply bubble for the refusal");
});
