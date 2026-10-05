import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { updateSettings } from "../src/main/engine/settings-update.js";
import { Store } from "../src/main/engine/store.js";
import { Router } from "../src/main/engine/routing/router.js";
import { JevError, type JevResponse } from "../src/main/engine/routing/jev.js";
import { DEFAULT_ROUTING } from "../src/shared/types.js";
import { tmpdir } from "./helpers.js";

test("settings IPC update persists transport changes, refreshes setup, and keeps fit history", async () => {
  const home = tmpdir("modex-settings-routing-update-");
  const store = new Store(home);
  let cliChecks: string[] = [];
  const router = new Router({
    home,
    policy: () => store.settings.routing,
    listModels: async () => ({ models: [] }),
    env: { TYPESAFE_API_KEY: "sk-fake-offline-key", MODEX_NO_LOGIN_PATH: "1" },
    keyResolver: { jevConfigPath: path.join(home, "missing-jev-config"), loginShell: async () => null },
    detectCli: async (bin) => {
      cliChecks.push(bin);
      return bin === "jev-old" ? { bin: "/opt/jev-old", version: "1.0" } : null;
    },
  });
  router.fit.recordRoute({ threadId: "thread-1", task: "small_edit", source: "heuristic", backend: "codex", model: "codex-test", effort: "low", fast: false, tier: 0, confidence: 0.8, premium: false });

  // This is the same function invoked by the settings:update IPC handler in main/index.ts.
  let saved = updateSettings(store, router, { routing: { ...DEFAULT_ROUTING, jev_transport: "auto", jev_bin: "jev-old" } });
  assert.equal(saved.routing.jev_transport, "auto");
  assert.deepEqual((await router.status()).transport, { kind: "cli", bin: "/opt/jev-old", version: "1.0" });
  assert.deepEqual(cliChecks, ["jev-old"]);

  saved = updateSettings(store, router, { default_backend: "claude" });
  saved = updateSettings(store, router, { routing: { ...saved.routing, posture: "economy" } });
  saved = updateSettings(store, router, { routing: { ...saved.routing } });
  assert.deepEqual((await router.status()).transport, { kind: "cli", bin: "/opt/jev-old", version: "1.0" });
  assert.deepEqual(cliChecks, ["jev-old"], "general, policy-only, and no-op saves retain the setup cache");

  saved = updateSettings(store, router, { routing: { ...saved.routing, jev_transport: "http" } });
  assert.equal(saved.routing.jev_transport, "http");
  assert.deepEqual((await router.status()).transport, { kind: "http" });
  assert.deepEqual(cliChecks, ["jev-old"], "HTTPS save invalidates CLI setup and skips CLI detection");
  assert.equal((await router.status()).transport.kind, "http", "subsequent status reads reuse the refreshed setup");
  assert.equal((await router.status()).fit.routes, 1, "reset preserves learned routing history");

  updateSettings(store, router, { routing: { ...saved.routing, jev_transport: "cli", jev_bin: "jev-new" } });
  assert.deepEqual((await router.status()).transport, { kind: "none" });
  assert.match((await router.status()).detail!, /jev-new/);
  assert.deepEqual(cliChecks, ["jev-old", "jev-new"], "CLI save resolves the replacement executable");
});

test("failed settings persistence does not invalidate the active router setup", async () => {
  let resets = 0;
  const failingStore = { settings: { routing: DEFAULT_ROUTING }, updateSettings: () => { throw new Error("disk is read-only"); } } as unknown as Store;
  const router = { reset: () => { resets++; } } as unknown as Router;
  assert.throws(() => updateSettings(failingStore, router, { routing: { ...DEFAULT_ROUTING, jev_transport: "http" } }), /disk is read-only/);
  assert.equal(resets, 0);
});

test("routing saves preserve approval rules and persist approval changes transactionally", () => {
  const home = tmpdir("modex-settings-approval-rebase-");
  const store = new Store(home);
  const router = { reset: () => {} };
  updateSettings(store, router, {
    approval_rules: [{ id: "tests", when: " run tests ", decision: "allow", enabled: true }],
    approval_gate: { enabled: true, threshold: 0.9, timeout_ms: 2500 },
    routing: { ...store.settings.routing, jev_transport: "http" },
  });
  updateSettings(store, router, { routing: { ...store.settings.routing, posture: "economy" } });
  const before = store.settings;
  assert.equal(before.approval_rules[0]?.when, "run tests", "approval migrations remain active");
  assert.deepEqual(new Store(home).settings, before);
  const blocker = path.join(home, "app", "state.json.tmp");
  fs.mkdirSync(blocker);
  assert.throws(() => updateSettings(store, router, {
    approval_rules: [], approval_gate: { ...before.approval_gate, enabled: false },
  }));
  assert.deepEqual(store.settings, before, "failed writes cannot publish approval drafts in memory");
  assert.deepEqual(new Store(home).settings, before);
  fs.rmSync(blocker, { recursive: true });
  updateSettings(store, router, { approval_rules: [], approval_gate: { ...before.approval_gate, enabled: false } });
  assert.deepEqual(new Store(home).settings.approval_rules, []);
  assert.equal(new Store(home).settings.approval_gate.enabled, false);
});

test("a real state-file write failure keeps settings and explicit router health unchanged, then permits retry", async () => {
  const home = tmpdir("modex-settings-write-failure-");
  const store = new Store(home);
  store.updateSettings({ default_backend: store.settings.default_backend });
  const router = new Router({
    home,
    policy: () => store.settings.routing,
    listModels: async () => ({ models: [] }),
    transport: async () => ({ answers: { reachable: { type: "noul", noul: 0.9 } } }),
  });
  const original = store.settings;
  const tested = await router.test();
  assert.equal(tested.ok, true);
  assert.equal((await router.status()).transport.kind, "http");
  const file = path.join(home, "app", "state.json");
  const persistedBefore = fs.readFileSync(file, "utf8");
  const blocker = `${file}.tmp`;
  fs.mkdirSync(blocker);

  assert.throws(
    () => updateSettings(store, router, { routing: { ...original.routing, jev_model: "jev-next-model" } }),
    /EISDIR|illegal operation on a directory|is a directory/i,
  );
  assert.equal(store.settings.routing.jev_model, original.routing.jev_model, "failed persistence does not publish the draft in memory");
  assert.equal(fs.readFileSync(file, "utf8"), persistedBefore, "failed persistence leaves the saved file intact");
  let status = await router.status();
  assert.equal(status.model, original.routing.jev_model);
  assert.equal(status.transport.kind, "http");
  assert.equal(status.lastTest?.ok, true, "the still-active setup retains its explicit health result");

  fs.rmSync(blocker, { recursive: true });
  const saved = updateSettings(store, router, { routing: { ...original.routing, jev_model: "jev-next-model" } });
  assert.equal(saved.routing.jev_model, "jev-next-model");
  status = await router.status();
  assert.equal(status.model, "jev-next-model");
  assert.equal(status.transport.kind, "http");
  assert.equal(status.lastTest, undefined, "a successful identity change invalidates old health");
});

test("unrelated saves retain explicit health and fit; a model save clears health and is used by the next test", async () => {
  const home = tmpdir("modex-settings-preserve-health-");
  const store = new Store(home);
  const testedModels: string[] = [];
  const router = new Router({
    home,
    policy: () => store.settings.routing,
    listModels: async () => ({ models: [] }),
    transport: async ({ model }) => {
      testedModels.push(model);
      return { answers: { reachable: { type: "noul", noul: 0.9 } } };
    },
  });
  router.fit.recordRoute({ threadId: "thread-1", task: "small_edit", source: "heuristic", backend: "codex", model: "codex-test", effort: "low", fast: false, tier: 0, confidence: 0.8, premium: false });
  await router.test();

  updateSettings(store, router, { default_backend: "claude" });
  updateSettings(store, router, { routing: { ...store.settings.routing, posture: "economy" } });
  let status = await router.status();
  assert.equal(status.lastTest?.ok, true, "a general or posture save retains relevant test health");
  assert.equal(status.fit.routes, 1, "saves retain fit history");

  updateSettings(store, router, { routing: { ...store.settings.routing, jev_model: "jev-next-model" } });
  status = await router.status();
  assert.equal(status.lastTest, undefined, "a changed test identity invalidates old health");
  assert.equal(status.model, "jev-next-model");
  await router.test();
  assert.deepEqual(testedModels, [DEFAULT_ROUTING.jev_model, "jev-next-model"]);
});

test("a provider failure from before a saved settings change cannot disable the new setup", async () => {
  const home = tmpdir("modex-settings-stale-provider-");
  const store = new Store(home);
  let rejectOld!: (error: Error) => void;
  const router = new Router({
    home,
    policy: () => store.settings.routing,
    listModels: async () => ({ models: [] }),
    transport: async () => new Promise<JevResponse>((_resolve, reject) => { rejectOld = reject; }),
  });
  const pending = router.test();
  await new Promise<void>((resolve) => setImmediate(resolve));

  updateSettings(store, router, { routing: { ...store.settings.routing, jev_model: "jev-next-model" } });
  rejectOld(new JevError("stale key failure", "auth", 401));
  const oldResult = await pending;

  assert.equal(oldResult.current, false);
  assert.deepEqual((await router.status()).lastTest, undefined);
  assert.equal((await router.status()).live, true, "the stale auth result cannot disable the post-save setup");
  assert.equal((await router.status()).model, "jev-next-model");
});
