import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalModelsService } from "../src/main/engine/local-models/service.js";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import { tmpdir } from "./helpers.js";

test("editing and removing an in-use local connection preserve the original profile until its turn settles", async () => {
  const home = tmpdir("lm-connection-busy-"); let busy = true;
  const service = new LocalModelsService(home, new SecretStore(home, testCipher), { connectionInUse: () => busy });
  const reply = await service.handle({ op: "create", input: { label: "Ollama", runtime: "ollama", url: "http://127.0.0.1:11434" } });
  assert.equal(reply.op, "create"); if (reply.op !== "create") throw new Error("missing connection");
  const c = reply.connection;
  await assert.rejects(service.handle({ op: "update", id: c.id, revision: c.revision, patch: { url: "http://127.0.0.1:11435" } }), /Stop the local turn/);
  await assert.rejects(service.handle({ op: "delete", id: c.id, revision: c.revision }), /Stop the local turn/);
  assert.deepEqual(service.connections.list(), [c]);
  busy = false;
  const changed = await service.handle({ op: "update", id: c.id, revision: c.revision, patch: { url: "http://127.0.0.1:11435" } });
  assert.equal(changed.op, "update"); if (changed.op !== "update") throw new Error("missing updated connection");
  assert.equal(changed.connection.revision, c.revision + 1);
  await service.handle({ op: "delete", id: c.id, revision: changed.connection.revision });
  assert.deepEqual(service.connections.list(), []);
});
