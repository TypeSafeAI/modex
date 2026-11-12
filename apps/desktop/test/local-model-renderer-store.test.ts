import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { createLocalModelStore } from "../src/renderer/local-model-store.js";
import type { LocalConnectionView, LocalModelsReply, LocalModelsRequest } from "../src/shared/local-connections.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

const c = (revision = 1): LocalConnectionView => ({ id: "fixture-connection", revision, label: "Ollama", runtime: "ollama",
  origin: `http://127.0.0.1:${11433 + revision}`, basePath: "", manualModels: [], credential: { present: false, storage: "test" },
  createdAt: "2026-11-04T00:00:00.000Z", updatedAt: "2026-11-04T00:00:00.000Z" });
function ready(request: Extract<LocalModelsRequest, { op: "discover" }>, checkedAt = "2026-11-04T01:00:00.000Z"): LocalModelsReply {
  return { op: "discover", result: { state: "ready", connection: request.connection, requestId: request.requestId, models: [], truncated: false, checkedAt } };
}

for (const operation of ["create", "update", "delete"] as const) {
  test(`a profile list begun before ${operation} cannot replace its acknowledged result`, async () => {
    const old = operation === "create" ? [] : [c()];
    let profiles = old;
    let first = true;
    const held = deferred<LocalModelsReply>();
    const store = createLocalModelStore(async request => {
      if (request.op === "list") {
        if (first) { first = false; return held.promise; }
        return { op: "list", connections: profiles };
      }
      if (request.op === "create" || request.op === "update") {
        const connection = c(request.op === "create" ? 1 : 2); profiles = [connection];
        return { op: request.op, connection };
      }
      if (request.op === "delete") { profiles = []; return { op: "delete" }; }
      if (request.op === "discover") return ready(request);
      return { op: "cancel" };
    });
    const listing = store.loadConnections();
    const changing = operation === "create" ? store.addConnection({ label: "Ollama", runtime: "ollama", url: c().origin })
      : operation === "update" ? store.updateConnection(c(), { url: c(2).origin }) : store.removeConnection(c());
    await setImmediate();
    held.resolve({ op: "list", connections: old });
    await Promise.all([listing, changing]);
    assert.deepEqual(store.getState().entries.map(e => e.connection), profiles);
    assert.equal(store.getState().loaded, true);
  });
}

test("failed cancellation ends the checking state and a late discovery reply cannot masquerade as a new result", async () => {
  const held = deferred<LocalModelsReply>();
  let request!: Extract<LocalModelsRequest, { op: "discover" }>;
  let checks = 0;
  const store = createLocalModelStore(async input => {
    if (input.op === "list") return { op: "list", connections: [c()] };
    if (input.op === "cancel") throw new Error("cancel acknowledgement lost");
    if (input.op === "discover") { checks++; request = input; return checks === 1 ? held.promise : ready(input); }
    throw new Error("unexpected request");
  });
  await store.loadConnections();
  const checking = store.discover(c());
  assert.equal(store.getState().entries[0]?.checking, true);
  await assert.rejects(store.cancelDiscovery(c()), /cancel acknowledgement lost/);
  assert.equal(store.getState().entries[0]?.checking, false, "Cancel failure must leave the Refresh control usable");
  held.resolve(ready(request)); await checking;
  assert.equal(store.getState().entries[0]?.result, undefined, "the original result was superseded by the uncertain cancel");
  assert.match(store.getState().entries[0]?.error ?? "", /could not be confirmed/);
  await store.discover(c());
  assert.equal(store.getState().entries[0]?.result?.state, "ready");
  assert.equal(store.getState().entries[0]?.checking, false);
});

test("a late Cancel acknowledgement cannot overwrite a completed newer discovery", async () => {
  const old = deferred<LocalModelsReply>(), cancellation = deferred<LocalModelsReply>();
  let firstRequest!: Extract<LocalModelsRequest, { op: "discover" }>;
  let checks = 0;
  const freshAt = "2026-11-04T02:00:00.000Z";
  const store = createLocalModelStore(async request => {
    if (request.op === "list") return { op: "list", connections: [c()] };
    if (request.op === "cancel") return cancellation.promise;
    if (request.op === "discover") {
      checks++;
      if (checks === 1) { firstRequest = request; return old.promise; }
      return ready(request, freshAt);
    }
    throw new Error("unexpected request");
  });
  await store.loadConnections();
  const first = store.discover(c());
  const cancelled = store.cancelDiscovery(c());
  await store.discover(c());
  cancellation.resolve({ op: "cancel" }); await cancelled;
  old.resolve(ready(firstRequest)); await first;
  assert.equal(store.getState().entries[0]?.result?.state, "ready");
  assert.equal(store.getState().entries[0]?.result?.checkedAt, freshAt);
  assert.equal(store.getState().entries[0]?.checking, false);
});
