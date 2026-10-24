import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import { LocalModelsService } from "../src/main/engine/local-models/service.js";
import type { LocalModelsReply } from "../src/shared/local-connections.js";
import { tmpdir } from "./helpers.js";

/** LM-2 (#378) AC1–AC3: the one IPC channel, exactly as main registers it, with forged requests. */

function mainHandler(service: LocalModelsService) {
  const code = fs.readFileSync(path.resolve(import.meta.dirname, "../src/main/index.js"), "utf8");
  const start = code.indexOf('handle("local-models:command",');
  assert.ok(start >= 0, "main registers local-models:command");
  const registered: { channel: string; handler: Function; options: { localOnly?: boolean } }[] = [];
  vm.runInNewContext(code.slice(start, code.indexOf("\n", start)), {
    localModels: service,
    handle: (channel: string, handler: Function, options: { localOnly?: boolean } = {}) => registered.push({ channel, handler, options }),
  });
  assert.equal(registered.length, 1);
  return registered[0]!;
}

test("local-models:command is local-only and refuses forged or malformed requests", async () => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => { hits.push(`${req.method} ${req.url} ${req.headers.authorization ?? "-"}`); res.end(JSON.stringify({ data: [{ id: "org/model" }] })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const home = tmpdir("modex-lm-");
  const secrets = new SecretStore(home, testCipher);
  secrets.set("typesafe_api_key", "ts-cloud-key-NEVER");
  try {
    const { channel, handler, options } = mainHandler(new LocalModelsService(home, secrets, { timeoutMs: 1000 }));
    assert.equal(channel, "local-models:command");
    assert.deepEqual([Object.keys(options), options.localOnly], [["localOnly"], true], "paired desktops cannot reach it");
    const invoke = async (request: unknown) => await handler(request, {}) as LocalModelsReply;

    const forged: unknown[] = [
      undefined, null, "list", [], { op: "nope" }, { op: "list", extra: 1 },
      { op: "create", input: { label: "x", runtime: "responses", url: "http://10.0.0.1:1" } },
      { op: "create", input: { label: "x", runtime: "responses", url, headers: { authorization: "x" } } },
      { op: "discover", connection: { id: "lc_x", revision: 1 }, requestId: "r", url: "http://10.0.0.1" },
      { op: "discover", connection: { id: "x", revision: "1" }, requestId: "r" },
      { op: "discover", connection: { id: "x", revision: 1 }, requestId: "r".repeat(200) },
      { op: "discover", connection: { id: "x", revision: 1, endpoint: url }, requestId: "r" },
      { op: "update", id: "x", revision: 1, patch: { origin: "http://10.0.0.1" } },
      { op: "delete", id: 5, revision: 1 },
      { op: "cancel" },
    ];
    for (const request of forged) await assert.rejects(invoke(request), /./, JSON.stringify(request));
    assert.deepEqual(hits, [], "no forged request reached a server");

    const created = await invoke({ op: "create", input: { label: "vLLM", runtime: "responses", url, token: "local-tok-SECRET" } });
    assert.equal(created.op, "create");
    const view = created.op === "create" ? created.connection : null;
    assert.ok(view);
    const listed = await invoke({ op: "list" });
    const discovered = await invoke({ op: "discover", connection: { id: view.id, revision: view.revision }, requestId: "r1" });
    assert.equal(discovered.op === "discover" && discovered.result.state, "ready");
    assert.deepEqual(hits, ["GET /v1/models Bearer local-tok-SECRET"], "one metadata read, its own token only");
    for (const reply of [created, listed, discovered]) {
      const text = JSON.stringify(reply);
      assert.equal(text.includes("SECRET") || text.includes("NEVER"), false, "no token in any reply");
    }

    const updated = await invoke({ op: "update", id: view.id, revision: view.revision, patch: { label: "renamed" } });
    assert.equal(updated.op === "update" && updated.connection.label, "renamed");
    await assert.rejects(invoke({ op: "update", id: view.id, revision: 99, patch: { label: "z" } }), /changed/);
    assert.deepEqual(await invoke({ op: "delete", id: view.id, revision: view.revision }), { op: "delete" });
    const after = await invoke({ op: "discover", connection: { id: view.id, revision: view.revision }, requestId: "r2" });
    assert.equal(after.op === "discover" && after.result.state, "stale");
    assert.equal(hits.length, 1, "a deleted connection is never read");
    assert.deepEqual(await invoke({ op: "list" }), { op: "list", connections: [] });
  } finally { server.closeAllConnections(); server.close(); }
});
