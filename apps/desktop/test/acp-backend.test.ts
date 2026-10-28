import { test } from "node:test";
import assert from "node:assert/strict";
import type { spawn } from "node:child_process";
import { AcpBackend, acpConfig, acpMode, credentialCount, parseModelList, toolCall } from "../src/main/engine/backends/acp.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";

/**
 * A scripted `opencode acp` / `mimo acp` server, from the shapes OpenCode 1.19.5 and MiMo Code 0.1.16 sent live
 * (docs/reviews/2026-10-28-opencode-acp.json): initialize, session/new|resume|load, set_mode, set_config_option, prompt.
 */
function fakeServer(proc: FakeProcess, opts: { sessionId?: string; resume?: boolean; load?: boolean; refuseMode?: string; unknownSession?: string; hold?: boolean } = {}) {
  const sessionId = opts.sessionId ?? "ses_1";
  const seen: { id?: number; method: string; params: Record<string, unknown> }[] = [];
  const prompts: number[] = [];
  const responses: Record<string, unknown>[] = [];
  proc.stdin.on("data", (d: Buffer) => {
    for (const line of d.toString().split("\n")) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown };
      if (msg.method) seen.push({ id: msg.id, method: msg.method, params: msg.params ?? {} });
      else responses.push(msg as Record<string, unknown>);
      const reply = (result: unknown) => proc.emitLine({ jsonrpc: "2.0", id: msg.id, result });
      if (msg.method === "initialize") reply({ protocolVersion: 1, agentInfo: { name: "OpenCode", version: "1.19.5" }, agentCapabilities: { loadSession: opts.load !== false, promptCapabilities: { image: true }, sessionCapabilities: opts.resume === false ? {} : { resume: {} } } });
      else if (msg.method === "session/new") reply({ sessionId, configOptions: [] });
      else if (msg.method === "session/resume" || msg.method === "session/load") {
        if (opts.unknownSession && msg.params?.sessionId === opts.unknownSession) proc.emitLine({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "session not found" } });
        else {
          if (msg.method === "session/load") proc.emitLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "old", content: { type: "text", text: "REPLAYED" } } } });
          reply(msg.method === "session/load" ? null : { configOptionIds: ["model", "mode"] });
        }
      } else if (msg.method === "session/set_mode") {
        if (opts.refuseMode && msg.params?.modeId === opts.refuseMode) proc.emitLine({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown mode ${opts.refuseMode}` } });
        else reply({});
      } else if (msg.method === "session/set_config_option") {
        if (msg.params?.configId === "effort") proc.emitLine({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "no such option" } });
        else reply({ configOptions: [] });
      } else if (msg.method === "session/prompt") {
        prompts.push(msg.id!);
      } else if (msg.method === "session/cancel") {
        // A notification: the pending prompt answers with the cancelled stop reason.
        const id = prompts.shift();
        if (id !== undefined) proc.emitLine({ jsonrpc: "2.0", id, result: { stopReason: "cancelled" } });
      }
    }
  });
  const update = (update: Record<string, unknown>) => proc.emitLine({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
  const endTurn = (usage?: Record<string, unknown>, stopReason = "end_turn") => { const id = prompts.shift(); proc.emitLine({ jsonrpc: "2.0", id, result: { stopReason, ...(usage ? { usage } : {}) } }); };
  return { seen, responses, sessionId, update, endTurn, prompts };
}

const opts = { cwd: "/repo", mode: "agent" as const, plan: false, model: "" };

test("ACP backend injects Modex's agents inline, opens a session in the thread's cwd, picks the mode agent and streams the reply", async () => {
  const proc = new FakeProcess();
  const server = fakeServer(proc);
  const spawned = fakeSpawn(proc);
  const backend = new AcpBackend("opencode", "opencode", spawned.spawn);
  const { sink, events } = collectSink();
  try {
    const run = backend.runTurn("hello", { ...opts, mode: "chat", model: "opencode/big-pickle", effort: "high" }, sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"session/prompt"'));
    assert.deepEqual(spawned.calls[0]?.args, ["acp", "--pure"]);
    const init = server.seen.find((s) => s.method === "initialize")!;
    assert.equal(init.params.protocolVersion, 1);
    assert.deepEqual((init.params.clientCapabilities as Record<string, unknown>).fs, { readTextFile: false, writeTextFile: false });
    assert.deepEqual(server.seen.find((s) => s.method === "session/new")?.params, { cwd: "/repo", mcpServers: [] });
    assert.deepEqual(server.seen.find((s) => s.method === "session/set_mode")?.params, { sessionId: "ses_1", modeId: "modex-chat" });
    const configs = server.seen.filter((s) => s.method === "session/set_config_option").map((s) => s.params);
    assert.deepEqual(configs, [{ sessionId: "ses_1", configId: "model", value: "opencode/big-pickle" }, { sessionId: "ses_1", configId: "effort", value: "high" }]);
    assert.deepEqual(server.seen.find((s) => s.method === "session/prompt")?.params, { sessionId: "ses_1", prompt: [{ type: "text", text: "hello" }] });
    server.update({ sessionUpdate: "agent_thought_chunk", messageId: "prt_1", content: { type: "text", text: "thinking" } });
    server.update({ sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "Hi " } });
    server.update({ sessionUpdate: "agent_message_chunk", messageId: "msg_1", content: { type: "text", text: "there" } });
    server.update({ sessionUpdate: "usage_update", used: 100, size: 200000 });
    server.endTurn({ inputTokens: 6073, outputTokens: 64, totalTokens: 12305, thoughtTokens: 24, cachedReadTokens: 6144 });
    const result = await run;
    assert.equal(result.status, "completed");
    assert.deepEqual(result.usage, { first: { cacheRead: 6144, cacheWrite: 0, uncached: 6073 }, contextTokens: 12217, outputTokens: 88, calls: 1, totals: { input: 6073, cached: 6144, cacheWrite: 0 } });
    assert.ok(events.includes("session:ses_1"));
    assert.ok(events.includes("think:prt_1:thinking"));
    assert.ok(events.includes("delta:Hi "));
    assert.ok(events.includes("assistant:Hi there"), events.join("\n"));
    assert.ok(events.some((e) => e.startsWith("notice:info:OpenCode has no effort setting")));
  } finally { await backend.dispose(); }
});

test("ACP backend hands the CLI a config that pins each Modex mode's permissions", () => {
  const config = acpConfig() as { autoupdate: boolean; share: string; agent: Record<string, { mode?: string; permission: Record<string, string> }> };
  assert.equal(config.autoupdate, false);
  assert.equal(config.share, "disabled");
  assert.deepEqual(config.agent["modex-chat"]?.permission, { edit: "deny", bash: "ask", task: "deny", external_directory: "ask", webfetch: "allow" });
  assert.deepEqual(config.agent.plan?.permission, { edit: "deny", bash: "ask", task: "deny", external_directory: "ask", webfetch: "allow" });
  assert.deepEqual(config.agent["modex-agent"]?.permission, { edit: "allow", bash: "ask", task: "allow", external_directory: "ask", webfetch: "allow" });
  assert.deepEqual(config.agent["modex-full"]?.permission, { "*": "allow" });
  assert.equal(config.agent.plan?.mode, undefined, "the built-in plan agent keeps its identity; only its permissions are pinned");
  assert.equal(acpMode({ mode: "chat", plan: false }), "modex-chat");
  assert.equal(acpMode({ mode: "agent", plan: false }), "modex-agent");
  assert.equal(acpMode({ mode: "full-access", plan: false }), "modex-full");
  assert.equal(acpMode({ mode: "full-access", plan: true }), "plan");
});

test("MiMo Code uses its own config variable and binary, and the family name in notices", async () => {
  const proc = new FakeProcess();
  const server = fakeServer(proc);
  let env: NodeJS.ProcessEnv | undefined;
  const spawnImpl = ((_bin: string, _args: string[], o: { env?: NodeJS.ProcessEnv }) => { env = o.env; return proc; }) as unknown as typeof spawn;
  const backend = new AcpBackend("mimo", "/opt/mimo", spawnImpl);
  const { sink, events } = collectSink();
  try {
    const run = backend.runTurn("go", { ...opts, mode: "chat", confinement: undefined }, sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"session/prompt"'));
    assert.equal(backend.id, "mimo");
    assert.equal(env?.OPENCODE_CONFIG_CONTENT, undefined);
    assert.deepEqual(JSON.parse(env?.MIMOCODE_CONFIG_CONTENT ?? "{}"), acpConfig());
    server.endTurn(undefined, "refusal");
    const result = await run;
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /MiMo Code's model refused/);
    assert.ok(!events.some((e) => e.includes("OpenCode")));
  } finally { await backend.dispose(); }
});

test("ACP backend maps a permission request to a Modex approval and answers with the chosen option", async () => {
  for (const [answer, optionId] of [["yes", "once"], ["always", "always"], ["no", "reject"]] as const) {
    const proc = new FakeProcess();
    const server = fakeServer(proc);
    const backend = new AcpBackend("opencode", "opencode", fakeSpawn(proc).spawn);
    const { sink, events, requests } = collectSink([answer]);
    try {
      const run = backend.runTurn("run it", opts, sink, new AbortController().signal);
      await proc.waitFor((l) => l.includes('"session/prompt"'));
      server.update({ sessionUpdate: "tool_call", toolCallId: "call_1", status: "pending", kind: "execute", title: "bash", rawInput: { cwd: "/repo" } });
      proc.emitLine({ jsonrpc: "2.0", id: 77, method: "session/request_permission", params: { sessionId: "ses_1", toolCall: { toolCallId: "call_1", title: "echo hi > out.txt", kind: "execute", status: "pending", rawInput: { command: "echo hi > out.txt" } }, options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "always", kind: "allow_always", name: "Always allow" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] } });
      await proc.waitFor((l) => l.includes('"id":77'));
      const reply = server.responses.find((r) => r.id === 77)!;
      assert.deepEqual(reply.result, { outcome: { outcome: "selected", optionId } });
      assert.equal(requests[0]?.canAlways, true);
      assert.deepEqual(requests[0]?.action, { backend: "opencode", tool: "shell", title: "$ echo hi > out.txt", input: { command: "echo hi > out.txt" } });
      assert.deepEqual(requests[0]?.native, { runtime: requests[0]?.native?.runtime, request: "77", item: "call_1" });
      assert.ok(events.includes("approval:Allow OpenCode to run echo hi > out.txt?"));
      // The CLI reports the outcome on the call: a rejection is a denial, not a failure.
      server.update({ sessionUpdate: "tool_call_update", toolCallId: "call_1", status: answer === "no" ? "failed" : "completed", kind: "execute", title: "echo hi > out.txt", rawInput: { command: "echo hi > out.txt", cwd: "/repo" }, ...(answer === "no" ? { rawOutput: { error: "The user rejected permission to use this specific tool call." } } : { content: [{ type: "content", content: { type: "text", text: "hi" } }] }) });
      server.endTurn();
      assert.equal((await run).status, "completed");
      const done = events.find((e) => e.startsWith("tool_update:call_1:done"));
      assert.equal(done, answer === "no" ? "tool_update:call_1:done:false:The user rejected permission to use this" : "tool_update:call_1:done:true:hi");
    } finally { await backend.dispose(); }
  }
});

test("ACP backend's edit approvals carry paths, never file contents", async () => {
  const proc = new FakeProcess();
  const server = fakeServer(proc);
  const backend = new AcpBackend("opencode", "opencode", fakeSpawn(proc).spawn);
  const { sink, requests } = collectSink(["yes"]);
  try {
    const run = backend.runTurn("write it", opts, sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"session/prompt"'));
    proc.emitLine({ jsonrpc: "2.0", id: 5, method: "session/request_permission", params: { sessionId: "ses_1", toolCall: { toolCallId: "call_2", name: "write", title: "write", kind: "edit", status: "pending", rawInput: { filePath: "/repo/a.txt", content: "SECRET BODY" }, locations: [{ path: "/repo/a.txt" }] }, options: [{ optionId: "once", kind: "allow_once", name: "Allow once" }, { optionId: "reject", kind: "reject_once", name: "Reject" }] } });
    await proc.waitFor((l) => l.includes('"id":5'));
    assert.equal(requests[0]?.canAlways, false);
    assert.deepEqual(requests[0]?.action, { backend: "opencode", tool: "write", title: "edit /repo/a.txt", input: { file_path: "/repo/a.txt", paths: ["/repo/a.txt"] } });
    assert.ok(!JSON.stringify(requests[0]).includes("SECRET BODY"));
    server.endTurn();
    assert.equal((await run).status, "completed");
  } finally { await backend.dispose(); }
});

test("ACP backend cancels the prompt on Stop and reports the turn interrupted with open tools settled", async () => {
  const proc = new FakeProcess();
  const server = fakeServer(proc);
  const backend = new AcpBackend("opencode", "opencode", fakeSpawn(proc).spawn);
  const { sink, events } = collectSink();
  const abort = new AbortController();
  try {
    const run = backend.runTurn("sleep", opts, sink, abort.signal);
    await proc.waitFor((l) => l.includes('"session/prompt"'));
    server.update({ sessionUpdate: "tool_call", toolCallId: "call_9", status: "in_progress", kind: "execute", title: "sleep 30", rawInput: { command: "sleep 30" } });
    abort.abort();
    await proc.waitFor((l) => l.includes('"session/cancel"'));
    assert.deepEqual(server.seen.find((s) => s.method === "session/cancel")?.params, { sessionId: "ses_1" });
    const result = await run;
    assert.equal(result.status, "interrupted");
    assert.ok(events.includes("tool_update:call_9:done::"), events.join("\n"));
    assert.equal(proc.killed, false, "a stopped turn never kills the shared server");
  } finally { await backend.dispose(); }
});

test("ACP backend resumes a known session once per server, and starts afresh with a notice when the server does not know it", async () => {
  const proc = new FakeProcess();
  const server = fakeServer(proc, { unknownSession: "ses_gone" });
  const backend = new AcpBackend("opencode", "opencode", fakeSpawn(proc).spawn);
  try {
    const first = collectSink();
    const run1 = backend.runTurn("a", { ...opts, resume: "ses_1" }, first.sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"session/prompt"'));
    assert.deepEqual(server.seen.find((s) => s.method === "session/resume")?.params, { sessionId: "ses_1", cwd: "/repo", mcpServers: [] });
    server.endTurn();
    assert.equal((await run1).status, "completed");
    const second = collectSink();
    const run2 = backend.runTurn("b", { ...opts, resume: "ses_1" }, second.sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"session/prompt"') && l.includes('"text":"b"'));
    assert.equal(server.seen.filter((s) => s.method === "session/resume").length, 1, "the second turn reuses the loaded session");
    server.endTurn();
    assert.equal((await run2).status, "completed");
    const third = collectSink();
    const run3 = backend.runTurn("c", { ...opts, resume: "ses_gone" }, third.sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"session/prompt"') && l.includes('"text":"c"'));
    assert.equal(server.seen.filter((s) => s.method === "session/new").length, 1);
    assert.ok(third.events.some((e) => e.startsWith("notice:warn:OpenCode could not reopen this thread's session")));
    assert.ok(third.events.includes("session:ses_1"));
    server.endTurn();
    assert.equal((await run3).status, "completed");
  } finally { await backend.dispose(); }
});

test("ACP backend falls back to session/load without resume and discards the replayed history", async () => {
  const proc = new FakeProcess();
  const server = fakeServer(proc, { resume: false });
  const backend = new AcpBackend("opencode", "opencode", fakeSpawn(proc).spawn);
  const { sink, events } = collectSink();
  try {
    const run = backend.runTurn("again", { ...opts, resume: "ses_1" }, sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"session/prompt"'));
    assert.deepEqual(server.seen.find((s) => s.method === "session/load")?.params, { sessionId: "ses_1", cwd: "/repo", mcpServers: [] });
    server.update({ sessionUpdate: "agent_message_chunk", messageId: "msg_new", content: { type: "text", text: "fresh" } });
    server.endTurn();
    assert.equal((await run).status, "completed");
    assert.ok(!events.some((e) => e.includes("REPLAYED")), events.join("\n"));
    assert.ok(events.includes("assistant:fresh"));
  } finally { await backend.dispose(); }
});

test("ACP backend fails the turn when the CLI refuses the mode, so no turn runs with looser permissions", async () => {
  const proc = new FakeProcess();
  fakeServer(proc, { refuseMode: "plan" });
  const backend = new AcpBackend("opencode", "opencode", fakeSpawn(proc).spawn);
  try {
    const result = await backend.runTurn("plan it", { ...opts, plan: true }, collectSink().sink, new AbortController().signal);
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /unknown mode plan/);
    assert.equal(result.detail?.stage, "set mode");
  } finally { await backend.dispose(); }
});

test("ACP backend refuses confined review turns and reports a server exit as a failure", async () => {
  const proc = new FakeProcess();
  fakeServer(proc);
  const backend = new AcpBackend("mimo", "mimo", fakeSpawn(proc).spawn);
  try {
    const refused = await backend.runTurn("review", { ...opts, confinement: { kind: "review-snapshot", systemPrompt: "x", maxTurns: 1 } }, collectSink().sink, new AbortController().signal);
    assert.equal(refused.status, "failed");
    assert.match(refused.error ?? "", /no confined review mode/);
    const run = backend.runTurn("go", opts, collectSink().sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"session/prompt"'));
    proc.stderr.write("boom\n");
    proc.close(2);
    const result = await run;
    assert.equal(result.status, "failed");
    assert.match(result.error ?? "", /mimo acp exited \(2\)/);
    assert.equal(result.detail?.exitCode, 2);
  } finally { await backend.dispose(); }
});

test("ACP backend declines client requests it never offered", async () => {
  const proc = new FakeProcess();
  const server = fakeServer(proc);
  const backend = new AcpBackend("opencode", "opencode", fakeSpawn(proc).spawn);
  const { sink, events } = collectSink();
  try {
    const run = backend.runTurn("read", opts, sink, new AbortController().signal);
    await proc.waitFor((l) => l.includes('"session/prompt"'));
    proc.emitLine({ jsonrpc: "2.0", id: 9, method: "fs/read_text_file", params: { sessionId: "ses_1", path: "/etc/passwd" } });
    await proc.waitFor((l) => l.includes('"id":9'));
    assert.equal(server.responses.find((r) => r.id === 9)?.error && (server.responses.find((r) => r.id === 9)!.error as { code: number }).code, -32601);
    assert.ok(events.some((e) => e.includes("fs/read_text_file")));
    server.endTurn();
    assert.equal((await run).status, "completed");
  } finally { await backend.dispose(); }
});

test("ACP health and model list come from bounded CLI probes", async () => {
  const outputs: Record<string, { code: number; text: string }> = {
    "--version": { code: 0, text: "1.19.5\n" },
    "auth": { code: 0, text: "\u001b[0m\n┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  2 credentials\n" },
    "models": { code: 0, text: "opencode/big-pickle\nopencode/mimo-v2.6-flash-free\nmtplx/mtplx-flash-next-bare-speed\nnot a model\n" },
  };
  const calls: string[][] = [];
  const spawnImpl = ((_bin: string, args: string[]) => {
    calls.push(args);
    const proc = new FakeProcess();
    const out = outputs[args[0]!]!;
    setImmediate(() => { proc.emitLine(out.text); proc.close(out.code); });
    return proc;
  }) as unknown as typeof spawn;
  const backend = new AcpBackend("opencode", "opencode", spawnImpl);
  const status = await backend.health();
  assert.deepEqual(status, { executable: "available", authentication: "authenticated", access: "unverified", detail: "2 credentials configured · model access unverified", version: "1.19.5" });
  const models = await backend.listModels();
  assert.deepEqual(models.map((m) => m.id), ["opencode/big-pickle", "opencode/mimo-v2.6-flash-free", "mtplx/mtplx-flash-next-bare-speed"]);
  assert.deepEqual(calls, [["--version"], ["auth", "list"], ["models"]]);
  outputs.auth = { code: 0, text: "└  0 credentials\n" };
  assert.equal((await new AcpBackend("mimo", "mimo", spawnImpl).health()).authentication, "signed-out");
  assert.match((await new AcpBackend("opencode", "opencode", spawnImpl).health()).detail, /free models may still answer/);
  assert.equal(credentialCount("no such line"), null);
  assert.equal(credentialCount("└  1 credential"), 1);
  assert.deepEqual(parseModelList("x/y\nx/y\n"), [{ id: "x/y", label: "x/y", isDefault: false }]);
});

test("ACP tool calls become Modex tools by kind, with commands as shell lines", () => {
  assert.deepEqual(toolCall({ kind: "execute", title: "bash", rawInput: { cwd: "/r" } }), { name: "shell", title: "$ bash", args: { cwd: "/r" } });
  assert.deepEqual(toolCall({ kind: "execute", title: "ls -la", rawInput: { command: "ls -la", cwd: "/r" } }), { name: "shell", title: "$ ls -la", args: { command: "ls -la", cwd: "/r" } });
  assert.deepEqual(toolCall({ kind: "edit", name: "write", title: "write", rawInput: { filePath: "/r/a", content: "body" }, locations: [{ path: "/r/a" }] }), { name: "write", title: "edit /r/a", args: { filePath: "/r/a", path: "/r/a", paths: ["/r/a"] } });
  assert.deepEqual(toolCall({ kind: "read", name: "read", title: "read", rawInput: { filePath: "/r/a" } }), { name: "read", title: "read", args: { filePath: "/r/a" } });
  assert.deepEqual(toolCall({ kind: "fetch", name: "webfetch", title: "https://x", rawInput: { url: "https://x" } }), { name: "webfetch", title: "https://x", args: { url: "https://x" } });
});
