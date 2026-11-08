import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appDir, seedHome, tid, items, waitForWindowReady } from "./support.js";
import { realCodexConfig } from "../dist/test/local-global-config-guard.js";
import { MODEL, DIGEST, CONTEXT, SENTINEL, EDITED, WRITE, CHECK_COMMAND, CHECK_SOURCE, DELAY_SOURCE, DELAY_MS, GRACE_MS, ALLOWED, SCENARIOS, commandFor } from "./fixtures/local-native-spec.mjs";

// The default PR suite skips this file before any server or CLI starts. All inference stays in
// the existing production LocalExecution/Codex path; the disposable bootstrap only admits it.
test.skip(process.env.MODEX_LM_NATIVE_E2E !== "1", "real local-model lifecycle is explicitly opt-in");
test.setTimeout(240_000);
// One owned service and immutable receipt directory per qualification run; preserve the first failure.
test.describe.configure({ mode: "serial" });

const report = process.env.MODEX_LM_NATIVE_REPORT ?? "";
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const jsonLines = (file: string): any[] => fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
type Opened = { app: ElectronApplication; page: Page };
type Service = { child: ChildProcess; port: number; url: string; home: string; generation: number };
let service: Service;
let generation = 0;
let personalConfig: ReturnType<typeof realCodexConfig>;
const results: Record<string, unknown>[] = [];
const runtimeEnv = () => Object.fromEntries(["PATH", "LANG", "TMPDIR", "USER", "LOGNAME"].filter(key => process.env[key]).map(key => [key, process.env[key]!])) as NodeJS.ProcessEnv;
const listing = async (s: Service) => {
  const response = await fetch(s.url + "/api/tags", { redirect: "error", signal: AbortSignal.timeout(1500) });
  const models = (await response.json()).models;
  const model = models.find((m: any) => m.name === MODEL);
  expect(model?.digest, "owned service must list the exact approved digest").toBe(DIGEST);
  return model;
};

async function startService(port?: number): Promise<Service> {
  if (!port) {
    const reserved = net.createServer(); reserved.listen(0, "127.0.0.1"); await once(reserved, "listening");
    port = (reserved.address() as net.AddressInfo).port; await new Promise<void>(resolve => reserved.close(() => resolve()));
  }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-native-ollama-"));
  const n = ++generation, log = fs.openSync(path.join(report, `ollama-${n}.log`), "wx", 0o600);
  const child = spawn("ollama", ["serve"], { env: { ...runtimeEnv(), HOME: home, NO_PROXY: "*", OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: path.join(os.homedir(), ".ollama/models"), OLLAMA_CONTEXT_LENGTH: String(CONTEXT), OLLAMA_NO_CLOUD: "true", OLLAMA_NOPRUNE: "true" }, stdio: ["ignore", log, log] });
  fs.closeSync(log);
  const s = { child, port, url: `http://127.0.0.1:${port}`, home, generation: n };
  try {
    const until = Date.now() + 20000;
    while (true) {
      if (child.exitCode !== null || child.signalCode) throw new Error("Owned Ollama exited before metadata readiness");
      try { await listing(s); return s; }
      catch (error) { if (Date.now() >= until) throw error; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
  } catch (error) { await stopService(s); throw error; }
}

async function stopService(s: Service) {
  if (s.child.exitCode === null && !s.child.signalCode) {
    const closed = once(s.child, "close"); s.child.kill("SIGTERM");
    const force = setTimeout(() => s.child.kill("SIGKILL"), 5000); await closed; clearTimeout(force);
  }
  fs.rmSync(s.home, { recursive: true, force: true });
}

test.beforeAll(async () => {
  expect(process.platform).toBe("darwin");
  expect(path.isAbsolute(report), "choose a new absolute report directory outside the worktree").toBe(true);
  const relative = path.relative(appDir, report); expect(relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)).toBe(true);
  fs.mkdirSync(report, { recursive: true, mode: 0o700 });
  expect(fs.existsSync(path.join(report, "lifecycle.json")), "never overwrite a prior run").toBe(false);
  personalConfig = realCodexConfig();
  const git = (args: string[]) => execFileSync("git", args, { cwd: appDir, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(report, "protocol.json"), JSON.stringify({ source: { head: git(["rev-parse", "HEAD"]), indexTree: git(["write-tree"]), status: git(["status", "--porcelain=v1"]), patchSha256: createHash("sha256").update(git(["diff", "HEAD", "--"])).digest("hex") }, model: MODEL, digest: DIGEST, contextTokens: CONTEXT,
    host: { cpu: os.cpus()[0]?.model, architecture: os.arch(), release: os.release(), memoryBytes: os.totalmem() }, versions: { codex: execFileSync("codex", ["--version"], { encoding: "utf8" }).trim(), ollama: execFileSync("ollama", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(), node: process.version },
    allowedCommands: ALLOWED, delayMs: DELAY_MS, observationGraceMs: GRACE_MS, scenarios: SCENARIOS, kind: "real Electron/main/Codex/Ollama; ordinary native sandbox; not offline/human acceptance" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  service = await startService();
  const model = await listing(service);
  const metadata = await (await fetch(service.url + "/api/show", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: MODEL }), redirect: "error" })).json();
  fs.writeFileSync(path.join(report, "runtime.json"), JSON.stringify({ pid: service.child.pid, origin: service.url, model, details: metadata.details, capabilities: metadata.capabilities, modelInfo: metadata.model_info, templateSha256: createHash("sha256").update(metadata.template ?? "").digest("hex"), parameters: metadata.parameters }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
});

test.afterAll(async () => {
  if (service) await stopService(service);
  if (personalConfig) {
    const configuration = personalConfig();
    fs.writeFileSync(path.join(report, "lifecycle.json"), JSON.stringify({ cases: results, realConfiguration: configuration, serviceStopped: service ? service.child.exitCode !== null || Boolean(service.child.signalCode) : true, humanAcceptance: "unrun", offline: "not claimed by this Electron run" }, null, 2) + "\n", { mode: 0o600 });
    expect(configuration.unchanged, "personal Codex configuration must remain unchanged").toBe(true);
  }
});

function seed() {
  const seeded = seedHome();
  fs.writeFileSync(path.join(seeded.home, "local-native-qualification.json"), JSON.stringify({ version: 1, authorization: "local-native-lifecycle", model: MODEL, digest: DIGEST, contextTokens: CONTEXT, cwd: seeded.repo, origin: service.url }) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(seeded.repo, "fixture.txt"), SENTINEL + "\n");
  fs.writeFileSync(path.join(seeded.repo, "result.txt"), "before approval\n");
  fs.writeFileSync(path.join(seeded.repo, "check.cjs"), CHECK_SOURCE);
  fs.writeFileSync(path.join(seeded.repo, "delayed-write.cjs"), DELAY_SOURCE);
  fs.appendFileSync(path.join(report, "seeds.jsonl"), JSON.stringify(seeded) + "\n", { mode: 0o600 });
  return { ...seeded, checkHash: sha256(path.join(seeded.repo, "check.cjs")), delayHash: sha256(path.join(seeded.repo, "delayed-write.cjs")) };
}

async function launchNative(home: string): Promise<Opened> {
  const app = await electron.launch({ args: [path.join(appDir, "e2e/fixtures/local-model-workflow.mjs")], cwd: appDir,
    env: { ...runtimeEnv(), HOME: os.homedir(), MODEX_HOME: home, MODEX_E2E: "1", MODEX_LM_NATIVE_E2E: "1", MODEX_NO_LOGIN_PATH: "1", ELECTRON_OVERRIDE_DIST_PATH: process.env.ELECTRON_OVERRIDE_DIST_PATH ?? "", TYPESAFE_API_KEY: "", JEV_API_KEY: "" } });
  try {
    const page = await app.firstWindow(); await page.waitForLoadState("domcontentloaded"); await waitForWindowReady(app, page);
    await page.evaluate(() => window.modex!.invoke("models:list", { backend: "codex" }));
    return { app, page };
  } catch (error) { await app.close().catch(() => {}); throw error; }
}
const snapshot = (run: Opened): Promise<any> => run.app.evaluate(() => (globalThis as any).__modexLocalNative?.snapshot());
const state = (run: Opened) => run.page.evaluate(() => window.modex!.invoke("state:get", undefined));
const thread = async (run: Opened) => (await state(run)).threads.find(t => t.localTarget)!;
const transcript = async (run: Opened): Promise<any[]> => { const t = await thread(run); return run.page.evaluate(id => window.modex!.invoke("thread:items", { threadId: id }), t.id); };
async function choose(run: Opened) {
  await tid(run.page, "model-picker").click();
  await tid(run.page, "model-local-option").filter({ hasText: MODEL }).click();
  await tid(run.page, "model-local-context").getByRole("menuitemradio", { name: /65,536/ }).click();
  await expect(tid(run.page, "model-local-badge")).toHaveText("Ollama");
}
async function connect(run: Opened) {
  await tid(run.page, "open-settings").click();
  await run.page.getByRole("button", { name: "Local models", exact: true }).click();
  await tid(run.page, "local-runtime").selectOption("ollama");
  await tid(run.page, "local-label").fill("Ollama native lifecycle");
  await tid(run.page, "local-url").fill(service.url); await tid(run.page, "local-add").click();
  await expect(tid(run.page, "local-connection")).toHaveAttribute("data-state", "ready");
  await run.page.keyboard.press("Escape"); await choose(run);
  await expect(tid(run.page, "local-inference-host")).toContainText(service.url);
}
async function send(run: Opened, prompt: string) {
  await tid(run.page, "composer-input").fill(prompt); await tid(run.page, "send").click();
  await expect.poll(async () => (await transcript(run)).some(item => item.kind === "user" && item.text === prompt)).toBe(true);
}
async function approve(run: Opened, expectedCommand: string) {
  await expect.poll(async () => Boolean((await snapshot(run))?.pending.length) || ["idle", "error"].includes((await thread(run)).status), { timeout: 90000, intervals: [100, 200, 500] }).toBe(true);
  const pending = (await snapshot(run)).pending;
  expect(pending).toHaveLength(1); expect(pending[0].allowed).toBe(true); expect(pending[0].command).toBe(expectedCommand);
  await items(run.page, "approval").getByRole("button", { name: "Approve", exact: true }).click();
}
async function idle(run: Opened) {
  await expect.poll(async () => (await thread(run)).status, { timeout: 90000 }).toMatch(/^(idle|error)$/);
  await expect(tid(run.page, "stop")).toHaveCount(0, { timeout: 90000 });
}
const commandPrompt = (command: string) => `The current disposable repository is already prepared. The fixture scripts exist and require no inspection. Invoke exec_command to execute exactly this shell command once:\n\n\`\`\`sh\n${command}\n\`\`\`\n\nThe client handles native command approval. Do not ask a question or use request_user_input. Do not print tool-call syntax as text. Do not run other commands, including ls, cat, pwd or preliminary checks. Do not use apply_patch, edit scripts, retry or change the command.`;
const dispatches = (repo: string, id: string) => jsonLines(path.join(repo, "lifecycle-runs.jsonl")).filter(row => row.id === id);
const effects = (repo: string, id: string) => jsonLines(path.join(repo, "lifecycle-effects.jsonl")).filter(row => row.id === id);
async function marker(repo: string, id: string) {
  const file = path.join(repo, id + "-started.json");
  await expect.poll(() => fs.existsSync(file), { timeout: 90000, intervals: [50, 100, 200] }).toBe(true);
  const started = JSON.parse(fs.readFileSync(file, "utf8"));
  expect(Date.now(), "fault injection must happen before the command's deadline").toBeLessThan(started.deadline - 2000);
  expect(dispatches(repo, id)).toHaveLength(1); return started;
}
async function pastDeadline(started: any) { const remaining = started.deadline + GRACE_MS - Date.now(); if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining)); }
function scriptsIntact(seeded: ReturnType<typeof seed>) { expect(sha256(path.join(seeded.repo, "check.cjs"))).toBe(seeded.checkHash); expect(sha256(path.join(seeded.repo, "delayed-write.cjs"))).toBe(seeded.delayHash); expect(fs.readFileSync(path.join(seeded.repo, "fixture.txt"), "utf8")).toBe(SENTINEL + "\n"); }
async function save(name: string, run: Opened | undefined, extra: Record<string, unknown>) {
  const native = run ? await snapshot(run).catch(() => undefined) : undefined;
  if (native) expect(native.cloudCalls).toBe(0);
  const view = run ? { state: await state(run).catch(() => undefined), transcript: await transcript(run).catch(() => undefined) } : undefined;
  const loaded = service?.child.exitCode === null && !service.child.signalCode ? await fetch(service.url + "/api/ps", { redirect: "error", signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => undefined) : undefined;
  const value = { name, ...extra, native, view, loaded, at: new Date().toISOString() }; results.push(value);
  fs.writeFileSync(path.join(report, name + ".json"), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

test("native Electron golden: real read, exact approved edit, independent check and rendered diff", async () => {
  const seeded = seed(); let run: Opened | undefined; let completed = false;
  try {
    run = await launchNative(seeded.home); await connect(run);
    await send(run, "Run `cat fixture.txt` in the current directory and reply with exactly the word it contains.");
    await approve(run, "cat fixture.txt"); await idle(run);
    const read = await transcript(run);
    expect(read.some(item => item.kind === "tool" && item.outcome === "succeeded" && /cat fixture.txt/.test(item.exec?.command ?? item.title ?? ""))).toBe(true);
    expect(read.some(item => item.kind === "assistant" && item.text?.includes(SENTINEL))).toBe(true);
    await send(run, commandPrompt(WRITE));
    await expect.poll(async () => (await snapshot(run)).pending.some((p: any) => p.command === WRITE), { timeout: 90000 }).toBe(true);
    expect(fs.readFileSync(path.join(seeded.repo, "result.txt"), "utf8")).toBe("before approval\n");
    await approve(run, WRITE); await idle(run);
    expect(fs.readFileSync(path.join(seeded.repo, "result.txt"), "utf8")).toBe(EDITED);
    await send(run, commandPrompt(CHECK_COMMAND)); await approve(run, CHECK_COMMAND); await idle(run);
    expect(jsonLines(path.join(seeded.repo, "checks.jsonl"))).toEqual([{ ok: true, exitCode: 0 }]);
    const final = await transcript(run), checked = final.filter(item => item.kind === "tool" && /node check.cjs/.test(item.exec?.command ?? item.title ?? ""));
    expect(checked).toHaveLength(1); expect(checked[0].outcome).toBe("succeeded"); expect(checked[0].exitCode).toBe(0);
    const t = await thread(run);
    const diff = await run.page.evaluate(id => window.modex!.invoke("changes:diff", { threadId: id, path: "result.txt" }), t.id);
    expect(JSON.stringify(diff)).toContain("LM3-APPROVED-EDIT-8c42");
    await run.page.keyboard.press("Control+Shift+G");
    await tid(run.page, "changes-file").filter({ hasText: "result.txt" }).getByRole("button").first().click();
    await expect(tid(run.page, "changes-diff")).toContainText("LM3-APPROVED-EDIT-8c42");
    await run.page.screenshot({ path: path.join(report, "golden.png"), fullPage: true });
    scriptsIntact(seeded); await listing(service); completed = true;
  } finally { try { await save("golden", run, { completed, repo: seeded.repo, modelDigest: DIGEST }); } finally { await run?.app.close().catch(() => {}); } }
});

async function recover(run: Opened, seeded: ReturnType<typeof seed>, original: string, before: any, fresh: string) {
  const old = await thread(run), identity = structuredClone(old.localTarget), history = await transcript(run);
  await run.app.close(); Object.assign(run, await launchNative(seeded.home));
  await expect.poll(async () => Boolean(await snapshot(run))).toBe(true);
  expect((await thread(run)).id).toBe(old.id); expect((await thread(run)).localTarget).toEqual(identity);
  expect((await transcript(run)).map(item => item.id)).toEqual(history.map(item => item.id));
  expect((await snapshot(run)).children).toHaveLength(0);
  await send(run, "An old native handle must refuse after restart."); await idle(run);
  await expect(run.page.getByRole("alert").filter({ hasText: /native session.*gone|another Codex process/ })).toBeVisible();
  expect((await snapshot(run)).children).toHaveLength(0); expect(dispatches(seeded.repo, original)).toHaveLength(1);
  expect(effects(seeded.repo, original)).toHaveLength(before.effectCount);
  await choose(run); await send(run, commandPrompt(commandFor(fresh))); await approve(run, commandFor(fresh)); await idle(run);
  expect(dispatches(seeded.repo, fresh)).toHaveLength(1); expect(effects(seeded.repo, fresh)).toHaveLength(1);
  expect(fs.readFileSync(path.join(seeded.repo, fresh + "-effect.txt"), "utf8")).toBe(fresh + ":one\n");
  expect(dispatches(seeded.repo, original)).toHaveLength(1); expect(effects(seeded.repo, original)).toHaveLength(before.effectCount);
  scriptsIntact(seeded); return run;
}

test("native Electron Stop: started command has no late effect, restart never replays, explicit fresh send runs once", async () => {
  const seeded = seed(); let run: Opened | undefined; let completed = false; let before: any;
  try {
    run = await launchNative(seeded.home); await connect(run); await send(run, commandPrompt(commandFor("stop"))); await approve(run, commandFor("stop"));
    const started = await marker(seeded.repo, "stop"), clickedAt = Date.now(); await tid(run.page, "stop").click(); await idle(run); await pastDeadline(started);
    expect(effects(seeded.repo, "stop")).toHaveLength(0); expect(fs.existsSync(path.join(seeded.repo, "stop-effect.txt"))).toBe(false);
    const list = await transcript(run);
    expect(list.some(item => item.kind === "tool" && /delayed-write.cjs stop/.test(item.exec?.command ?? item.title ?? "") && item.outcome === "interrupted")).toBe(true);
    before = { started, clickedAt, effectCount: 0, native: await snapshot(run), transcript: list };
    run = await recover(run, seeded, "stop", before, "after-stop"); await listing(service); completed = true;
  } finally { try { await save("stop", run, { completed, before, dispatches: dispatches(seeded.repo, "stop"), effects: effects(seeded.repo, "stop") }); } finally { await run?.app.close().catch(() => {}); } }
});

test("native Electron Codex loss: truthful outcome, no duplicate effect or stale-handle replay", async () => {
  const seeded = seed(); let run: Opened | undefined; let completed = false; let before: any;
  try {
    run = await launchNative(seeded.home); await connect(run); await send(run, commandPrompt(commandFor("codex-loss"))); await approve(run, commandFor("codex-loss"));
    const started = await marker(seeded.repo, "codex-loss"), owned = (await snapshot(run)).children.filter((p: any) => p.running);
    expect(owned).toHaveLength(1); const injectedAt = Date.now();
    expect(await run.app.evaluate((_, pid) => (globalThis as any).__modexLocalNative.killCodex(pid), owned[0].pid)).toBe(true);
    await idle(run); await pastDeadline(started);
    const effectCount = effects(seeded.repo, "codex-loss").length; expect(effectCount).toBeLessThanOrEqual(1); expect(dispatches(seeded.repo, "codex-loss")).toHaveLength(1);
    const list = await transcript(run); expect((await thread(run)).status).toBe("error");
    expect(list.some(item => item.kind === "notice" && item.failure)).toBe(true);
    expect(list.some(item => item.kind === "tool" && /delayed-write.cjs codex-loss/.test(item.exec?.command ?? item.title ?? "") && item.outcome === "unknown")).toBe(true);
    before = { started, injectedAt, killedPid: owned[0].pid, effectCount, native: await snapshot(run), transcript: list };
    run = await recover(run, seeded, "codex-loss", before, "after-codex-loss"); await listing(service); completed = true;
  } finally { try { await save("codex-loss", run, { completed, before, dispatches: dispatches(seeded.repo, "codex-loss"), effects: effects(seeded.repo, "codex-loss") }); } finally { await run?.app.close().catch(() => {}); } }
});

test("native Electron inference loss: owned server failure, restart and explicit recovery preserve action counts", async () => {
  const seeded = seed(); let run: Opened | undefined; let completed = false; let before: any;
  try {
    run = await launchNative(seeded.home); await connect(run); await send(run, commandPrompt(commandFor("server-loss"))); await approve(run, commandFor("server-loss"));
    const started = await marker(seeded.repo, "server-loss"), killedPid = service.child.pid, port = service.port, injectedAt = Date.now();
    await stopService(service); await idle(run); await pastDeadline(started);
    const effectCount = effects(seeded.repo, "server-loss").length; expect(effectCount).toBeLessThanOrEqual(1); expect(dispatches(seeded.repo, "server-loss")).toHaveLength(1);
    const list = await transcript(run); expect((await thread(run)).status).toBe("error"); expect(list.some(item => item.kind === "notice" && item.failure)).toBe(true);
    const native = await snapshot(run);
    expect(native.events.filter((e: any) => e.type === "rpc" && e.direction === "out" && e.method === "turn/start")).toHaveLength(1);
    expect(native.events.filter((e: any) => e.type === "rpc" && e.direction === "in" && e.method === "error" && e.willRetry === true)).toHaveLength(1);
    expect(native.events.filter((e: any) => e.type === "rpc" && e.direction === "out" && e.method === "turn/interrupt")).toHaveLength(1);
    before = { started, injectedAt, killedPid, effectCount, native, transcript: list };
    service = await startService(port);
    run = await recover(run, seeded, "server-loss", before, "after-server-loss"); await listing(service); completed = true;
  } finally { try { await save("server-loss", run, { completed, before, dispatches: dispatches(seeded.repo, "server-loss"), effects: effects(seeded.repo, "server-loss") }); } finally { await run?.app.close().catch(() => {}); } }
});
