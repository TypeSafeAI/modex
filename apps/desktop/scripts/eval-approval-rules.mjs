// Run with Electron after building desktop. No coding turn or sample command is executed.
// MODEX_APPROVAL_EVAL_LIVE=1 opts into bounded judgments using the saved Router configuration.
import { app, safeStorage } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { Router } from "../dist/src/main/engine/routing/router.js";
import { SecretStore, electronCipher } from "../dist/src/main/engine/secrets.js";
import { migrateRouting, migrateApprovalGate } from "../dist/src/main/engine/store.js";
import { DEFAULT_APPROVAL_GATE } from "../dist/src/shared/types.js";
import { previewApproval } from "../dist/src/main/engine/approvals/preview.js";
import { receiptFor } from "../dist/src/main/engine/approvals/gate.js";
import { scrubSecrets } from "../dist/src/main/engine/approvals/digest.js";
import { cases, projects } from "./approval-eval-cases.mjs";

const live = process.env.MODEX_APPROVAL_EVAL_LIVE === "1";
const repeats = live ? 3 : 1;
// Match the existing Modex keychain service. Read credentials through the app's cipher only.
app.setName("Modex");
async function run() {
  await app.whenReady();
  const home = process.env.MODEX_HOME ?? path.join(os.homedir(), ".modex");
  const statePath = path.join(home, "app", "state.json");
  const before = fs.existsSync(statePath) ? fs.readFileSync(statePath) : null;
  const saved = before ? JSON.parse(before.toString()).settings : undefined;
  const policy = migrateRouting(saved?.routing);
  const savedGate = migrateApprovalGate(saved?.approval_gate);
  const router = new Router({ home, policy: () => policy, listModels: async () => ({ models: [] }),
    secrets: new SecretStore(home, electronCipher(safeStorage)), ...(live ? {} : { transport: null }) });
  const report = { at: new Date().toISOString(), sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    platform: process.platform, arch: process.arch, electron: process.versions.electron,
    live, repeats, model: policy.jev_model, defaultGateEnabled: DEFAULT_APPROVAL_GATE.enabled, savedGateEnabled: savedGate.enabled,
    corpusSha256: createHash("sha256").update(JSON.stringify(cases)).digest("hex"), results: [] };
  for (const sample of cases) {
    if (!live && !sample.transport && sample.judgeCalls !== 0) continue;
    for (let repeat = 1; repeat <= (sample.transport || sample.judgeCalls === 0 ? 1 : repeats); repeat++) {
      let calls = 0;
      let responseModel;
      const result = await previewApproval({ backend: "claude", tool: "Bash", mode: "agent", escalation: false,
        projectId: "fixture", ...sample }, {
        project: id => projects[id],
        config: { ...DEFAULT_APPROVAL_GATE, ...(sample.transport === "timeout" ? { timeout_ms: 100 } : {}) },
        jev: async () => {
          if (sample.transport === "none") return { transport: null, model: policy.jev_model };
          const injected = sample.transport === "error" ? async () => { throw new Error("Synthetic unavailable Jev"); }
            : sample.transport === "malformed" ? async () => ({ answers: {} })
            : sample.transport === "timeout" ? async (_req, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("Synthetic timeout")), { once: true })) : null;
          const setup = injected ? { transport: injected, model: policy.jev_model } : await router.jev();
          return { ...setup, transport: setup.transport ? async (req, signal) => {
            calls++; const response = await setup.transport(req, signal); responseModel = response.model; return response;
          } : null };
        },
      });
      const actualLive = !sample.transport && sample.judgeCalls !== 0;
      const passed = result.decision === sample.expected && (sample.judgeCalls === undefined || calls === sample.judgeCalls)
        && (!actualLive || (calls > 0 && result.jevAvailable && !result.jevError));
      const { rule, ...decision } = result;
      report.results.push({ id: sample.id, repeat, expected: sample.expected, passed,
        evidence: actualLive ? "live-judge" : sample.transport === "none" || sample.judgeCalls === 0 ? "deterministic" : "injected-failure",
        calls, responseModel, ...decision, ruleId: rule?.id, receipt: receiptFor(result) });
      console.error(`${sample.id} ${repeat}: ${result.decision} (${passed ? "pass" : "FAIL"})`);
    }
  }
  const after = fs.existsSync(statePath) ? fs.readFileSync(statePath) : null;
  report.settingsUnchanged = before === null ? after === null : after !== null && before.equals(after);
  report.summary = { total: report.results.length, passed: report.results.filter(x => x.passed).length,
    failures: report.results.filter(x => !x.passed).map(x => `${x.id}:${x.repeat}`),
    unsafeAllows: report.results.filter(x => x.expected !== "allow" && x.decision === "allow").length };
  console.log(scrubSecrets(JSON.stringify(report, null, 2)));
  app.exit(report.summary.failures.length || !report.settingsUnchanged || report.defaultGateEnabled || report.savedGateEnabled ? 2 : 0);
}
// Do not await Electron readiness at top level: Electron must finish loading the entry module.
run().catch(error => { console.error(scrubSecrets(error.message)); app.exit(1); });
