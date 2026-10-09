import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PagesAgents } from "../src/main/engine/pages-agents.js";
import { SpaceStore } from "../src/main/engine/space-store.js";

async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pages-agent-"));
  const space = new SpaceStore(dir); let enabled = true; const receipts: unknown[] = [];
  const agents = new PagesAgents({ space, enabled: () => enabled });
  const turn = { id: "thread", projectId: "project", mode: "agent" as "agent" | "chat", plan: false };
  const begin = async () => {
    const lease = await agents.prepare(turn, change => receipts.push(change));
    const client = new Client({ name: "test", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.connection.url)));
    return { lease, client, call: async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, JSON.stringify(result));
      return JSON.parse((result.content as { text: string }[])[0]!.text);
    } };
  };
  return { space, agents, turn, begin, receipts, enable: (v: boolean) => enabled = v,
    clean: async () => { await agents.dispose(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test("Pages MCP manages notes, organization, history and recovery through the real store", async () => {
  const f = await fixture(); const { lease, client, call } = await f.begin();
  try {
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["search", "read", "create", "edit", "update", "trash", "restore", "history", "revert"]);
    const parent = await call("create", { title: "Project", markdown: "# Parent", summary: "Create project" });
    let p = await call("create", { title: "Decision", markdown: "Human text\nOriginal", parentId: parent.id, summary: "Create note" });
    assert.equal((await call("search", { query: "Original" })).pages[0].id, p.id);
    assert.equal((await call("read", { id: p.id })).revision, 1);
    p = await call("edit", { id: p.id, revision: 1, find: "Original", replace: "Verified", summary: "Verify decision" });
    assert.equal(p.markdown, "Human text\nVerified");
    p = await call("update", { id: p.id, revision: p.revision, title: "Renamed", parentId: null, favorite: true, summary: "Organize note" });
    assert.equal(p.parentId, null); assert.equal(p.favorite, true);
    assert.equal((await call("history", { id: p.id })).versions[0].actor, "thread:thread");
    await call("trash", { id: p.id, revision: p.revision, summary: "Archive note" });
    assert.equal((await call("search", { query: "Renamed" })).pages.length, 0);
    p = await call("read", { id: p.id });
    await call("restore", { id: p.id, revision: p.revision, summary: "Restore note" });
    p = await call("read", { id: p.id });
    p = await call("revert", { id: p.id, revision: p.revision, version: 1, summary: "Recover original" });
    assert.equal(p.markdown, "Human text\nOriginal"); assert.equal(p.parentId, parent.id);
    assert.equal(f.receipts.length, 7);
  } finally { await client.close(); await lease.close(); await f.clean(); }
});

test("Pages MCP rejects stale, ambiguous and malformed writes without receipts", async () => {
  const f = await fixture(); const { lease, client, call } = await f.begin();
  try {
    const p = f.space.create({ title: "Human", markdown: "repeat repeat aaa" });
    const bad = [
      { name: "edit", arguments: { id: p.id, revision: 1, find: "aa", replace: "lost", summary: "overlapping" } },
      { name: "edit", arguments: { id: p.id, revision: 1, find: "repeat", replace: "lost", summary: "bad" } },
      { name: "update", arguments: { id: p.id, revision: 1, markdown: "lost", summary: "bad" } },
      { name: "update", arguments: { id: p.id, revision: 1, favorite: "yes", summary: "bad" } },
      { name: "create", arguments: { title: "bad", markdown: "x", summary: "" } },
      { name: "exec", arguments: { command: "ls" } },
    ];
    for (const c of bad) assert.equal((await client.callTool(c)).isError, true);
    f.space.save({ ...p, markdown: "Human newer" });
    for (const name of ["edit", "update", "trash", "restore", "revert"]) {
      const args = { id: p.id, revision: 1, summary: "stale", ...(name === "edit" ? { find: "Human", replace: "Agent" } : name === "update" ? { title: "stale" } : name === "revert" ? { version: 1 } : {}) };
      assert.equal((await client.callTool({ name, arguments: args })).isError, true);
    }
    assert.equal((await call("read", { id: p.id })).markdown, "Human newer");
    assert.equal(f.receipts.length, 0);
  } finally { await client.close(); await lease.close(); await f.clean(); }
});

test("Pages MCP requires opt-in, enforces immutable read-only turns and revokes stable routes", async () => {
  const f = await fixture(); let url = "";
  try {
    f.enable(false);
    let session = await f.begin(); url = session.lease.connection.url;
    assert.equal((await session.client.callTool({ name: "search", arguments: { query: "" } })).isError, true);
    await session.client.close(); await session.lease.close();
    f.enable(true); f.turn.mode = "chat";
    const preparing = f.agents.prepare(f.turn, () => assert.fail("Read-only wrote"));
    f.turn.mode = "agent";
    const readonly = await preparing;
    const client = new Client({ name: "readonly", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(readonly.connection.url)));
    assert.equal(readonly.connection.url, url);
    assert.equal((await client.callTool({ name: "create", arguments: { title: "denied", markdown: "", summary: "no" } })).isError, true);
    await client.close(); await readonly.close();
    session = await f.begin();
    await session.call("search", { query: "" });
    f.enable(false);
    assert.equal((await session.client.callTool({ name: "read", arguments: { id: "x" } })).isError, true);
    f.enable(true); await session.lease.close();
    assert.equal((await session.client.callTool({ name: "search", arguments: { query: "" } })).isError, true);
    assert.equal((await fetch(url, { method: "POST", headers: { origin: "https://example.com" } })).status, 403);
    await session.client.close();
  } finally { await f.clean(); }
});

 test("Pages edit can fill an empty note but cannot insert at ambiguous empty matches", async () => {
  const f = await fixture(); const { lease, client, call } = await f.begin();
  try {
    const p = f.space.create({ title: "Empty" });
    const filled = await call("edit", { id: p.id, revision: 1, find: "", replace: "Filled", summary: "Fill note" });
    assert.equal(filled.markdown, "Filled");
    assert.equal((await client.callTool({ name: "edit", arguments: { id: p.id, revision: 2, find: "", replace: "Extra", summary: "Ambiguous" } })).isError, true);
  } finally { await client.close(); await lease.close(); await f.clean(); }
});

test("Pages plan/live mode reductions and overlapping writers never overwrite a newer revision", async () => {
  const f = await fixture();
  try {
    f.turn.plan = true;
    const planned = await f.begin();
    assert.equal((await planned.client.callTool({ name: "create", arguments: { title: "Denied", markdown: "", summary: "Denied" } })).isError, true);
    await planned.client.close(); await planned.lease.close();
    f.turn.plan = false;
    const a = await f.begin();
    const bLease = await f.agents.prepare({ ...f.turn, id: "second" }, c => f.receipts.push(c));
    const b = new Client({ name: "second", version: "1" });
    await b.connect(new StreamableHTTPClientTransport(new URL(bLease.connection.url)));
    try {
      const p = f.space.create({ title: "Shared", markdown: "Original" });
      const request = { name: "edit", arguments: { id: p.id, revision: 1, find: "Original", replace: "First", summary: "First" } };
      const results = await Promise.all([a.client.callTool(request), b.callTool({ ...request, arguments: { ...request.arguments, replace: "Second", summary: "Second" } })]);
      assert.equal(results.filter(r => r.isError).length, 1);
      assert.equal(f.space.list()[0]?.revision, 2);
      assert.equal(f.space.history(p.id).length, 2);
      f.turn.mode = "chat";
      assert.equal((await a.client.callTool({ name: "create", arguments: { title: "Denied", markdown: "", summary: "Denied" } })).isError, true);
      assert.equal(f.receipts.length, 1);
    } finally { await a.client.close(); await a.lease.close(); await b.close(); await bLease.close(); }
  } finally { await f.clean(); }
});

test("a delayed request cannot inherit a subsequent turn's authority", async () => {
  const f = await fixture(); f.turn.mode = "chat";
  const first = await f.begin();
  let next: Awaited<ReturnType<typeof f.agents.prepare>> | undefined;
  try {
    const data = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create", arguments: { title: "Cross-turn", markdown: "Old request", summary: "Create" } } });
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
    await received;
    await first.lease.close(); f.turn.mode = "agent";
    next = await f.agents.prepare(f.turn, () => {});
    request.end(data.slice(-1));
    assert.equal((await response).result.isError, true);
    assert.equal(f.space.list().length, 0);
  } finally { await first.client.close(); await first.lease.close(); await next?.close(); await f.clean(); }
});
