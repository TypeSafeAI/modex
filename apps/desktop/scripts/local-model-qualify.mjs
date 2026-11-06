// Fixed, opt-in qualification from an interactive Terminal. No daemon management,
// model downloads, product admission, arbitrary commands or inference SDKs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { LOOPBACK_ONLY_POLICY } from "./local-model-network-policy.mjs";

const script = fileURLToPath(import.meta.url);
const repository = path.resolve(path.dirname(script), "../../..");

function snapshot(repo) {
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const dirty = git("status", "--porcelain", "--untracked-files=no");
  if (dirty) throw new Error("Commit or preserve tracked source changes before qualification.");
  return { head: git("rev-parse", "HEAD"), tree: git("rev-parse", "HEAD^{tree}") };
}

function electronBinary(repo, dist) {
  if (dist && !path.isAbsolute(dist)) throw new Error("Choose an absolute path to the already installed Electron distribution.");
  // Resolve metadata without importing Electron: its loader can download missing binaries.
  const require = createRequire(path.join(repo, "package.json"));
  const moduleDir = path.dirname(require.resolve("electron"));
  const relative = fs.readFileSync(path.join(moduleDir, "path.txt"), "utf8").trim();
  const binary = path.resolve(dist ?? path.join(moduleDir, "dist"), relative);
  if (!relative || !fs.existsSync(binary)) throw new Error("The selected Electron binary must already be installed.");
  return binary;
}

function ordinaryEnvironment(electronDist) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(MODEX_|CODEX_|CLAUDE_|OPENAI_|ANTHROPIC_|OLLAMA_|ELECTRON_|PLAYWRIGHT_|NODE_OPTIONS$|NODE_V8_COVERAGE$)/.test(key)) delete env[key];
  }
  if (electronDist) env.ELECTRON_OVERRIDE_DIST_PATH = electronDist;
  return env;
}

function validateReceipt(name, report, source, options) {
  const read = relative => JSON.parse(fs.readFileSync(path.join(report, relative), "utf8"));
  if (name === "electron-local") {
    const { stats } = read("electron-local.json");
    if (!stats || stats.expected !== 4 || stats.skipped !== 0 || stats.unexpected !== 0 || stats.flaky !== 0) throw new Error("All four local Electron journeys must execute and pass without retries or skips.");
  }
  if (name === "native-offline") {
    const offline = read("native-offline/offline.json"), workflow = read("native-offline/native/live-workflow.json");
    if (offline.status !== "passed" || offline.sha !== source.head || !["EPERM", "EACCES"].includes(offline.externalProbe) || offline.approvedModelDigest !== options.digest || offline.observedModelDigests?.before !== options.digest || offline.observedModelDigests?.after !== options.digest) throw new Error("The native receipt must prove external denial and the approved owned-server model digest before and after the task on this revision.");
    if (workflow.model !== options.model || workflow.contextTokens !== 65536 || !["read", "approved edit and test"].every(name => workflow.stages?.some(s => s.name === name && s.status === "completed")) || !workflow.approvals?.some(a => a.decision === "yes") || !["bytes", "mtimeMs", "tree"].every(k => workflow.configurationUnchanged?.[k] === true) || workflow.realConfiguration?.unchanged !== true) throw new Error("The native workflow must complete read, approved edit and test while preserving configuration.");
  }
}

async function runCommand(command, args, options) {
  const stdout = fs.openSync(options.stdout, "wx", 0o600), stderr = fs.openSync(options.stderr, "wx", 0o600);
  let child;
  try {
    child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: process.platform !== "win32", stdio: ["ignore", stdout, stderr] });
  } finally { fs.closeSync(stdout); fs.closeSync(stderr); }
  let timedOut = false, spawnError, force;
  const stop = () => {
    if (!child.pid || child.exitCode !== null || child.signalCode) return;
    const kill = signal => { try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); } catch { /* Already exited. */ } };
    kill("SIGTERM"); force = setTimeout(() => kill("SIGKILL"), 5000);
  };
  const timeout = setTimeout(() => { timedOut = true; stop(); }, options.timeout);
  const abort = () => stop(); options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) stop();
  child.once("error", error => { spawnError = error.message; });
  const [exitCode, signal] = await new Promise(resolve => child.once("close", (...args) => resolve(args)));
  clearTimeout(timeout); clearTimeout(force); options.signal?.removeEventListener("abort", abort);
  return { exitCode, signal, timedOut, ...(spawnError ? { error: spawnError } : {}) };
}

async function nativeConfiguration() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-local-preflight-"));
  const codexHome = path.join(home, ".codex"); fs.mkdirSync(codexHome, { mode: 0o700 });
  const env = Object.fromEntries(["PATH", "TMPDIR", "LANG", "USER", "LOGNAME"].filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
  Object.assign(env, { HOME: home, CODEX_HOME: codexHome, NO_PROXY: "*" });
  const child = spawn("codex", ["app-server"], { cwd: home, env, stdio: ["pipe", "pipe", "ignore"] });
  let buffer = "";
  const result = await new Promise(resolve => {
    const responses = {};
    const finish = value => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => finish({ okay: false, error: "Codex configuration preflight timed out." }), 15000);
    child.once("error", error => finish({ okay: false, error: error.message }));
    child.once("exit", () => finish({ okay: false, error: "Codex exited before its configuration was verified." }));
    child.stdout.on("data", bytes => {
      buffer += bytes;
      if (buffer.length > 4 * 1024 * 1024) return finish({ okay: false, error: "Codex preflight output exceeded its bound." });
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish({ okay: false, error: message.error });
          child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
          for (const [id, method, params] of [[2, "config/read", { includeLayers: true }], [3, "configRequirements/read", {}]]) child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        }
        if (message.id === 2 || message.id === 3) {
          responses[message.id] = { okay: !message.error && (message.id === 2 ? !!message.result?.config : !!message.result), ...(message.error ? { error: message.error } : {}) };
          if (responses[2] && responses[3]) finish({ okay: responses[2].okay && responses[3].okay, responses });
        }
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "modex-terminal-qualification", version: "1" }, capabilities: { experimentalApi: true } } }) + "\n");
  });
  if (child.exitCode === null && !child.signalCode) {
    const closed = once(child, "close"); child.stdin.end(); child.kill("SIGTERM");
    const force = setTimeout(() => child.kill("SIGKILL"), 3000);
    await closed; clearTimeout(force);
  }
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

export async function qualify(options, dependencies = {}) {
  if (!options.evidence || !path.isAbsolute(options.evidence)) throw new Error("Choose an absolute evidence directory outside the worktree.");
  const repo = fs.realpathSync(options.repo ?? repository), report = path.resolve(options.evidence);
  let ancestor = path.dirname(report);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const physical = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, report));
  const relative = path.relative(repo, physical);
  if (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)) throw new Error("Choose an absolute evidence directory outside the worktree.");
  if (!options.live || !options.model || !/^[a-f0-9]{64}$/.test(options.digest ?? "")) throw new Error("Pass --live and the exact approved --model and --digest. No model is downloaded.");
  let existing; try { existing = fs.lstatSync(report); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || fs.readdirSync(report).length)) throw new Error("Choose a new empty evidence directory; earlier receipts are preserved.");
  fs.mkdirSync(report, { recursive: true, mode: 0o700 });
  const result = { schema: 1, kind: Object.keys(dependencies).length ? "scripted-runner-test" : "foreground-qualification", status: "running", pid: process.pid, startedAt: new Date().toISOString(), model: options.model, approvedDigest: options.digest, stages: [], productAdmission: "unchanged; separate admission required", humanAcceptance: "unrun" };
  const write = () => fs.writeFileSync(path.join(report, "qualification.json"), JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
  const capture = dependencies.snapshot ?? (() => snapshot(repo));
  const run = dependencies.run ?? runCommand;
  const assertSource = () => { const now = capture(); if (now.head !== result.source.head || now.tree !== result.source.tree) throw new Error("Source changed during qualification; remaining stages were not started."); };
  write();
  try {
    result.source = capture();
    if (options.expectHead && options.expectHead !== result.source.head) throw new Error("This launcher names another source revision. Generate a fresh launcher before qualification.");
    if ((dependencies.platform ?? process.platform) !== "darwin") throw new Error("Native qualification requires macOS.");
    try { (dependencies.session ?? (() => os.userInfo()))(); }
    catch (error) { throw new Error(`macOS user lookup failed: ${error.message}. Launch this runner from your normal macOS Terminal.`); }
    const binary = (dependencies.electron ?? (() => electronBinary(repo, options.electronDist)))();
    const env = ordinaryEnvironment(options.electronDist);
    result.host = { platform: process.platform, release: os.release(), architecture: os.arch(), cpu: os.cpus()[0]?.model, memoryBytes: os.totalmem(), node: process.version, umask: process.umask().toString(8).padStart(3, "0"), requestedContextTokens: 65536, loadedContextTokens: "unverified" };
    result.electron = { binary, sha256: dependencies.binaryHash ?? (await import("node:crypto")).createHash("sha256").update(fs.readFileSync(binary)).digest("hex") };
    const stage = async (name, command, args, cwd, timeout, extraEnv = {}) => {
      assertSource();
      if (options.signal?.aborted) throw new Error("Qualification was interrupted; no further stages were started.");
      const record = { name, command: [command, ...args], startedAt: new Date().toISOString(), stdout: path.join(report, name + ".stdout.log"), stderr: path.join(report, name + ".stderr.log") };
      result.stages.push(record); write();
      console.log(`Running ${name}…`);
      const outcome = await run(command, args, { cwd, env: { ...env, ...extraEnv }, timeout, signal: options.signal, stdout: record.stdout, stderr: record.stderr });
      if (outcome.stdout !== undefined) fs.writeFileSync(record.stdout, outcome.stdout, { mode: 0o600 });
      if (outcome.stderr !== undefined) fs.writeFileSync(record.stderr, outcome.stderr, { mode: 0o600 });
      const { stdout, stderr, ...facts } = outcome;
      Object.assign(record, facts, { finishedAt: new Date().toISOString() });
      record.passed = outcome.exitCode === 0 && !outcome.signal && !outcome.error && !outcome.timedOut;
      if (record.passed) {
        try { validateReceipt(name, report, result.source, options); }
        catch (error) { record.passed = false; record.receiptError = error.message; }
      }
      write(); assertSource(); return record.passed;
    };
    if (!await stage("electron-preflight", binary, ["--version"], repo, 15000)) throw new Error("Electron cannot start in this session. Launch this runner from your normal macOS Terminal.");
    result.nativeConfiguration = await (dependencies.configuration ?? nativeConfiguration)(); write();
    if (!result.nativeConfiguration.okay) throw new Error("Codex cannot read managed configuration in this session. Launch this runner from your normal macOS Terminal.");
    for (const runtime of ["codex", "ollama", "pnpm"]) {
      if (!await stage(runtime + "-version", runtime, ["--version"], repo, 15000)) throw new Error(`The installed ${runtime} version could not be recorded.`);
    }
    if (!await stage("build", "pnpm", ["build"], repo, 900000)) throw new Error("The build failed; dependent acceptance stages were not started.");
    await stage("typecheck", "pnpm", ["typecheck"], repo, 900000);
    await stage("unit", "pnpm", ["test"], repo, 1800000);
    const app = path.join(repo, "apps/desktop");
    await stage("electron-local", "pnpm", ["exec", "playwright", "test", "e2e/local-model-acceptance.spec.ts", "e2e/local-models.spec.ts", "--workers=1", "--max-failures=1", "--output", path.join(report, "electron-local"), "--reporter=list,json"], app, 900000, { PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(report, "electron-local.json") });
    // Retain earlier artifacts before Playwright's canonical command clears its output.
    for (const name of ["desktop", "site"]) {
      const outputs = path.join(repo, "apps", name, "test-results");
      if (fs.existsSync(outputs)) fs.renameSync(outputs, path.join(report, name + "-prior-test-results"));
    }
    await stage("full-e2e", "pnpm", ["test:e2e"], repo, 5400000);
    for (const name of ["desktop", "site"]) {
      const outputs = path.join(repo, "apps", name, "test-results");
      if (fs.existsSync(outputs)) fs.cpSync(outputs, path.join(report, name + "-test-results"), { recursive: true, errorOnExist: true });
    }
    const native = path.join(report, "native-offline"); fs.mkdirSync(native, { mode: 0o700 });
    fs.writeFileSync(path.join(native, "model.json"), JSON.stringify({ name: options.model, digest: options.digest, evidenceKind: "approved expected identity; owned-server observations recorded separately" }, null, 2) + "\n", { mode: 0o600 });
    const policy = path.join(native, "loopback-only.sb"); fs.writeFileSync(policy, LOOPBACK_ONLY_POLICY, { mode: 0o600 });
    await stage("native-offline", "/usr/bin/sandbox-exec", ["-f", policy, process.execPath, path.join(app, "scripts/local-model-offline.mjs"), "--inside", options.model, native], app, 1300000);
    assertSource(); result.status = result.stages.every(s => s.passed) ? "passed" : "failed";
  } catch (error) { result.status = "failed"; result.error = error.message; }
  finally { result.finishedAt = new Date().toISOString(); write(); }
  console.log(`${result.status}: ${path.join(report, "qualification.json")}`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  const usage = "Usage: node scripts/local-model-qualify.mjs --live --model <approved-model> --digest <sha256> --evidence <new-absolute-directory> [--electron-dist <installed-dist>] [--expect-head <commit>]";
  try {
    const values = {}, args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") { console.log(usage); process.exit(0); }
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--live") { values.live = true; continue; }
      const key = { "--evidence": "evidence", "--model": "model", "--digest": "digest", "--electron-dist": "electronDist", "--expect-head": "expectHead" }[args[i]];
      if (!key || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error(usage);
      values[key] = args[++i];
    }
    const controller = new AbortController();
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());
    const result = await qualify({ ...values, signal: controller.signal }); process.exitCode = result.status === "passed" ? 0 : 1;
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
