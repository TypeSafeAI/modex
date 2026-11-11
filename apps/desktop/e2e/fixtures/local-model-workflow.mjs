// Inject a scripted app-server only in a disposable Electron acceptance home.
// The production index, preload, IPC, runner, admission policy and renderer stay in use.
// This fixture is never packaged and does not establish real-model qualification.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ThreadRunner } from "../../dist/src/main/engine/runner.js";
import { LocalExecution } from "../../dist/src/main/engine/local-models/execution.js";
import { LocalConnectionStore } from "../../dist/src/main/engine/local-models/connections.js";
import { SecretStore, testCipher } from "../../dist/src/main/engine/secrets.js";
import { localWorkflowSpawn } from "../../dist/test/local-workflow-fixture.js";

const home = fs.realpathSync(process.env.MODEX_HOME ?? "");
if (process.env.MODEX_E2E !== "1" || !home.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)
  || !path.basename(home).startsWith("modex-e2e-home-")
  || JSON.parse(fs.readFileSync(path.join(home, "app/state.json"), "utf8")).settings.default_backend !== "mock") {
  throw new Error("Local workflow acceptance requires a disposable mock home.");
}
const installed = new WeakSet();
// Only this unpackaged, disposable-home entry point can select the real test transport.
const native = process.env.MODEX_LM_NATIVE_E2E === "1" ? await import("./local-model-native.mjs") : null;
function install(runner) {
  if (installed.has(runner)) return;
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));

  runner.o.localExecution = native ? native.createNativeExecution(home, connections, runner) : new LocalExecution(home, connections, "fixture-codex", localWorkflowSpawn);
  runner.backends.codex = { id: "codex", listModels: async () => [{ id: "fixture-cloud", label: "Fixture Cloud", isDefault: true }],
    health: async () => ({ executable: "available", authentication: "authenticated", access: "available", detail: "Offline fixture" }),
    dispose: async () => {}, runTurn: async () => { globalThis.__modexLocalNative?.cloudCalled(); throw new Error("A local fixture reached the cloud backend"); } };
  installed.add(runner);
}
for (const method of ["updateThread", "send", "sendDurably", "retry", "listModels", "backend"]) {
  const original = ThreadRunner.prototype[method];
  ThreadRunner.prototype[method] = function (...args) { install(this); return original.apply(this, args); };
}
await import("../../dist/src/main/index.js");
