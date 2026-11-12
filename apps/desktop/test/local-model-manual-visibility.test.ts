import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { LocalModelsService } from "../src/main/engine/local-models/service.js";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import { createLocalModelStore, entryModels } from "../src/renderer/local-model-store.js";
import { tmpdir } from "./helpers.js";

async function runtime(status: number, data: unknown) {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { hits, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test("main-authorized manual IDs remain visible when metadata discovery is unavailable", async () => {
  const rt = await runtime(503, { error: "metadata unavailable" });
  const home = tmpdir("modex-manual-visibility-");
  const service = new LocalModelsService(home, new SecretStore(home, testCipher));
  try {
    const created = await service.handle({ op: "create", input: { label: "Manual", runtime: "responses", url: rt.url, manualModels: ["typed/vendor model:opaque"] } });
    assert.equal(created.op, "create");
    if (created.op !== "create") throw new Error("Expected created connection");
    const store = createLocalModelStore(request => service.handle(request));
    await store.loadConnections();
    await store.discover(created.connection);
    const entry = store.getState().entries[0]!;
    assert.equal(entry.result?.state, "unavailable");
    assert.deepEqual(entry.result?.models.map(m => [m.model.id, m.source]), [["typed/vendor model:opaque", "manual"]]);
    assert.deepEqual(entryModels(entry).map(m => m.model.id), ["typed/vendor model:opaque"]);
    assert.deepEqual(rt.hits, ["GET /v1/models"]);
  } finally { await rt.close(); }
});

test("unreadable saved credentials do not reconstruct manual IDs or dispatch metadata requests", async () => {
  const rt = await runtime(200, { data: [] });
  const home = tmpdir("modex-manual-locked-");
  let unlocked = true;
  const service = new LocalModelsService(home, new SecretStore(home, { ...testCipher, available: () => unlocked }));
  try {
    const created = await service.handle({ op: "create", input: { label: "Locked", runtime: "responses", url: rt.url, token: "synthetic-local-token", manualModels: ["typed/private-model"] } });
    if (created.op !== "create") throw new Error("Expected created connection");
    unlocked = false;
    const store = createLocalModelStore(request => service.handle(request));
    await store.loadConnections();
    await store.discover(created.connection);
    const entry = store.getState().entries[0]!;
    assert.equal(entry.result?.state, "unavailable");
    assert.equal(entry.result?.state === "unavailable" && entry.result.reason, "credential-unavailable");
    assert.deepEqual(entryModels(entry), []);
    assert.deepEqual(rt.hits, []);
  } finally { await rt.close(); }
});

test("rejected IPC refresh clears cached model descriptors instead of exposing an old listing", async () => {
  const rt = await runtime(200, { data: [{ id: "previously-discovered" }] });
  const home = tmpdir("modex-manual-ipc-");
  const service = new LocalModelsService(home, new SecretStore(home, testCipher));
  let reject = false;
  try {
    const created = await service.handle({ op: "create", input: { label: "IPC", runtime: "responses", url: rt.url, manualModels: ["typed/manual"] } });
    if (created.op !== "create") throw new Error("Expected created connection");
    const store = createLocalModelStore(request => {
      if (reject && request.op === "discover") return Promise.reject(new Error("synthetic IPC refusal before main"));
      return service.handle(request);
    });
    await store.loadConnections();
    await store.discover(created.connection);
    assert.deepEqual(entryModels(store.getState().entries[0]!).map(m => m.model.id), ["previously-discovered", "typed/manual"]);
    reject = true;
    await store.discover(created.connection);
    const entry = store.getState().entries[0]!;
    assert.equal(entry.result?.state, "unavailable");
    assert.deepEqual(entry.result?.models, [], "IPC refusal must not retain descriptors from an earlier main reply");
    assert.deepEqual(entryModels(entry), []);
    assert.deepEqual(rt.hits, ["GET /v1/models"]);
  } finally { await rt.close(); }
});
