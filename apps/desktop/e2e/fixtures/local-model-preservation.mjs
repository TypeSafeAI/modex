// Observer-only entry point for disposable, scripted preservation tests. Never packaged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
if (process.env.MODEX_E2E !== "1" || process.env.MODEX_LM_NATIVE_E2E === "1") throw new Error("Preservation fixture requires scripted E2E mode.");
const home = fs.realpathSync(process.env.MODEX_HOME ?? "");
if (!home.startsWith(fs.realpathSync(os.tmpdir()) + path.sep) || !path.basename(home).startsWith("modex-e2e-home-") || JSON.parse(fs.readFileSync(path.join(home, "app/state.json"), "utf8")).settings.default_backend !== "mock") throw new Error("Preservation fixture requires a disposable mock home.");
import { LocalModelDiscovery } from "../../dist/src/main/engine/local-models/discovery.js";
globalThis.__lm4DiscoveryResults = [];
globalThis.__lm4DiscoveryStarts = [];
const discover = LocalModelDiscovery.prototype.discover;
LocalModelDiscovery.prototype.discover = async function (ref, requestId) {
  globalThis.__lm4DiscoveryStarts.push({ connection: { ...ref }, requestId });
  const result = await discover.call(this, ref, requestId);
  globalThis.__lm4DiscoveryResults.push({ connection: { ...ref }, requestId, state: result.state });
  return result;
};


import { LocalExecution } from "../../dist/src/main/engine/local-models/execution.js";
import { ThreadRunner } from "../../dist/src/main/engine/runner.js";
globalThis.__lm4Calls = { localStarts: 0, sends: 0, durableSends: 0, retries: 0 };
const start = LocalExecution.prototype.start;
LocalExecution.prototype.start = function (...args) { globalThis.__lm4Calls.localStarts++; return start.apply(this, args); };
for (const [method, key] of [["send", "sends"], ["sendDurably", "durableSends"], ["retry", "retries"]]) {
  const original = ThreadRunner.prototype[method];
  ThreadRunner.prototype[method] = function (...args) { globalThis.__lm4Calls[key]++; return original.apply(this, args); };
}
await import("./local-model-workflow.mjs");
