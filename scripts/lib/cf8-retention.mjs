import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const revision = value => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const hash = value => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export function assertNewPath(target) {
  try { fs.lstatSync(target); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  throw new Error("Output path already exists; choose a new private directory.");
}
export function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--output", "--baseline", "--current", "--verify", "--prepare-only"].includes(flag) || Object.hasOwn(out, flag.slice(2))) throw new Error(`Unknown or duplicate retention argument: ${flag}`);
    if (flag === "--prepare-only") { out["prepare-only"] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    out[flag.slice(2)] = value;
  }
  if (out.verify) {
    if (Object.keys(out).length !== 1) throw new Error("--verify cannot be combined with workload arguments.");
    return { verify: path.resolve(out.verify) };
  }
  if (!out.output || !revision(out.baseline) || !revision(out.current)) throw new Error("Specify --output and a full 40-character Git revision for both --baseline and --current.");
  return { output: path.resolve(out.output), baseline: out.baseline, current: out.current, prepareOnly: out["prepare-only"] === true };
}
function regularFile(root, relative) {
  if (typeof relative !== "string" || !relative || relative.includes("\\") || path.isAbsolute(relative) || relative.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe manifest path.");
  let cursor = root;
  for (const part of relative.split("/")) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`Manifest symlink refused: ${relative}`);
  }
  if (!fs.statSync(cursor).isFile()) throw new Error(`Manifest entry is not a regular file: ${relative}`);
  return cursor;
}
function verifyFiles(root, entries, label) {
  if (!Array.isArray(entries) || entries.length === 0) throw new Error(`Missing ${label} file manifest.`);
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || !hash(entry.sha256) || seen.has(entry.path)) throw new Error(`Invalid ${label} manifest entry.`);
    const file = regularFile(root, entry.path); seen.add(entry.path);
    if (entry.mode !== undefined && (!["100644", "100755"].includes(entry.mode) || ((fs.statSync(file).mode & 0o111) !== 0) !== (entry.mode === "100755"))) throw new Error(`${label} mode mismatch: ${entry.path}`);
    if (sha256(fs.readFileSync(file)) !== entry.sha256) throw new Error(`${label} hash mismatch: ${entry.path}`);
  }
}
export function verifyManifest(file, expectedSha256) {
  const bytes = fs.readFileSync(file);
  if (expectedSha256 !== undefined && (!hash(expectedSha256) || sha256(bytes) !== expectedSha256)) throw new Error("Manifest identity hash mismatch.");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.schema !== 1 || !["baseline", "current"].includes(manifest.role) || !revision(manifest.source?.sha) || !revision(manifest.source?.tree) || !revision(manifest.driver?.head)) throw new Error("Invalid retained source identity manifest.");
  for (const root of [manifest.source.root, manifest.dependencies?.root]) if (typeof root !== "string" || !path.isAbsolute(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) throw new Error("Invalid retained manifest root.");
  verifyFiles(manifest.source.root, manifest.source.files, "Source");
  verifyFiles(manifest.source.root, manifest.build?.files, "Build");
  const lock = regularFile(manifest.dependencies.root, "pnpm-lock.yaml");
  if (!hash(manifest.dependencies.lockSha256) || sha256(fs.readFileSync(lock)) !== manifest.dependencies.lockSha256) throw new Error("Dependency lock hash mismatch.");
  if (!manifest.dependencies.coreBinding) throw new Error("Missing desktop core binding.");
  verifyFiles(manifest.dependencies.root, manifest.dependencies.coreFiles, "Dependency core build");
  const actualCore = resolveDesktopCoreBinding(manifest.dependencies.root);
  for (const key of ["root", "aliasPath", "packagePath", "packageSha256", "entryPath", "entrySha256"]) if (actualCore[key] !== manifest.dependencies.coreBinding[key]) throw new Error("Desktop core binding identity mismatch: " + key);
  if (!Array.isArray(manifest.dependencies.links)) throw new Error("Missing dependency links.");
  for (const link of manifest.dependencies.links) if (typeof link.path !== "string" || typeof link.realPath !== "string" || fs.realpathSync(link.path) !== link.realPath) throw new Error("Dependency link identity mismatch.");
  if (!Array.isArray(manifest.driver.files) || manifest.driver.files.length === 0) throw new Error("Missing driver manifest.");
  const driverPaths = new Set();
  for (const entry of manifest.driver.files) {
    if (typeof entry.path !== "string" || !path.isAbsolute(entry.path) || path.resolve(entry.path) !== entry.path || !hash(entry.sha256) || driverPaths.has(entry.path)) throw new Error("Unsafe driver path or invalid driver identity.");
    const relative = path.relative(manifest.dependencies.root, entry.path);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw new Error("Unsafe driver path outside the declared driver root.");
    let file;
    try { file = regularFile(manifest.dependencies.root, relative); } catch (error) { throw new Error("Driver " + error.message); }
    driverPaths.add(entry.path);
    if (sha256(fs.readFileSync(file)) !== entry.sha256) throw new Error("Driver hash mismatch.");
  }
  return manifest;
}

export function resolveSourceRevision(repoRoot, ref) {
  if (!revision(ref)) throw new Error("A full 40-character Git revision is required.");
  try {
    const actual = execFileSync("git", ["rev-parse", "--verify", ref + "^{commit}"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (actual !== ref) throw new Error("not a commit identity");
    return { sha: actual, tree: execFileSync("git", ["rev-parse", actual + "^{tree}"], { cwd: repoRoot, encoding: "utf8" }).trim() };
  } catch { throw new Error("Source revision is unavailable or is not the exact commit; fetch the explicit source commit first."); }
}

export function assertCommonCore(repoRoot, refs) {
  if (!Array.isArray(refs) || refs.length < 2 || refs.some(ref => !revision(ref))) throw new Error("Explicit source commits are required for common core verification.");
  const trees = refs.map(ref => execFileSync("git", ["rev-parse", "--verify", ref + ":packages/core"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  if (trees.some(tree => tree !== trees[0])) throw new Error("Common dependency core source differs between measured and driver commits; prepare matching independent dependencies instead.");
  return trees[0];
}

export function exportSource({ repoRoot, ref, destination }) {
  assertNewPath(destination);
  const identity = resolveSourceRevision(repoRoot, ref);
  const listing = execFileSync("git", ["ls-tree", "-r", "--full-tree", "-z", ref], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const entries = listing.split("\0").filter(Boolean).map(line => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/s.exec(line);
    if (!match) throw new Error("Unsupported source entry; only regular Git blob files can be measured.");
    const [, mode, blob, name] = match;
    if (path.isAbsolute(name) || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Unsafe source export path.");
    return { mode, blob, path: name };
  });
  if (!entries.length) throw new Error("Missing source files.");
  const archive = execFileSync("git", ["archive", "--format=tar", ref], { cwd: repoRoot, maxBuffer: 256 * 1024 * 1024 });
  fs.mkdirSync(destination, { mode: 0o700 });
  execFileSync("tar", ["-xf", "-", "-C", destination], { input: archive, stdio: ["pipe", "pipe", "pipe"] });
  const files = entries.map(entry => {
    const file = regularFile(destination, entry.path), bytes = fs.readFileSync(file);
    const actualBlob = crypto.createHash("sha1").update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest("hex");
    if (actualBlob !== entry.blob) throw new Error(`Exported source does not match Git blob: ${entry.path}`);
    const executable = (fs.statSync(file).mode & 0o111) !== 0;
    if (executable !== (entry.mode === "100755")) throw new Error(`Exported source mode mismatch: ${entry.path}`);
    return { ...entry, sha256: sha256(bytes), bytes: bytes.length };
  });
  return { ...identity, root: destination, archiveSha256: sha256(archive), files };
}

export function runLogged({ command, args, cwd, log, env = process.env }) {
  const fd = fs.openSync(log, "wx", 0o600), startedAt = new Date().toISOString();
  let result;
  try {
    result = spawnSync(command, args, { cwd, env, stdio: ["ignore", fd, fd], windowsHide: true });
    if (result.error) fs.writeSync(fd, String(result.error.message) + "\n");
  } finally { fs.closeSync(fd); }
  return { command, args, cwd, log, startedAt, finishedAt: new Date().toISOString(), exit: result.status ?? 1, rawStatus: result.status, signal: result.signal, executionError: result.error?.code ?? null, sha256: sha256(fs.readFileSync(log)) };
}

function collectFiles(root, relative) {
  const result = [];
  const visit = name => {
    const file = path.join(root, name), stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected build symlink: ${name}`);
    if (stat.isDirectory()) { for (const child of fs.readdirSync(file).sort()) visit(name + "/" + child); }
    else if (stat.isFile()) result.push({ path: name, sha256: sha256(fs.readFileSync(file)), bytes: stat.size, mode: (stat.mode & 0o111) ? "100755" : "100644" });
    else throw new Error(`Unsupported build entry: ${name}`);
  };
  visit(relative);
  if (!result.length) throw new Error(`Missing built files: ${relative}`);
  return result;
}

/** Only local source/build preparation. The separate workload phase starts after this returns. */
export function prepareRetention({ repoRoot, output, baseline, current }) {
  assertNewPath(output);
  const refs = { baseline: resolveSourceRevision(repoRoot, baseline), current: resolveSourceRevision(repoRoot, current) };
  const driverHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const commonCoreTree = assertCommonCore(repoRoot, [baseline, current, driverHead]);
  const coreDirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "packages/core"], { cwd: repoRoot, encoding: "utf8" });
  if (coreDirty.trim()) throw new Error("Common dependency core has working changes; preserve them and use a clean owned driver checkout.");
  resolveDesktopCoreBinding(repoRoot, { requireBuilt: false });
  for (const identity of Object.values(refs)) {
    for (const file of ["apps/desktop/package.json", "apps/desktop/e2e/support.ts", "apps/desktop/vite.config.ts"]) {
      try { execFileSync("git", ["cat-file", "-e", identity.sha + ":" + file], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] }); }
      catch { throw new Error(`Required desktop source is absent at the explicit commit: ${file}`); }
    }
  }
  if (process.platform !== "darwin") throw new Error("These named-Mac retention workloads currently require macOS; offline --verify is available separately.");
  execFileSync("bash", [path.join(repoRoot, "scripts/worktree.sh"), "check"], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  const probes = path.join(repoRoot, "apps/desktop/.probes");
  try { if (!fs.lstatSync(probes).isDirectory() || fs.lstatSync(probes).isSymbolicLink()) throw new Error("Scratch root must be an owned real directory."); }
  catch (error) { if (error.code !== "ENOENT") throw error; fs.mkdirSync(probes, { mode: 0o700 }); }
  fs.mkdirSync(output, { mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(probes, "cf8-retention-")); fs.chmodSync(scratch, 0o700);
  const stateFile = path.join(output, "preparation.json"), state = { schema: 1, startedAt: new Date().toISOString(), state: "preparing", driverHead, driverHeadMeaning: "Diagnostic checkout HEAD; actual driver file hashes are recorded separately, including uncommitted work", commonCoreTree, output, scratch, commands: [], sources: [] };
  const persist = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); persist();
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("MODEX_")) delete env[key];
  const run = (label, command, args, cwd) => {
    state.phase = label; persist(); process.stdout.write(`[retention] ${label}\n`);
    const result = runLogged({ command, args, cwd, env, log: path.join(output, label + ".log") }); state.commands.push(result); persist();
    if (result.exit !== 0) { const error = new Error(`${label} failed with original exit ${result.exit}; retained ${result.log}`); error.exitCode = result.exit; throw error; }
    return result;
  };
  try {
    run("common-core-build", "pnpm", ["--filter", "@modex/core", "build"], repoRoot);
    const dependencies = { root: repoRoot, lockSha256: sha256(fs.readFileSync(path.join(repoRoot, "pnpm-lock.yaml"))), commonCoreTree, coreFiles: collectFiles(repoRoot, "packages/core/dist"), coreBinding: resolveDesktopCoreBinding(repoRoot), links: [] };
    const toolFiles = ["scripts/cf8-retention.mjs", "scripts/lib/cf8-retention.mjs"];
    if (fs.existsSync(path.join(repoRoot, "apps/desktop/bench/retention"))) toolFiles.push(...collectFiles(repoRoot, "apps/desktop/bench/retention").map(x => x.path));
    const driver = { head: driverHead, workingTreeDirty: execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repoRoot, encoding: "utf8" }).trim().length !== 0, fileHashMeaning: "Actual driver bytes are bound separately; checkout HEAD is not a claim that uncommitted files belong to that commit", node: process.version, files: toolFiles.map(name => ({ path: path.join(repoRoot, name), sha256: sha256(fs.readFileSync(path.join(repoRoot, name))) })) };
    for (const role of ["baseline", "current"]) {
      const destination = path.join(scratch, role), source = exportSource({ repoRoot, ref: refs[role].sha, destination });
      const links = linkCommonDependencies({ repoRoot, destination });
      const appDir = path.join(destination, "apps/desktop"), appPackage = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
      run(role + "-desktop-build", "pnpm", ["run", "build"], appDir);
      verifyFiles(source.root, source.files, "Source");
      const driverParent = path.join(scratch, "drivers"); fs.mkdirSync(driverParent, { recursive: true, mode: 0o700 });
      const generated = createWorkloadDrivers({ templateDir: path.join(repoRoot, "apps/desktop/bench/retention"), destination: path.join(driverParent, role), targetAppDir: appDir, libraryFile: path.join(repoRoot, "scripts/lib/cf8-retention.mjs") });
      const manifest = { schema: 1, role, source, appDir, appVersion: appPackage.version, build: { files: collectFiles(destination, "apps/desktop/dist") }, dependencies: { ...dependencies, links }, driver: { ...driver, directory: generated.directory, files: [...driver.files, ...generated.files] }, kind: "Byte-verified source export rebuilt with common current pinned dependencies, not a historical shipped binary" };
      const manifestFile = path.join(output, role + "-manifest.json"); fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 }); verifyManifest(manifestFile);
      state.sources.push({ role, sha: source.sha, tree: source.tree, appVersion: appPackage.version, manifest: manifestFile, manifestSha256: sha256(fs.readFileSync(manifestFile)) }); persist();
    }
    state.state = "prepared"; state.finishedAt = new Date().toISOString(); persist();
    return { output, scratch, sources: state.sources };
  } catch (error) {
    state.state = "failed"; state.failure = String(error.message); state.finishedAt = new Date().toISOString(); persist(); throw error;
  }
}

export function linkCommonDependencies({ repoRoot, destination }) {
  const links = [];
  for (const relative of ["node_modules", "apps/desktop/node_modules"]) {
    const installed = path.join(repoRoot, relative), link = path.join(destination, relative);
    if (!fs.existsSync(installed)) throw new Error(`Missing pinned installed dependencies: ${relative}`);
    fs.symlinkSync(fs.realpathSync(installed), link, "dir"); links.push({ path: link, realPath: fs.realpathSync(installed) });
  }
  return links;
}

export function createWorkloadDrivers({ templateDir, destination, targetAppDir, libraryFile }) {
  assertNewPath(destination);
  const files = collectFiles(templateDir, ".");
  const expected = ["history.spec.ts", "stream.spec.ts", "source-guard.ts", "target-support.ts", "playwright.config.ts"];
  if (expected.some(name => !files.some(file => path.normalize(file.path) === name))) throw new Error("Incomplete retention driver templates.");
  const sourceImport = 'from "../../../../scripts/lib/cf8-retention.mjs"';
  const guard = fs.readFileSync(path.join(templateDir, "source-guard.ts"), "utf8");
  if (guard.split(sourceImport).length !== 2) throw new Error("Retention source-guard import is not the expected single binding.");
  const targetImport = 'from "../../e2e/support"';
  const support = fs.readFileSync(path.join(templateDir, "target-support.ts"), "utf8");
  if (support.split(targetImport).length !== 2) throw new Error("Retention target-support import is not the expected single binding.");
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const file of files) {
    const target = path.join(destination, file.path); fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    let bytes = fs.readFileSync(path.join(templateDir, file.path));
    if (path.normalize(file.path) === "target-support.ts") bytes = Buffer.from(support.replace(targetImport, "from " + JSON.stringify(path.join(targetAppDir, "e2e/support.ts"))));
    if (path.normalize(file.path) === "source-guard.ts") bytes = Buffer.from(guard.replace(sourceImport, "from " + JSON.stringify(libraryFile)));
    fs.writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  }
  return { directory: destination, files: collectFiles(destination, ".").map(file => ({ path: path.resolve(destination, file.path), sha256: file.sha256 })) };
}

export function workloadEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("MODEX_")) delete env[key];
  env.MODEX_KEEP_TEST_TMP = "1";
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "JEV_API_KEY", "TYPESAFE_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_BASE_URL", "ANTHROPIC_BASE_URL"]) delete env[key];
  return env;
}

export function runPreparedWorkloads({ repoRoot, prepared }) {
  const state = { schema: 1, startedAt: new Date().toISOString(), state: "running", order: ["current", "baseline"], commands: [], sources: [], limits: "Descriptive source-rebuild experiments; no provider, universal memory, latency improvement, leak-freedom, native platform or human acceptance claim" };
  const receipt = path.join(prepared.output, "workloads.json"); assertNewPath(receipt);
  const persist = () => fs.writeFileSync(receipt, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 }); persist();
  try {
    for (const role of state.order) {
      const source = prepared.sources.find(entry => entry.role === role);
      if (!source) throw new Error(`Prepared source is absent: ${role}`);
      const manifest = verifyManifest(source.manifest, source.manifestSha256);
      const output = path.join(prepared.output, role); assertNewPath(output); fs.mkdirSync(output, { mode: 0o700 });
      const fixtureRoot = path.join(output, "fixtures"); fs.mkdirSync(fixtureRoot, { mode: 0o700 });
      state.activeRole = role; state.activeFixtureRoot = fixtureRoot; persist();
      const env = { ...workloadEnvironment(), MODEX_RETENTION_FIXTURE_ROOT: fixtureRoot, MODEX_RETENTION_MANIFEST: source.manifest, MODEX_RETENTION_MANIFEST_SHA256: source.manifestSha256, MODEX_RETENTION_OUTPUT: output };
      const config = path.join(manifest.driver.directory, "playwright.config.ts");
      const discovery = runLogged({ command: "pnpm", args: ["exec", "playwright", "test", "--config", config, "--list"], cwd: path.join(repoRoot, "apps/desktop"), env, log: path.join(output, "list-first.log") }); state.commands.push(discovery); persist();
      if (discovery.exit !== 0) { const error = new Error(`${role} discovery failed before app launch with original exit ${discovery.exit}; retained ${discovery.log}`); error.exitCode = discovery.exit; throw error; }
      const discoveryReport = path.join(output, "report.json");
      if (fs.existsSync(discoveryReport)) fs.copyFileSync(discoveryReport, path.join(output, "list-report.json"), fs.constants.COPYFILE_EXCL);
      verifyManifest(source.manifest, source.manifestSha256);
      process.stdout.write(`[retention] ${role}: six fresh-app cases, no retries\n`);
      const result = runLogged({ command: "pnpm", args: ["exec", "playwright", "test", "--config", path.join(manifest.driver.directory, "playwright.config.ts")], cwd: path.join(repoRoot, "apps/desktop"), env, log: path.join(output, "first.log") }); state.commands.push(result); persist();
      if (result.exit !== 0) { const error = new Error(`${role} measurement failed with original exit ${result.exit}; retained ${result.log}`); error.exitCode = result.exit; throw error; }
      const report = JSON.parse(fs.readFileSync(path.join(output, "report.json"), "utf8"));
      if (report.stats?.expected !== 6 || report.stats.unexpected !== 0 || report.stats.skipped !== 0 || report.stats.flaky !== 0 || report.errors?.length) throw new Error(`Incomplete or nonpassing ${role} measurement report.`);
      const observations = [];
      for (const kind of ["history", "stream"]) for (let replicate = 1; replicate <= 3; replicate++) {
        const file = path.join(output, `${kind}-${replicate}.json`), observation = JSON.parse(fs.readFileSync(file, "utf8"));
        if (observation.state !== "observations-complete" || observation.appClose !== "returned" || observation.sourceHead !== manifest.source.sha || observation.samples?.length !== (kind === "history" ? 63 : 21)) throw new Error(`Incomplete ${role}/${kind}/${replicate} observation.`);
        for (const key of ["home", "repo"]) {
          const retained = observation.fixture?.[key];
          if (typeof retained !== "string" || !fs.lstatSync(retained).isDirectory() || fs.lstatSync(retained).isSymbolicLink() || path.dirname(fs.realpathSync(retained)) !== fs.realpathSync(fixtureRoot)) throw new Error(`Missing or unbound retained ${role}/${kind}/${replicate}/${key} input.`);
        }
        if (!fs.existsSync(path.join(observation.fixture.home, "app/state.json")) || !fs.existsSync(path.join(observation.fixture.repo, "README.md"))) throw new Error(`Retained fixture state is incomplete: ${role}/${kind}/${replicate}`);
        observations.push({ kind, replicate, file, sha256: sha256(fs.readFileSync(file)), retainedFixture: observation.fixture });
      }
      verifyManifest(source.manifest, source.manifestSha256);
      state.sources.push({ role, source: manifest.source.sha, reportSha256: sha256(fs.readFileSync(path.join(output, "report.json"))), passed: 6, skipped: 0, retries: 0, observations }); persist();
    }
    state.state = "observations-complete"; state.finishedAt = new Date().toISOString(); persist(); return state;
  } catch (error) { state.state = "failed"; state.failure = String(error.message); state.finishedAt = new Date().toISOString(); persist(); throw error; }
}

/** Resolve metadata only: never import or execute the installed core module. */
export function resolveDesktopCoreBinding(repoRoot, { requireBuilt = true } = {}) {
  try {
    const root = fs.realpathSync(path.join(repoRoot, "packages/core"));
    const aliasPath = path.resolve(repoRoot, "apps/desktop/node_modules/@modex/core");
    if (fs.realpathSync(aliasPath) !== root) throw new Error("desktop dependency resolves to a different common core");
    const packagePath = regularFile(root, "package.json"), packageBytes = fs.readFileSync(packagePath);
    if (JSON.parse(packageBytes.toString("utf8")).name !== "@modex/core") throw new Error("unexpected core package metadata");
    const resolved = execFileSync(process.execPath, ["--input-type=module", "--eval", 'process.stdout.write(import.meta.resolve("@modex/core"))'], { cwd: path.join(repoRoot, "apps/desktop"), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const candidate = fileURLToPath(resolved);
    const physicalAlias = path.join(fs.realpathSync(path.dirname(aliasPath)), path.basename(aliasPath));
    let relative;
    for (const base of [root, aliasPath, physicalAlias]) {
      const part = path.relative(base, candidate);
      if (part && !path.isAbsolute(part) && part !== ".." && !part.startsWith(".." + path.sep)) { relative = part; break; }
    }
    if (!relative || relative.split(path.sep)[0] !== "dist") throw new Error("core entry is outside its bound compiled directory");
    const entryPath = path.join(root, relative);
    let cursor = root, missing = false;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("core entry contains a symlink"); }
      catch (error) { if (error.code !== "ENOENT") throw error; missing = true; break; }
    }
    if (missing && requireBuilt) throw new Error("core entry has not been built");
    if (!missing && !fs.statSync(entryPath).isFile()) throw new Error("core entry is not a regular file");
    return { root, aliasPath, packagePath, packageSha256: sha256(packageBytes), entryPath, entrySha256: missing ? null : sha256(fs.readFileSync(entryPath)) };
  } catch (error) { throw new Error("Desktop core binding is invalid: " + error.message); }
}
