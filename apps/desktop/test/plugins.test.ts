import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile, readdir, realpath, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PluginService, createNativePluginExecution, type PluginExecution, type PluginTarget } from "../src/main/engine/plugins.js";
import type { PluginContext } from "../src/shared/plugins.js";
const claude: PluginContext = { runtime: "claude", account: "cli", scope: "user" };
const codex: PluginContext = { runtime: "codex", account: "cli", scope: "user" };
function fixture(options: { data?: unknown; busy?: boolean; failure?: string; cacheFile?: string; resolveFailure?: boolean; result?: string; localRoot?: string } = {}) {
  const calls: Array<{ target: PluginTarget; argv: string[]; stdin?: string }> = [];
  const state = { offline: false, data: options.data ?? [{ id: "draw@studio", enabled: true, scope: "user" }] };
  const execute: PluginExecution = async (target, argv, stdin) => {
    calls.push({ target, argv, stdin });
    if (state.offline) throw new Error("offline");
    if (argv.at(-1) === "--help") {
      if (argv.length === 2) return target.bin === "codex" ? "Commands:\n  add   Install\n  list List\n  marketplace Manage\n  remove Remove" : "Commands:\n  configure Options\n  details Details\n  disable Disable\n  enable Enable\n  install|i Install\n  list List\n  marketplace Manage\n  uninstall|remove Remove\n  update Update";
      if (argv[1] === "marketplace" && argv.length === 3) return "Commands:\n  add Add\n  list List\n  remove Remove\n  " + (target.bin === "codex" ? "upgrade Upgrade" : "update Update");
      return "--json --available --scope --values-stdin";
    }
    if (options.failure) throw new Error(options.failure);
    if (argv[1] === "list") return JSON.stringify(state.data);
    if (argv[1] === "details") return "Plugin details";
    if (argv[1] === "marketplace" && argv[2] === "list") return '{"marketplaces":[{"name":"studio","source":"https://example.com/studio"}]}';
    return options.result ?? '{"success":true}';
  };
  const service = new PluginService({ resolve(context) { if (options.resolveFailure) throw new Error("CLI missing"); return { bin: context.runtime, cwd: context.projectId ? `/projects/${context.projectId}` : "/home", env: { ACCOUNT: context.account ?? "cli", CODEX_HOME: "/test/codex" } }; }, busy: () => !!options.busy, execute, cacheFile: options.cacheFile, localRoot: options.localRoot });
  return { service, calls, state };
}
test("native inventory preserves scope and exposes capability-detected actions", async () => {
  const { service, calls } = fixture({ data: [{ id: "draw@studio", scope: "user", enabled: true }, { id: "project@studio", scope: "project" }] });
  const inventory = await service.list({ context: claude });
  assert.deepEqual(inventory.plugins.map(item => item.id), ["draw@studio"]);
  assert.ok(inventory.capabilities.actions.includes("configure"));
  assert.deepEqual(calls.at(-1)?.argv, ["plugin", "list", "--json"]);
  const project = await service.list({ context: { ...claude, scope: "project", projectId: "p1" } });
  assert.equal(project.plugins[0]?.id, "project@studio");
  assert.equal(calls.at(-1)?.target.cwd, "/projects/p1");
});
test("Codex's actual installed/available shape preserves disabled state and native scopes", async () => {
  const { service } = fixture({ data: { installed: [{ pluginId: "draw@studio", name: "draw", marketplaceName: "studio", enabled: false, installed: true }], available: [{ pluginId: "new@studio", installed: false }] } });
  const inventory = await service.list({ context: codex, available: true });
  assert.equal(inventory.plugins[0]?.enabled, false);
  assert.equal(inventory.plugins[1]?.installed, false);
  assert.deepEqual(inventory.capabilities.actions, ["install", "remove"]);
  await assert.rejects(service.mutate({ context: codex, action: "disable", id: "draw@studio" }), /does not support disable/);
});
test("scope and account validation rejects unsupported targets before executing", async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.list({ context: { ...claude, account: "app-account" } }), /shared CLI installation/);
  await assert.rejects(service.list({ context: { ...claude, scope: "local" } }), /Select a project/);
  await assert.rejects(service.mutate({ context: { ...codex, scope: "project", projectId: "p1" }, action: "install", id: "draw@studio" }), /user plugin scope only/);
  assert.equal(calls.length, 0);
});
test("mutations use literal validated argv and explicit native scope", async () => {
  const { service, calls } = fixture();
  await service.mutate({ context: { ...claude, projectId: "p1", scope: "local" }, action: "enable", id: "draw@studio" });
  assert.deepEqual(calls.at(-1)?.argv, ["plugin", "enable", "draw@studio", "--json", "--scope", "local"]);
  for (const id of ["--all", "draw;rm -rf /", "$(touch /tmp/bad)", "../draw", "draw\n--all"]) await assert.rejects(service.mutate({ context: claude, action: "remove", id }), /Invalid plugin/);
  await service.mutate({ context: codex, action: "install", id: "draw@studio" });
  assert.deepEqual(calls.at(-1)?.argv, ["plugin", "add", "draw@studio", "--json"]);
  assert.ok(calls.every(call => !call.argv.includes("--yes")));
});
test("configuration values are sent through stdin, never argv, and multiline values are rejected", async () => {
  const { service, calls } = fixture();
  await service.mutate({ context: claude, action: "configure", id: "draw@studio", values: { apiKey: "private-value" } });
  assert.deepEqual(calls.at(-1)?.argv, ["plugin", "configure", "draw@studio", "--json", "--values-stdin"]);
  assert.equal(calls.at(-1)?.stdin, '{"apiKey":"private-value"}');
  assert.ok(!calls.some(call => call.argv.some(arg => arg.includes("private-value"))));
  await assert.rejects(service.mutate({ context: claude, action: "configure", id: "draw@studio", values: { key: "one\ntwo" } }), /single-line/);
});
test("active affected turns block mutations before native commands run", async () => {
  const { service, calls } = fixture({ busy: true });
  await assert.rejects(service.mutate({ context: claude, action: "remove", id: "draw@studio" }), /affected native turns/);
  await assert.rejects(service.mutateSource({ context: claude, action: "add", source: "owner/repo" }), /affected native turns/);
  assert.equal(calls.length, 0);
});
test("native failures and malformed inventories remain explicit; last successful inventory remains offline", async () => {
  const { service, state } = fixture();
  const first = await service.list({ context: claude });
  state.data = { garbage: true };
  const invalid = await service.list({ context: claude });
  assert.equal(invalid.stale, true);
  assert.match(invalid.error ?? "", /Unrecognized/);
  assert.deepEqual(invalid.plugins, first.plugins);
  state.offline = true;
  const offline = await service.list({ context: claude });
  assert.equal(offline.error, "offline");
  await assert.rejects(fixture({ data: { bad: [] } }).service.list({ context: claude }), /Unrecognized/);
  await assert.rejects(fixture({ failure: "native failed" }).service.mutate({ context: claude, action: "remove", id: "draw@studio" }), /native failed/);
});
test("durable cached inventory survives restart with a missing native CLI", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modex-plugins-"));
  try {
    const cacheFile = path.join(dir, "cache.json");
    await fixture({ cacheFile }).service.list({ context: claude });
    const offline = await fixture({ cacheFile, resolveFailure: true }).service.list({ context: claude });
    assert.equal(offline.stale, true);
    assert.equal(offline.plugins[0]?.id, "draw@studio");
    assert.equal(offline.error, "CLI missing");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("marketplace management targets native scopes and rejects arbitrary local paths or credentials", async () => {
  const { service, calls, state } = fixture();
  const sources = await service.sources({ context: claude });
  assert.equal(sources.sources[0]?.name, "studio");
  await service.mutateSource({ context: { ...claude, projectId: "p1", scope: "project" }, action: "add", source: "owner/repo" });
  assert.deepEqual(calls.at(-1)?.argv, ["plugin", "marketplace", "add", "owner/repo", "--json", "--scope", "project"]);
  await service.mutateSource({ context: codex, action: "update", source: "studio" });
  assert.deepEqual(calls.at(-1)?.argv, ["plugin", "marketplace", "upgrade", "studio", "--json"]);
  for (const source of ["/tmp/plugin", "--all", "https://user:password@example.com/repo", "owner/repo\n--scope=project"]) await assert.rejects(service.mutateSource({ context: claude, action: "add", source }));
  state.offline = true;
  assert.equal((await service.sources({ context: claude })).stale, true);
});
test("detail reads complete native skill files and rejects symlink escapes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modex-plugin-skills-"));
  try {
    const root = path.join(dir, "plugin");
    await mkdir(path.join(root, "skills", "draw"), { recursive: true });
    const fullText = "# Draw\n" + "Complete instructions.\n".repeat(1500);
    await writeFile(path.join(root, "skills", "draw", "SKILL.md"), fullText);
    await mkdir(path.join(root, "skills", "escape"), { recursive: true });
    await writeFile(path.join(dir, "outside.md"), "should not be exposed");
    await symlink(path.join(dir, "outside.md"), path.join(root, "skills", "escape", "SKILL.md"));
    const { service } = fixture({ data: { installed: [{ pluginId: "draw@studio", name: "draw", installed: true, source: { source: "local", path: root } }] } });
    await service.list({ context: codex });
    const detail = await service.details({ context: codex, id: "draw@studio" });
    assert.equal(detail.skills.length, 1);
    assert.equal(detail.skills[0]?.text, fullText);
    assert.equal(detail.skills[0]?.entrypoint, "draw:draw");
    assert.ok(detail.notes.some(note => note.includes("escapes")));
    await assert.rejects(service.details({ context: codex, id: "unknown@studio" }), /Refresh the plugin inventory/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("native command success requires a recognized structured result", async () => {
  await assert.rejects(fixture({ result: '{"success":false,"error":"installation refused"}' }).service.mutate({ context: claude, action: "install", id: "draw@studio" }), /installation refused/);
  await assert.rejects(fixture({ result: 'unexpected native output' }).service.mutate({ context: claude, action: "install", id: "draw@studio" }), /unrecognized result/);
  await assert.rejects(fixture({ result: '{"shownCommand":{"sha256":"123"}}' }).service.mutate({ context: claude, action: "install", id: "draw@studio" }), /requires command approval/);
  const result = await fixture({ result: 'Refreshing source...\n{"success":true}' }).service.mutateSource({ context: claude, action: "add", source: "owner/repo" });
  assert.equal(result.restartRequired, true);
});
test("busy state is checked again immediately before a mutating process starts", async () => {
  let busy = false;
  const calls: string[][] = [];
  const service = new PluginService({ resolve: () => ({ bin: "codex", cwd: "/", env: {} }), busy: () => busy, execute: async (_target, argv) => {
    calls.push(argv);
    if (argv.length === 2) return "Commands:\n  add Install\n  list List";
    if (argv[1] === "list") return "--json --available";
    busy = true;
    return "--json";
  } });
  await assert.rejects(service.mutate({ context: codex, action: "install", id: "draw@studio" }), /affected native turns/);
  assert.ok(calls.every(argv => argv.at(-1) === "--help"));
});

async function writeImportManifest(root: string, filename: string, contents: unknown) {
  await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
  await writeFile(path.join(root, filename), JSON.stringify(contents));
}
test("local imports register both documented marketplace formats using picker paths and native scopes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modex-local-marketplaces-"));
  try {
    const claudeRoot = path.join(dir, "Claude marketplace with spaces");
    await writeImportManifest(claudeRoot, ".claude-plugin/marketplace.json", { name: "my-claude", owner: { name: "Val" }, plugins: [] });
    const codexRoot = path.join(dir, "Codex marketplace");
    await writeImportManifest(codexRoot, ".agents/plugins/marketplace.json", { name: "my-codex", plugins: [] });
    const { service, calls } = fixture();
    const projectContext: PluginContext = { ...claude, projectId: "p1", scope: "project" };
    const result = await service.importLocal({ context: projectContext, source: claudeRoot });
    assert.match(result.message, /my-claude.*claude \/ project/);
    assert.deepEqual(calls.at(-1)?.argv, ["plugin", "marketplace", "add", await realpath(claudeRoot), "--json", "--scope", "project"]);
    await service.importLocal({ context: codex, source: codexRoot });
    assert.deepEqual(calls.at(-1)?.argv, ["plugin", "marketplace", "add", await realpath(codexRoot), "--json"]);
    await service.importLocal({ context: codex, source: claudeRoot });
    assert.deepEqual(calls.at(-1)?.argv, ["plugin", "marketplace", "add", await realpath(claudeRoot), "--json"]);
    await assert.rejects(service.importLocal({ context: claude, source: codexRoot }), /compatible claude/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
for (const runtime of ["claude", "codex"] as const) test(`${runtime} single-package import snapshots files in its documented marketplace format without installing`, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modex-local-package-"));
  try {
    const source = path.join(dir, "source"), localRoot = path.join(dir, "managed");
    const manifestPath = runtime === "claude" ? ".claude-plugin/plugin.json" : ".codex-plugin/plugin.json";
    await writeImportManifest(source, manifestPath, { name: "drawing", version: "1.0.0" });
    await mkdir(path.join(source, "skills", "draw"), { recursive: true });
    await writeFile(path.join(source, "skills", "draw", "SKILL.md"), "# Complete drawing instructions\n");
    await writeImportManifest(source, "package.json", { scripts: { postinstall: "do-not-execute" } });
    const { service, calls } = fixture({ localRoot });
    await service.importLocal({ context: { runtime, scope: "user" }, source });
    const wrappers = await readdir(localRoot);
    assert.equal(wrappers.length, 1);
    const wrapper = path.join(localRoot, wrappers[0]!);
    const catalogPath = runtime === "claude" ? ".claude-plugin/marketplace.json" : ".agents/plugins/marketplace.json";
    const catalog = JSON.parse(await readFile(path.join(wrapper, catalogPath), "utf8"));
    assert.equal(catalog.name, wrappers[0]);
    assert.deepEqual(catalog.plugins[0].source, runtime === "claude" ? "./plugins/drawing" : { source: "local", path: "./plugins/drawing" });
    if (runtime === "claude") assert.equal(catalog.owner.name, "Modex local imports");
    else assert.deepEqual(catalog.plugins[0].policy, { installation: "AVAILABLE", authentication: "ON_INSTALL" });
    assert.equal(await readFile(path.join(wrapper, "plugins/drawing/skills/draw/SKILL.md"), "utf8"), "# Complete drawing instructions\n");
    await writeFile(path.join(source, "skills/draw/SKILL.md"), "edited original");
    assert.equal(await readFile(path.join(wrapper, "plugins/drawing/skills/draw/SKILL.md"), "utf8"), "# Complete drawing instructions\n");
    assert.equal(JSON.parse(await readFile(path.join(source, manifestPath), "utf8")).name, "drawing");
    assert.ok(calls.every(call => call.argv.at(-1) === "--help" || call.argv[1] === "marketplace" && call.argv[2] === "add"));
    assert.equal(calls.at(-1)?.argv[3], await realpath(wrapper));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("portable Codex package imports use the documented root plugin.json schema", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modex-portable-plugin-"));
  try {
    const source = path.join(dir, "portable"), localRoot = path.join(dir, "managed");
    await writeImportManifest(source, "plugin.json", { $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "portable" });
    await fixture({ localRoot }).service.importLocal({ context: codex, source });
    assert.equal((await readdir(localRoot)).length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("local import rejects symlinked roots, manifests and nested payloads before native mutation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modex-local-symlinks-"));
  try {
    const source = path.join(dir, "source"), localRoot = path.join(dir, "managed");
    await writeImportManifest(source, ".claude-plugin/plugin.json", { name: "drawing" });
    const { service, calls } = fixture({ localRoot });
    const linkedRoot = path.join(dir, "linked");
    await symlink(source, linkedRoot);
    await assert.rejects(service.importLocal({ context: claude, source: linkedRoot + path.sep }), /symlink/);
    await symlink(path.join(source, ".claude-plugin/plugin.json"), path.join(source, "linked.json"));
    await assert.rejects(service.importLocal({ context: claude, source }), /symlink/);
    await rm(path.join(source, "linked.json"));
    const pluginManifest = path.join(source, ".claude-plugin/plugin.json");
    await rm(pluginManifest);
    await writeFile(path.join(dir, "external-manifest.json"), '{"name":"outside"}');
    await symlink(path.join(dir, "external-manifest.json"), pluginManifest);
    await assert.rejects(service.importLocal({ context: claude, source }), /symlink/);
    assert.ok(calls.every(call => call.argv.at(-1) === "--help"));
    await assert.rejects(readdir(localRoot), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("local import validates context and busy state before scanning or copying packages", async () => {
  const { service, calls } = fixture({ busy: true });
  await assert.rejects(service.importLocal({ context: claude, source: "/missing" }), /affected native turns/);
  await assert.rejects(service.importLocal({ context: { ...claude, account: "app-account" }, source: "/missing" }), /shared CLI installation/);
  assert.equal(calls.length, 0);
});

test("oversized local packages and non-plugin folders fail before copying or registering", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modex-import-bounds-"));
  try {
    const source = path.join(dir, "source"), localRoot = path.join(dir, "managed");
    await writeImportManifest(source, "package.json", { name: "not-a-native-plugin" });
    const { service, calls } = fixture({ localRoot });
    await assert.rejects(service.importLocal({ context: claude, source }), /compatible claude/);
    await writeImportManifest(source, ".claude-plugin/plugin.json", { name: "drawing" });
    const large = path.join(source, "large.bin");
    await writeFile(large, "");
    await truncate(large, 128 * 1024 * 1024 + 1);
    await assert.rejects(service.importLocal({ context: claude, source }), /128 MiB/);
    assert.ok(calls.every(call => call.argv.at(-1) === "--help"));
    await assert.rejects(readdir(localRoot), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("native component inventory accepts object and array shapes without treating empty components as present", async () => {
  const { service } = fixture({ data: [
    { id: "array@studio", components: ["skills", "mcp", { type: "hooks" }, null, 1] },
    { id: "object@studio", components: { skills: [], agents: { helper: {} }, commands: ["run"] } },
    { id: "malformed@studio", components: "unexpected", skills: [], hooks: false },
  ] });
  const inventory = await service.list({ context: claude });
  assert.deepEqual(inventory.plugins[0]?.components, ["skills", "mcp", "hooks"]);
  assert.deepEqual(inventory.plugins[1]?.components, ["agents", "commands"]);
  assert.deepEqual(inventory.plugins[2]?.components, []);
});
async function pollFor(check: () => Promise<boolean>, description: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function writeNativeProcessFixture(dir: string): Promise<string> {
  const script = path.join(dir, "native-cli.cjs");
  await writeFile(path.join(dir, "worker.cjs"), `
    const fs = require('node:fs');
    const path = require('node:path');
    const dir = process.argv[2];
    process.on('SIGTERM', () => {});
    fs.writeFileSync(path.join(dir, 'worker.pid'), String(process.pid));
    let ticks = 0;
    setInterval(() => fs.writeFileSync(path.join(dir, 'heartbeat'), String(++ticks)), 10);
  `);
  await writeFile(script, `
    const fs = require('node:fs');
    const path = require('node:path');
    const { spawn } = require('node:child_process');
    const dir = process.argv[2];
    const exitOnTerm = process.argv[3] === 'exit';
    fs.writeFileSync(path.join(dir, 'leader.pid'), String(process.pid));
    process.on('SIGTERM', () => {
      fs.writeFileSync(path.join(dir, 'terminated'), 'yes');
      if (exitOnTerm) process.exit(0);
    });
    spawn(process.execPath, [path.join(dir, 'worker.cjs'), dir], { stdio: exitOnTerm ? 'ignore' : 'inherit' });
    setInterval(() => {}, 1000);
  `);
  return script;
}
for (const leader of ["ignore", "exit"] as const) test(`native timeout retains mutation fence and kills descendants when leader handles TERM with ${leader}`, { skip: process.platform === "win32", timeout: 10_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modex-plugin-timeout-"));
  const script = await writeNativeProcessFixture(dir);
  const receipt = (name: string) => path.join(dir, name);
  t.after(async () => {
    for (const name of ["leader.pid", "worker.pid"]) { try { process.kill(Number(await readFile(receipt(name), "utf8")), "SIGKILL"); } catch {} }
    await rm(dir, { recursive: true, force: true });
  });
  const runNative = createNativePluginExecution({ timeoutMs: 1_500, terminationGraceMs: 250 });
  const service = new PluginService({
    resolve: () => ({ bin: process.execPath, cwd: dir, env: process.env }), busy: () => false,
    execute: (target, argv) => argv.at(-1) === "--help" ? Promise.resolve(argv.length === 2 ? "Commands:\n  remove Remove\n  list List" : "--json --available") : runNative(target, [script, dir, leader]),
  });
  let settled = false;
  const pending = service.mutate({ context: codex, action: "remove", id: "draw@studio" }).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, /timed out/);
  await pollFor(async () => { try { await readFile(receipt("terminated")); return true; } catch { return false; } }, "graceful termination");
  assert.equal(settled, false, "the mutation must stay fenced throughout graceful termination");
  await assert.rejects(service.mutate({ context: codex, action: "remove", id: "other@studio" }), /already running/);
  await rejected;
  assert.equal(settled, true);
  const heartbeat = await readFile(receipt("heartbeat"), "utf8");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await readFile(receipt("heartbeat"), "utf8"), heartbeat, "a descendant must stop writing before the mutation fence releases");
  const leaderPid = Number(await readFile(receipt("leader.pid"), "utf8"));
  assert.throws(() => process.kill(leaderPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH", "close must reap the native process before rejection");
});

for (const leader of ["ignore", "exit"] as const) test(`service disposal retains mutation fence and kills descendants when leader handles TERM with ${leader}`, { skip: process.platform === "win32", timeout: 10_000 }, async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modex-plugin-timeout-"));
  const script = await writeNativeProcessFixture(dir);
  const receipt = (name: string) => path.join(dir, name);
  t.after(async () => {
    for (const name of ["leader.pid", "worker.pid"]) { try { process.kill(Number(await readFile(receipt(name), "utf8")), "SIGKILL"); } catch {} }
    await rm(dir, { recursive: true, force: true });
  });
  const runNative = createNativePluginExecution({ timeoutMs: 60_000, terminationGraceMs: 250 });
  const service = new PluginService({
    resolve: () => ({ bin: process.execPath, cwd: dir, env: process.env }), busy: () => false,
    execute: (target, argv, stdin, signal) => argv.at(-1) === "--help" ? Promise.resolve(argv.length === 2 ? "Commands:\n  remove Remove\n  list List" : "--json --available") : runNative(target, [script, dir, leader], stdin, signal),
  });
  let settled = false;
  const pending = service.mutate({ context: codex, action: "remove", id: "draw@studio" }).finally(() => { settled = true; });
  const rejected = assert.rejects(pending, /disposed/);
  await pollFor(async () => { try { await readFile(receipt("heartbeat")); return true; } catch { return false; } }, "running child");
  let drained = false;
  const disposal = service.dispose().then(() => { drained = true; });
  await pollFor(async () => { try { await readFile(receipt("terminated")); return true; } catch { return false; } }, "graceful termination");
  assert.equal(drained, false);
  assert.equal(settled, false, "the mutation must stay fenced throughout graceful termination");
  await assert.rejects(service.mutate({ context: codex, action: "remove", id: "other@studio" }), /disposed/);
  await rejected;
  await disposal;
  await assert.rejects(service.list({ context: codex }), /disposed/);
  assert.equal(settled, true);
  const heartbeat = await readFile(receipt("heartbeat"), "utf8");
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await readFile(receipt("heartbeat"), "utf8"), heartbeat, "a descendant must stop writing before the mutation fence releases");
  const leaderPid = Number(await readFile(receipt("leader.pid"), "utf8"));
  assert.throws(() => process.kill(leaderPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH", "close must reap the native process before rejection");
});

test("disposal drains admitted local imports and rejects their late native continuation", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "modex-import-disposal-"));
  try {
    await writeImportManifest(dir, ".claude-plugin/marketplace.json", { name: "local", plugins: [] });
    let release!: (value: string) => void;
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const calls: string[][] = [];
    const service = new PluginService({
      resolve: () => ({ bin: "native", cwd: dir, env: {} }), busy: () => false,
      execute: async (_target, argv) => {
        calls.push(argv);
        if (calls.length === 1) { started(); return new Promise<string>(resolve => { release = resolve; }); }
        throw new Error("Unexpected command after disposal");
      },
    });
    const importing = service.importLocal({ context: claude, source: dir });
    const rejection = assert.rejects(importing, /disposed/);
    await entered;
    let drained = false;
    const disposal = service.dispose().then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    release("Commands:\n  marketplace Manage marketplaces\n  list List");
    await rejection;
    await disposal;
    assert.equal(calls.length, 1);
    await assert.rejects(service.importLocal({ context: claude, source: dir }), /disposed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
