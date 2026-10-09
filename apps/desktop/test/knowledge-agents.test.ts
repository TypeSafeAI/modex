import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { KnowledgeAgents } from "../src/main/engine/knowledge-agents.js";
import { KnowledgeService } from "../src/main/engine/knowledge.js";

async function fixture() {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-agent-")));
  const content = path.join(folder, "docs"); fs.mkdirSync(content);
  fs.writeFileSync(path.join(content, "Decision.md"), "# Decision");
  let enabled = true, current = true, failure = false;
  const calls: { name: string; arguments: Record<string, unknown> }[] = [];
  const receipts: unknown[] = [];
  const target = { folder, content, url: "http://127.0.0.1:9999" };
  const agents = new KnowledgeAgents({
    knowledge: { agentTarget: async () => target, isAgentTarget: () => current },
    enabled: () => enabled,
    connect: async () => ({ callTool: async (call) => {
      calls.push(call);
      return { isError: failure, content: [{ type: "text" as const, text: failure ? "conflict" : "saved" }] };
    }, close: async () => {} }),
  });
  const begin = async (plan = false, mode: "agent" | "chat" = "agent") => {
    const lease = await agents.prepare({ id: "thread", projectId: "project", mode, plan }, r => receipts.push(r));
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.connection.url)));
    return { lease, client };
  };
  return { agents, calls, receipts, target, begin, setEnabled: (v: boolean) => enabled = v,
    setCurrent: (v: boolean) => current = v, fail: () => failure = true,
    clean: async () => { await agents.dispose(); fs.rmSync(folder, { recursive: true, force: true }); } };
}

test("knowledge MCP scopes operations and records only successful document writes", async () => {
  const f = await fixture(); const { lease, client } = await f.begin();
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["search", "read", "write", "edit", "history"]);
    await client.callTool({ name: "search", arguments: { query: "decision" } });
    assert.equal(f.calls[0]?.arguments.cwd, f.target.folder);
    assert.equal(f.calls[0]?.arguments.semantic, false);
    await client.callTool({ name: "read", arguments: { path: "Decision.md" } });
    assert.equal(f.calls[1]?.name, "exec");
    assert.match(String(f.calls[1]?.arguments.command), /docs\/Decision.md/);
    await client.callTool({ name: "write", arguments: { path: "New.md", content: "# New", position: "replace", summary: "Verified decision" } });
    assert.deepEqual(f.calls[2]?.arguments.document, { path: "New.md", content: "# New", position: "replace" });
    assert.equal(f.receipts.length, 1);
    f.fail();
    assert.equal((await client.callTool({ name: "edit", arguments: { path: "Decision.md", find: "old", replace: "new", summary: "Update" } })).isError, true);
    assert.equal(f.receipts.length, 1);
  } finally { await client.close(); await lease.close(); await f.clean(); }
});

test("knowledge MCP denies traversal, symlinks, alternate roots and non-document targets", async () => {
  const f = await fixture(); const { lease, client } = await f.begin();
  fs.symlinkSync(os.tmpdir(), path.join(f.target.content, "escape"));
  try {
    for (const args of [{ path: "../outside.md" }, { path: "/tmp/outside.md" }, { path: "escape/outside.md" }, { path: ".ok/config.md" }, { path: "script.ts" }, { path: "Decision.md", cwd: "/tmp" }]) {
      assert.equal((await client.callTool({ name: "read", arguments: args })).isError, true, JSON.stringify(args));
    }
    assert.equal(f.calls.length, 0);
  } finally { await client.close(); await lease.close(); await f.clean(); }
});

test("knowledge MCP enforces current permission, read-only turns and revocation with a stable endpoint", async () => {
  const f = await fixture();
  let previous: string | undefined;
  try {
    for (const [plan, mode] of [[true, "agent"], [false, "chat"], [false, "agent"]] as const) {
      const { lease, client } = await f.begin(plan, mode);
      if (previous) assert.equal(lease.connection.url, previous);
      previous = lease.connection.url;
      try {
        if (!plan && mode === "agent") f.setEnabled(false);
        assert.equal((await client.callTool({ name: "write", arguments: { path: "New.md", content: "write", position: "replace", summary: "Save" } })).isError, true);
        assert.notEqual((await client.callTool({ name: "read", arguments: { path: "Decision.md" } })).isError, true);
        await lease.close();
        assert.equal((await client.callTool({ name: "read", arguments: { path: "Decision.md" } })).isError, true);
      } finally { await client.close(); await lease.close(); }
    }
    f.setEnabled(true);
    const { lease, client } = await f.begin();
    f.setCurrent(false);
    assert.equal((await client.callTool({ name: "read", arguments: { path: "Decision.md" } })).isError, true);
    await client.close(); await lease.close();
    assert.equal(f.receipts.length, 0);
  } finally { await f.clean(); }
});

test("a running read-only turn cannot gain write authority when its stored thread is mutated", async () => {
  const f = await fixture();
  const turn = { id: "mutable", projectId: "project", mode: "chat" as "chat" | "agent", plan: true };
  const preparing = f.agents.prepare(turn, () => assert.fail("Read-only turn wrote knowledge"));
  turn.mode = "agent"; turn.plan = false;
  const lease = await preparing;
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.connection.url)));
    turn.mode = "agent"; turn.plan = false;
    const result = await client.callTool({ name: "write", arguments: { path: "New.md", content: "write", position: "replace", summary: "Save" } });
    assert.equal(result.isError, true);
    assert.equal(f.calls.length, 0);
  } finally { await client.close(); await lease.close(); await f.clean(); }
});

test("stopping knowledge setup returns promptly and never connects its late companion", async () => {
  let release!: () => void;
  let connects = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const agents = new KnowledgeAgents({ knowledge: { agentTarget: async () => { await waiting; return { folder: "/kb", content: "/kb", url: "http://127.0.0.1:1" }; }, isAgentTarget: () => true }, enabled: () => true,
    connect: async () => { connects++; throw new Error("Late connect"); } });
  const abort = new AbortController();
  const preparing = agents.prepare({ id: "cancel", projectId: "p", mode: "agent", plan: false }, () => {}, abort.signal);
  await new Promise(resolve => setTimeout(resolve, 10));
  abort.abort();
  try {
    await assert.rejects(Promise.race([preparing, new Promise((_, reject) => setTimeout(() => reject(new Error("Stop timed out")), 100))]), /abort/i);
    release(); await new Promise(resolve => setImmediate(resolve));
    assert.equal(connects, 0);
  } finally { release(); await preparing.catch(() => {}); await agents.dispose(); }
});

test("Stop cancels an MCP peer that hangs after initialize", async () => {
  let initialized!: () => void;
  const waiting = new Promise<void>(resolve => { initialized = resolve; });
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    if (message.method === "notifications/initialized") { initialized(); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  const agents = new KnowledgeAgents({ knowledge: { agentTarget: async () => ({ folder: "/kb", content: "/kb", url }), isAgentTarget: () => true }, enabled: () => true });
  const abort = new AbortController();
  const preparing = agents.prepare({ id: "hung-peer", projectId: "p", mode: "agent", plan: false }, () => {}, abort.signal);
  try {
    await waiting; abort.abort();
    await assert.rejects(Promise.race([preparing, new Promise((_, reject) => setTimeout(() => reject(new Error("Stop timed out")), 200))]), /abort/i);
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await preparing.then(lease => lease.close(), () => {}); await agents.dispose();
  }
});

test("pinned OpenKnowledge persists agent edits, preserves other writers, returns history and preview", { skip: process.env.MODEX_TEST_OPEN_KNOWLEDGE !== "1" }, async () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "knowledge-real-")));
  const folder = path.join(home, "kb"); fs.mkdirSync(folder);
  fs.mkdirSync(path.join(folder, ".ok")); fs.mkdirSync(path.join(folder, "docs"));
  fs.writeFileSync(path.join(folder, ".ok", "config.yml"), "content:\n  dir: docs\nautoSync:\n  default: off\n");
  const knowledge = new KnowledgeService(home, { runtimeDir: process.env.MODEX_OPEN_KNOWLEDGE_RUNTIME });
  if (!knowledge.snapshot().installed) await knowledge.install();
  await knowledge.selectFolder(folder);
  const agents = new KnowledgeAgents({ knowledge, enabled: () => true });
  const changes: unknown[] = [];
  const lease = await agents.prepare({ id: "real-thread", projectId: "p", mode: "agent", plan: false }, c => changes.push(c));
  const client = new Client({ name: "modex-test", version: "1" });
  try {
    assert.equal(lease.warning, undefined);
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.connection.url)));
    const write = await client.callTool({ name: "write", arguments: { path: "Decision.md", content: "# Decision\n\nVerified old fact.\n", position: "replace", summary: "Save verified decision" } });
    assert.notEqual(write.isError, true, JSON.stringify(write));
    const read = await client.callTool({ name: "read", arguments: { path: "Decision.md" } });
    assert.match(JSON.stringify(read), /Verified old fact/);
    const originalHistory = await client.callTool({ name: "history", arguments: { path: "Decision.md" } });
    const originalVersion = (originalHistory.structuredContent as { entries?: { version: string }[] } | undefined)?.entries?.[0]?.version;
    assert.match(originalVersion ?? "", /^[0-9a-f]{40}$/i);
    const peer = new Client({ name: "human-fixture", version: "1" });
    await peer.connect(new StreamableHTTPClientTransport(new URL(`${knowledge.snapshot().url}/mcp`)));
    try {
      const [human, edit] = await Promise.all([
        peer.callTool({ name: "write", arguments: { cwd: folder, document: { path: "Decision", content: "\nHuman addition.\n", position: "append" }, summary: "Human note" } }),
        client.callTool({ name: "edit", arguments: { path: "Decision.md", find: "Verified old fact.", replace: "Verified new fact.", summary: "Update verified fact" } }),
      ]);
      assert.notEqual(human.isError, true, JSON.stringify(human));
      assert.notEqual(edit.isError, true, JSON.stringify(edit));
    } finally { await peer.close(); }
    const text = fs.readFileSync(path.join(folder, "docs", "Decision.md"), "utf8");
    assert.match(text, /Verified new fact/); assert.match(text, /Human addition/);
    const history = await client.callTool({ name: "history", arguments: { path: "Decision.md" } });
    assert.notEqual(history.isError, true, JSON.stringify(history));
    assert.match(JSON.stringify(history), /Update verified fact|Save verified decision/);
    const search = await client.callTool({ name: "search", arguments: { query: "Decision" } });
    assert.notEqual(search.isError, true, JSON.stringify(search));
    assert.match(JSON.stringify(search), /Decision/);
    const preview = await agents.preview({ folder, path: "Decision.md" });
    assert.equal(new URL(preview).hash, "#/Decision");
    assert.equal(changes.length, 2);
    const recovery = new Client({ name: "human-recovery", version: "1" });
    await recovery.connect(new StreamableHTTPClientTransport(new URL(`${knowledge.snapshot().url}/mcp`)));
    try {
      const restored = await recovery.callTool({ name: "restore_version", arguments: { document: "Decision", version: originalVersion, cwd: folder, summary: "Restore original decision" } });
      assert.notEqual(restored.isError, true, JSON.stringify(restored));
      const restoredText = fs.readFileSync(path.join(folder, "docs", "Decision.md"), "utf8");
      assert.match(restoredText, /Verified old fact/);
      assert.doesNotMatch(restoredText, /Verified new fact/);
    } finally { await recovery.close(); }
  } finally { await client.close(); await lease.close(); await agents.dispose(); await knowledge.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("delayed knowledge requests cannot use the next turn's lease", async () => {
  const f = await fixture(); const first = await f.begin(false, "chat");
  let next: Awaited<ReturnType<typeof f.begin>> | undefined;
  try {
    const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write", arguments: { path: "New.md", content: "Old request", position: "replace", summary: "Create" } } });
    const server = (f.agents as unknown as { server: http.Server }).server;
    const received = new Promise<void>(resolve => {
      const listener = (req: http.IncomingMessage) => {
        if (req.headers["x-regression"] !== "delayed-turn") return;
        server.removeListener("request", listener); resolve();
      };
      server.on("request", listener);
    });
    let request!: http.ClientRequest;
    const response = new Promise<any>((resolve, reject) => {
      request = http.request(first.lease.connection.url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(data), "x-regression": "delayed-turn" } }, res => {
        let body = ""; res.on("data", chunk => body += chunk); res.on("end", () => resolve(JSON.parse(body)));
      });
      request.on("error", reject); request.write(data.slice(0, -1));
    });
    await received; await first.lease.close(); next = await f.begin(); request.end(data.slice(-1));
    assert.equal((await response).result.isError, true);
    assert.equal(f.calls.length, 0);
  } finally { await first.client.close(); await first.lease.close(); await next?.client.close(); await next?.lease.close(); await f.clean(); }
});
