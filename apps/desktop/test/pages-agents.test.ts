import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { PagesAgents } from "../src/main/engine/pages-agents.js";
import { NotesStore } from "../src/main/engine/notes-store.js";

async function fixture(scoped = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pages-agent-"));
  // The store Modex runs the Pages tools over: notes in a folder.
  const space = new NotesStore(path.join(dir, "notes")); let enabled = true; const receipts: unknown[] = [];
  // Scoped like the app: each Modex project's agents work in that project's notes.
  const agents = new PagesAgents({ space, enabled: () => enabled, ...(scoped ? {
    notes: space,
    scope: (id: string) => { const project = space.projectFor(id); return project ? { id: project.id, rel: project.rel } : null; },
  } : {}) });
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
    assert.deepEqual((await client.listTools()).tools.map(t => t.name), ["search", "read", "create", "edit", "update", "trash", "restore", "history", "revert", "list", "create_folder", "move", "read_file"]);
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

test("a project's agents work in that project's notes only, with folders, and never see another project's", async () => {
  const f = await fixture(true);
  const mine = f.space.linkProject({ id: "project", name: "mine", path: "/code/mine" });
  const theirs = f.space.linkProject({ id: "other", name: "theirs", path: "/code/theirs" });
  const secret = f.space.create({ title: "Their secret", markdown: "keep out", containerId: theirs.id });
  const { lease, client, call } = await f.begin();
  const refused = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, name);
    return (result.content as { text: string }[])[0]!.text;
  };
  try {
    assert.equal((await call("search", { query: "" })).total, 0, "another project's notes are not even listed");
    assert.match(await refused("read", { id: secret.id }), /outside this project/);
    assert.match(await refused("edit", { id: secret.id, revision: 1, find: "keep", replace: "x", summary: "Try" }), /outside this project/);
    assert.match(await refused("create", { title: "Child", markdown: "", parentId: secret.id, summary: "Try" }), /outside this project/);
    const created = await call("create", { title: "Decision", markdown: "Ship it", summary: "Record decision" });
    assert.ok(f.space.pageRel(created.id)!.startsWith(`${mine.rel}/`), "a new note lands in the project's own notes");
    const folder = await call("create_folder", { name: "Decisions", summary: "Group decisions" });
    await call("move", { id: created.id, targetId: folder.id, summary: "File decision" });
    assert.ok(f.space.pageRel(created.id)!.startsWith(`${mine.rel}/Decisions/`));
    assert.deepEqual((await call("list", { folderId: folder.id })).items.map((item: { id: string; kind: string }) => [item.id, item.kind]), [[created.id, "note"]]);
    fs.writeFileSync(path.join(f.space.root, ...mine.rel.split("/"), "notes.txt"), "plain text");
    const file = (await call("list", {})).items.find((item: { kind: string }) => item.kind === "file");
    assert.equal((await call("read_file", { id: file.id })).text, "plain text");
    assert.match(await refused("move", { id: created.id, targetId: theirs.id, summary: "Leak" }), /folder of this project/);
    assert.match(await refused("list", { folderId: theirs.id }), /folder of this project/);
    assert.equal((await call("search", { query: "Ship" })).pages[0].id, created.id);
  } finally { await client.close(); await lease.close(); await f.clean(); }
});

test("scoped Pages revert refuses a historical parent in another project", async () => {
  const f = await fixture(true);
  const mine = f.space.linkProject({ id: "project", name: "mine", path: "/code/mine" });
  const theirs = f.space.linkProject({ id: "other", name: "theirs", path: "/code/theirs" });
  const parent = f.space.create({ title: "Other parent", containerId: theirs.id });
  const child = f.space.create({ title: "Moved note", markdown: "Original", parentId: parent.id });
  f.space.moveNodes([child.id], mine.id);
  const { lease, client, call } = await f.begin();
  try {
    const current = await call("read", { id: child.id });
    const rel = f.space.pageRel(child.id);
    const result = await client.callTool({ name: "revert", arguments: { id: child.id, revision: current.revision, version: 1, summary: "Recover original" } });
    assert.equal(result.isError, true);
    assert.match((result.content as { text: string }[])[0]!.text, /outside this project's notes/);
    assert.equal(f.space.pageRel(child.id), rel);
    assert.deepEqual(f.space.list().find(p => p.id === child.id), current);
    assert.equal(f.receipts.length, 0);
    const edited = await call("edit", { id: child.id, revision: current.revision, find: "Original", replace: "Updated", summary: "Update" });
    const recovered = await call("revert", { id: child.id, revision: edited.revision, version: current.revision, summary: "Recover local version" });
    assert.equal(recovered.markdown, "Original");
    assert.equal(f.space.pageRel(child.id), rel);
  } finally { await client.close(); await lease.close(); await f.clean(); }
});

for (const failure of [new Error("The notes folder must be a real folder"), new Error(), "unreadable", "", null, undefined])
test(`an unreadable notes scope refuses calls for ${String(failure) || "an empty string"}`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pages-agent-"));
  const space = new NotesStore(path.join(dir, "notes"));
  space.create({ title: "Elsewhere", markdown: "another project's" });
  const agents = new PagesAgents({ space, notes: space, enabled: () => true, scope: () => { throw failure; } });
  const lease = await agents.prepare({ id: "thread", projectId: "project", mode: "agent", plan: false }, () => assert.fail("wrote"));
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(lease.connection.url)));
    for (const [name, args] of [["search", { query: "" }], ["list", {}], ["create", { title: "x", markdown: "", summary: "Try" }]] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} must not run unscoped`);
      assert.match((result.content as { text: string }[])[0]!.text, /notes are unavailable: .+/);
    }
  } finally { await client.close(); await lease.close(); await agents.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test("a project's agents follow its notes when they move to another workspace mid-turn", async () => {
  const f = await fixture(true);
  const mine = f.space.linkProject({ id: "project", name: "mine", path: "/code/mine" });
  const kept = f.space.create({ title: "Kept", markdown: "before the move", containerId: mine.id });
  const { lease, client, call } = await f.begin();
  try {
    assert.equal((await call("search", { query: "before" })).pages[0].id, kept.id);
    const work = f.space.createWorkspace("Work");
    f.space.moveNodes([mine.id], work.id);
    assert.equal((await call("search", { query: "before" })).pages[0].id, kept.id, "search still finds the project's notes");
    assert.equal((await call("read", { id: kept.id })).title, "Kept");
    const created = await call("create", { title: "After", markdown: "after the move", summary: "Record" });
    assert.ok(f.space.pageRel(created.id)!.startsWith("Work/"), "a new note lands where the project's notes now are");
    assert.equal((await call("read", { id: created.id })).id, created.id, "and the agent can read what it just made");
    assert.ok((await call("list", {})).items.some((item: { id: string }) => item.id === created.id));
  } finally { await client.close(); await lease.close(); await f.clean(); }
});

test("a read-only turn never makes notes for a project that has none", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pages-agent-readonly-"));
  const space = new NotesStore(path.join(dir, "notes"));
  const made: boolean[] = [];
  const agents = new PagesAgents({ space, notes: space, enabled: () => true, scope: (id, create) => {
    made.push(create);
    const project = create ? space.linkProject({ id, name: "fresh", path: "/code/fresh" }) : space.projectFor(id);
    return project ? { id: project.id, rel: project.rel } : null;
  } });
  const lease = await agents.prepare({ id: "thread", projectId: "fresh", mode: "chat", plan: false }, () => {});
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(lease.connection.url)));
  try {
    const result = await client.callTool({ name: "search", arguments: { query: "" } });
    assert.equal(result.isError, true);
    assert.match((result.content as { text: string }[])[0]!.text, /no notes yet/);
    assert.deepEqual(made, [false], "the read-only turn asked without creating");
    assert.equal(space.projectFor("fresh"), undefined, "no notes project was made");
    assert.ok(!fs.existsSync(path.join(space.root, "Personal", "fresh")));
  } finally { await client.close(); await lease.close(); await agents.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
