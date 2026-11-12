import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(root, "scripts/cf8-retention.mjs");

test("retention CLI describes explicit sources and offline verification without starting a workload", () => {
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", cwd: root });
  assert.equal(result.status, 0, result.stderr);
  for (const flag of ["--baseline", "--current", "--output", "--prepare-only", "--verify"]) assert.ok(result.stdout.includes(flag), flag);
  assert.match(result.stdout, /common.*dependencies/i);
});

import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
const digest = text => crypto.createHash("sha256").update(text).digest("hex");
const invoke = args => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", cwd: root });
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-retention-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function manifestFixture(t) {
  const dir = temporary(t), source = path.join(dir, "source"), dependencies = path.join(dir, "dependencies");
  fs.mkdirSync(path.join(source, "apps/desktop/dist"), { recursive: true });
  fs.mkdirSync(dependencies);
  const driverDir = path.join(dependencies, "driver"); fs.mkdirSync(driverDir);
  fs.writeFileSync(path.join(driverDir, "entry.mjs"), 'import { value } from "./neighbor.mjs"; export { value };\n');
  fs.writeFileSync(path.join(driverDir, "neighbor.mjs"), 'export const value = "bound";\n');
  fs.writeFileSync(path.join(dependencies, "pnpm-lock.yaml"), "pinned fixture lock\n");
  const core = path.join(dependencies, "packages/core"), alias = path.join(dependencies, "apps/desktop/node_modules/@modex/core");
  fs.mkdirSync(path.join(core, "dist/src"), { recursive: true }); fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.writeFileSync(path.join(dependencies, "apps/desktop/package.json"), '{"name":"desktop-fixture","type":"module"}');
  const packageText = '{"name":"@modex/core","type":"module","main":"./dist/src/index.js","exports":{".":{"default":"./dist/src/index.js"}}}';
  const entryText = 'export const core = 1;\n'; fs.writeFileSync(path.join(core, "package.json"), packageText); fs.writeFileSync(path.join(core, "dist/src/index.js"), entryText); fs.symlinkSync(core, alias, "dir");
  const coreBinding = { root: fs.realpathSync(core), aliasPath: path.resolve(alias), packagePath: fs.realpathSync(path.join(core, "package.json")), packageSha256: digest(packageText), entryPath: fs.realpathSync(path.join(core, "dist/src/index.js")), entrySha256: digest(entryText) };

  const files = [["apps/desktop/package.json", '{"version":"0.2.0"}\n'], ["apps/desktop/dist/main.js", 'throw new Error("verification must not execute this file");\n']];
  for (const [name, text] of files) fs.writeFileSync(path.join(source, name), text);
  const manifest = { schema: 1, role: "baseline", source: { sha: "a".repeat(40), tree: "b".repeat(40), root: source, files: [{ path: files[0][0], sha256: digest(files[0][1]) }] }, build: { files: [{ path: files[1][0], sha256: digest(files[1][1]) }] }, dependencies: { root: dependencies, lockSha256: digest("pinned fixture lock\n"), links: [], coreFiles: [{ path: "packages/core/dist/src/index.js", sha256: digest(entryText) }], coreBinding }, driver: { head: "c".repeat(40), files: ["entry.mjs", "neighbor.mjs"].map(name => ({ path: path.join(driverDir, name), sha256: digest(fs.readFileSync(path.join(driverDir, name))) })) } };
  const file = path.join(dir, "manifest.json");
  const write = () => fs.writeFileSync(file, JSON.stringify(manifest)); write();
  return { dir, source, manifest, file, write, core, alias };
}

test("existing retention output is refused before source resolution and remains untouched", t => {
  const dir = temporary(t), output = path.join(dir, "retained"); fs.mkdirSync(output); fs.writeFileSync(path.join(output, "sentinel"), "keep me");
  const result = invoke(["--output", output, "--baseline", "a".repeat(40), "--current", "b".repeat(40), "--prepare-only"]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /output.*already exists/i);
  assert.deepEqual(fs.readdirSync(output), ["sentinel"]); assert.equal(fs.readFileSync(path.join(output, "sentinel"), "utf8"), "keep me");
});
test("a dangling output symlink is preserved and refused", t => {
  const dir = temporary(t), output = path.join(dir, "retained"), missing = path.join(dir, "missing"); fs.symlinkSync(missing, output);
  const result = invoke(["--output", output, "--baseline", "a".repeat(40), "--current", "b".repeat(40)]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /output.*already exists/i); assert.equal(fs.readlinkSync(output), missing); assert.equal(fs.existsSync(missing), false);
});
test("a source shorthand is refused without creating output", t => {
  const dir = temporary(t), output = path.join(dir, "new");
  const result = invoke(["--output", output, "--baseline", "HEAD", "--current", "b".repeat(40)]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /full 40.character.*revision/i); assert.equal(fs.existsSync(output), false);
});
test("offline verification checks retained bytes without executing the app", t => {
  const f = manifestFixture(t), result = invoke(["--verify", f.file]);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /verified.*no workload launched/i);
});
test("offline verification refuses a changed source byte", t => {
  const f = manifestFixture(t); fs.appendFileSync(path.join(f.source, f.manifest.source.files[0].path), "changed");
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /source.*hash mismatch/i);
});
test("offline verification refuses a changed built byte", t => {
  const f = manifestFixture(t); fs.appendFileSync(path.join(f.source, f.manifest.build.files[0].path), "changed");
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /build.*hash mismatch/i);
});
test("offline verification refuses manifest traversal even for matching bytes", t => {
  const f = manifestFixture(t); fs.writeFileSync(path.join(f.dir, "outside"), "outside"); f.manifest.source.files.push({ path: "../outside", sha256: digest("outside") }); f.write();
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /unsafe.*path/i);
});
test("offline verification refuses source symlinks even to matching bytes", t => {
  const f = manifestFixture(t), sourceFile = path.join(f.source, f.manifest.source.files[0].path), other = path.join(f.dir, "outside"); fs.renameSync(sourceFile, other); fs.symlinkSync(other, sourceFile);
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /symlink/i);
});
test("offline verification refuses a changed dependency lock", t => {
  const f = manifestFixture(t); fs.appendFileSync(path.join(f.manifest.dependencies.root, "pnpm-lock.yaml"), "changed");
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /dependency.*hash mismatch/i);
});

test("an unavailable full source revision fails before creating output", t => {
  const dir = temporary(t), output = path.join(dir, "new");
  const result = invoke(["--output", output, "--baseline", "0".repeat(40), "--current", "b".repeat(40), "--prepare-only"]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /source revision is unavailable/i); assert.equal(fs.existsSync(output), false);
});
test("offline verification refuses a manifest with no measured source files", t => {
  const f = manifestFixture(t); f.manifest.source.files = []; f.write(); const result = invoke(["--verify", f.file]);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /missing source file manifest/i);
});
test("offline verification refuses a replaced declared dependency link", t => {
  const f = manifestFixture(t), link = path.join(f.dir, "linked-dependencies"); fs.symlinkSync(f.manifest.dependencies.root, link); f.manifest.dependencies.links = [{ path: link, realPath: fs.realpathSync(f.manifest.dependencies.root) }]; f.write();
  const before = invoke(["--verify", f.file]); assert.equal(before.status, 0, before.stderr);
  fs.unlinkSync(link); fs.mkdirSync(link);
  const after = invoke(["--verify", f.file]); assert.notEqual(after.status, 0); assert.match(after.stderr, /dependency link identity mismatch/i);
});

import * as retention from "../lib/cf8-retention.mjs";
function sourceRepository(t) {
  const dir = temporary(t), env = { ...process.env, GIT_AUTHOR_NAME: "retention fixture", GIT_AUTHOR_EMAIL: "fixture@modex.local", GIT_COMMITTER_NAME: "retention fixture", GIT_COMMITTER_EMAIL: "fixture@modex.local" };
  const git = args => {
    const result = spawnSync("git", args, { cwd: dir, env, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(["init", "-q"]); fs.mkdirSync(path.join(dir, "packages/core/src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packages/core/src/engine.ts"), "export const core = 1;\n"); fs.writeFileSync(path.join(dir, "app.txt"), "first");
  const commit = label => { git(["add", "."]); git(["-c", "commit.gpgsign=false", "commit", "-qm", label]); return git(["rev-parse", "HEAD"]); };
  const baseline = commit("baseline"); fs.writeFileSync(path.join(dir, "app.txt"), "second"); const current = commit("app change");
  fs.writeFileSync(path.join(dir, "packages/core/src/engine.ts"), "export const core = 2;\n"); const changedCore = commit("core change");
  return { dir, git, baseline, current, changedCore };
}
test("common dependency preparation accepts different app sources with identical core bytes", t => {
  const f = sourceRepository(t); assert.doesNotThrow(() => retention.assertCommonCore(f.dir, [f.baseline, f.current]));
});
test("common dependency preparation refuses source refs with different core bytes", t => {
  const f = sourceRepository(t); assert.throws(() => retention.assertCommonCore(f.dir, [f.baseline, f.changedCore]), /common.*core.*differs/i);
});
test("a full annotated-tag object cannot masquerade as the measured commit", t => {
  const f = sourceRepository(t); f.git(["-c", "tag.gpgSign=false", "tag", "-am", "fixture tag", "fixture-tag", f.current]);
  const tag = f.git(["rev-parse", "fixture-tag"]); assert.throws(() => retention.resolveSourceRevision(f.dir, tag), /not the exact commit/i);
});

test("a source export reproduces the requested commit instead of the newer working checkout", t => {
  const f = sourceRepository(t), destination = path.join(f.dir, "exported");
  const source = retention.exportSource({ repoRoot: f.dir, ref: f.baseline, destination });
  assert.equal(source.sha, f.baseline); assert.equal(source.tree, f.git(["rev-parse", f.baseline + "^{tree}"]));
  assert.equal(fs.readFileSync(path.join(destination, "app.txt"), "utf8"), "first");
  assert.equal(fs.readFileSync(path.join(destination, "packages/core/src/engine.ts"), "utf8"), "export const core = 1;\n");
  assert.deepEqual(source.files.map(x => x.path), ["app.txt", "packages/core/src/engine.ts"]);
  assert.equal(source.files.find(x => x.path === "app.txt").sha256, digest("first"));
  assert.equal(fs.existsSync(path.join(destination, ".git")), false);
});
test("source export refuses tracked symlinks before creating a destination", t => {
  const f = sourceRepository(t), destination = path.join(f.dir, "exported"); fs.symlinkSync("app.txt", path.join(f.dir, "linked")); f.git(["add", "linked"]); f.git(["-c", "commit.gpgsign=false", "commit", "-qm", "linked source"]);
  const ref = f.git(["rev-parse", "HEAD"]);
  assert.throws(() => retention.exportSource({ repoRoot: f.dir, ref, destination }), /unsupported source entry/i); assert.equal(fs.existsSync(destination), false);
});
test("source export does not replace a previously prepared destination", t => {
  const f = sourceRepository(t), destination = path.join(f.dir, "exported"); fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "sentinel"), "retain");
  assert.throws(() => retention.exportSource({ repoRoot: f.dir, ref: f.baseline, destination }), /already exists/i);
  assert.equal(fs.readFileSync(path.join(destination, "sentinel"), "utf8"), "retain");
});

test("a failed build command retains stdout, stderr and its original exit status", t => {
  const dir = temporary(t), log = path.join(dir, "first.log");
  const result = retention.runLogged({ command: process.execPath, args: ["-e", 'process.stdout.write("original stdout\\n"); process.stderr.write("original stderr\\n"); process.exit(7);'], cwd: dir, log });
  assert.equal(result.exit, 7); assert.equal(fs.readFileSync(log, "utf8"), "original stdout\noriginal stderr\n"); assert.equal(result.sha256, digest("original stdout\noriginal stderr\n"));
});
test("a retained build log cannot be replaced or trigger a second invocation", t => {
  const dir = temporary(t), log = path.join(dir, "first.log"), effect = path.join(dir, "effect"); fs.writeFileSync(log, "retain original failure");
  assert.throws(() => retention.runLogged({ command: process.execPath, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(effect)}, 'ran')`], cwd: dir, log }), /EEXIST/);
  assert.equal(fs.readFileSync(log, "utf8"), "retain original failure"); assert.equal(fs.existsSync(effect), false);
});

test("shared dependencies work when the dependency-free core has no node_modules directory", t => {
  const dir = temporary(t), repoRoot = path.join(dir, "driver"), destination = path.join(dir, "source");
  for (const base of [repoRoot, destination]) fs.mkdirSync(path.join(base, "apps/desktop"), { recursive: true });
  fs.mkdirSync(path.join(repoRoot, "node_modules")); fs.mkdirSync(path.join(repoRoot, "apps/desktop/node_modules"));
  const links = retention.linkCommonDependencies({ repoRoot, destination });
  assert.equal(links.length, 2); assert.equal(fs.realpathSync(path.join(destination, "node_modules")), fs.realpathSync(path.join(repoRoot, "node_modules")));
  assert.equal(fs.realpathSync(path.join(destination, "apps/desktop/node_modules")), fs.realpathSync(path.join(repoRoot, "apps/desktop/node_modules")));
  assert.equal(fs.existsSync(path.join(destination, "packages/core/node_modules")), false);
});

test("driver generation never replaces a retained driver directory", t => {
  const dir = temporary(t), templateDir = path.join(dir, "template"), destination = path.join(dir, "driver"); fs.mkdirSync(templateDir); fs.mkdirSync(destination); fs.writeFileSync(path.join(destination, "sentinel"), "retain");
  assert.throws(() => retention.createWorkloadDrivers({ templateDir, destination, targetAppDir: dir, libraryFile: cli }), /already exists/i);
  assert.equal(fs.readFileSync(path.join(destination, "sentinel"), "utf8"), "retain");
});
test("driver generation refuses a symlinked template before creating its output", t => {
  const dir = temporary(t), templateDir = path.join(dir, "template"), destination = path.join(dir, "driver"); fs.mkdirSync(templateDir); fs.writeFileSync(path.join(dir, "outside.ts"), "retain"); fs.symlinkSync(path.join(dir, "outside.ts"), path.join(templateDir, "history.spec.ts"));
  assert.throws(() => retention.createWorkloadDrivers({ templateDir, destination, targetAppDir: dir, libraryFile: cli }), /symlink/i);
  assert.equal(fs.existsSync(destination), false);
});

test("a recorded manifest digest prevents metadata rebinding despite unchanged file bytes", t => {
  const f = manifestFixture(t), recorded = digest(fs.readFileSync(f.file));
  f.manifest.appVersion = "changed after preparation"; f.write();
  assert.throws(() => retention.verifyManifest(f.file, recorded), /manifest identity hash mismatch/i);
});
test("offline verification detects a changed executable mode as a source change", t => {
  const f = manifestFixture(t); f.manifest.source.files[0].mode = "100644"; f.write();
  fs.chmodSync(path.join(f.source, f.manifest.source.files[0].path), 0o755);
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /source mode mismatch/i);
});

test("benchmark inputs survive a failed real Playwright worker and its exit cleanup", { timeout: 30_000, skip: process.platform === "win32" }, t => {
  const probes = path.join(root, "apps/desktop/.probes"); fs.mkdirSync(probes, { recursive: true });
  const dir = fs.mkdtempSync(path.join(probes, "cf8-retain-worker-control-")); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const inputs = path.join(dir, "retained-inputs"), locator = path.join(dir, "fixture.json"), runtimeTemp = path.join(dir, "runtime-temp"); fs.mkdirSync(inputs, { mode: 0o700 }); fs.mkdirSync(runtimeTemp, { mode: 0o700 });
  const generated = retention.createWorkloadDrivers({ templateDir: path.join(root, "apps/desktop/bench/retention"), destination: path.join(dir, "generated-driver"), targetAppDir: path.join(root, "apps/desktop"), libraryFile: path.join(root, "scripts/lib/cf8-retention.mjs") });
  fs.writeFileSync(path.join(dir, "fixture.spec.ts"), `import { test } from "@playwright/test"; import fs from "node:fs"; import os from "node:os"; import { seedHome } from ${JSON.stringify(path.join(generated.directory, "target-support.ts"))}; test("intentional early fixture failure", () => { const before = os.tmpdir(); const fixture = seedHome(); fs.writeFileSync(${JSON.stringify(locator)}, JSON.stringify({ ...fixture, runtimeBefore: before, runtimeAfter: os.tmpdir() })); throw new Error("intentional benchmark fixture failure before app launch"); });\n`);
  fs.writeFileSync(path.join(dir, "playwright.config.ts"), `export default { testDir: ".", testMatch: "fixture.spec.ts", outputDir: ${JSON.stringify(path.join(dir, 'test-results'))}, workers: 1, retries: 0, maxFailures: 1, reporter: "list", use: { trace: "off" } };\n`);
  const child = spawnSync("pnpm", ["exec", "playwright", "test", "--config", path.join(dir, "playwright.config.ts")], { cwd: path.join(root, "apps/desktop"), encoding: "utf8", env: { ...retention.workloadEnvironment(), TMPDIR: runtimeTemp, MODEX_RETENTION_FIXTURE_ROOT: inputs }, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(child.status, 1, child.stdout + child.stderr); assert.match(child.stdout + child.stderr, /intentional benchmark fixture failure before app launch/);
  const seeded = JSON.parse(fs.readFileSync(locator, "utf8"));
  for (const key of ["home", "repo"]) assert.equal(path.dirname(seeded[key]), inputs);
  assert.equal(seeded.runtimeBefore, runtimeTemp); assert.equal(seeded.runtimeAfter, runtimeTemp, "runtime temp context must be restored before app launch");
  assert.ok(fs.existsSync(path.join(seeded.home, "app/state.json")), "retained state must survive failed worker exit");
  assert.ok(fs.existsSync(path.join(seeded.repo, "README.md")), "retained disposable repository must survive failed worker exit");
});

test("matching-byte driver file symlinks cannot redirect relative module resolution", t => {
  const f = manifestFixture(t), file = f.manifest.driver.files[0].path, moved = path.join(f.dir, "moved-driver.mjs"); fs.renameSync(file, moved); fs.symlinkSync(moved, file);
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /driver.*symlink/i);
});
test("matching-byte driver ancestor symlinks are refused", t => {
  const f = manifestFixture(t), dir = path.dirname(f.manifest.driver.files[0].path), moved = path.join(f.dir, "moved-driver"); fs.renameSync(dir, moved); fs.symlinkSync(moved, dir, "dir");
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /driver.*symlink/i);
});
test("driver manifest dot traversal is refused even when it reads matching bytes", t => {
  const f = manifestFixture(t), dir = path.dirname(f.manifest.driver.files[0].path); f.manifest.driver.files[0].path = dir + "/../driver/entry.mjs"; f.write();
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /unsafe driver path/i);
});
test("a driver manifest cannot omit all driver provenance", t => {
  const f = manifestFixture(t); f.manifest.driver.files = []; f.write();
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /missing driver manifest/i);
});

test("a retargeted desktop core alias is refused while recorded core build bytes stay unchanged", t => {
  const f = manifestFixture(t), other = path.join(f.dir, "other-core"); fs.cpSync(f.core, other, { recursive: true }); fs.unlinkSync(f.alias); fs.symlinkSync(other, f.alias, "dir");
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /core binding/i);
  assert.equal(digest(fs.readFileSync(path.join(f.core, "dist/src/index.js"))), f.manifest.dependencies.coreFiles[0].sha256);
});
test("changed core entry metadata is refused even when all recorded build files are unchanged", t => {
  const f = manifestFixture(t), otherEntry = path.join(f.core, "dist/src/other.js"); fs.writeFileSync(otherEntry, "export const other = 2;\n"); f.manifest.dependencies.coreFiles.push({ path: "packages/core/dist/src/other.js", sha256: digest(fs.readFileSync(otherEntry)) }); f.write();
  const pkg = JSON.parse(fs.readFileSync(path.join(f.core, "package.json"), "utf8")); pkg.exports["."].default = "./dist/src/other.js"; fs.writeFileSync(path.join(f.core, "package.json"), JSON.stringify(pkg));
  const result = invoke(["--verify", f.file]); assert.notEqual(result.status, 0); assert.match(result.stderr, /core binding/i);
});
test("desktop core binding resolves the expected package and entry without executing the module", t => {
  const f = manifestFixture(t), effect = path.join(f.dir, "module-executed"), entry = path.join(f.core, "dist/src/index.js");
  fs.writeFileSync(entry, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(effect)}, 'ran'); export const core = 1;\n`);
  const result = retention.resolveDesktopCoreBinding(f.manifest.dependencies.root);
  assert.deepEqual(result, { ...f.manifest.dependencies.coreBinding, entrySha256: digest(fs.readFileSync(entry)) }); assert.equal(fs.existsSync(effect), false);
});
test("prebuild core binding works before its declared compiled entry exists", t => {
  const f = manifestFixture(t); fs.unlinkSync(path.join(f.core, "dist/src/index.js"));
  const result = retention.resolveDesktopCoreBinding(f.manifest.dependencies.root, { requireBuilt: false });
  assert.deepEqual(result, { ...f.manifest.dependencies.coreBinding, entrySha256: null });
});

test("a retargeted installed core stops preparation before its first build", { skip: process.platform !== "darwin" }, t => {
  const f = manifestFixture(t), repoRoot = f.manifest.dependencies.root;
  fs.mkdirSync(path.join(repoRoot, "apps/desktop/e2e")); fs.mkdirSync(path.join(repoRoot, "scripts"));
  fs.writeFileSync(path.join(repoRoot, "apps/desktop/e2e/support.ts"), "export {};\n"); fs.writeFileSync(path.join(repoRoot, "apps/desktop/vite.config.ts"), "export default {};\n"); fs.writeFileSync(path.join(repoRoot, "scripts/worktree.sh"), "exit 0\n"); fs.writeFileSync(path.join(repoRoot, ".gitignore"), "node_modules/\npackages/core/dist/\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: "retention fixture", GIT_AUTHOR_EMAIL: "fixture@modex.local", GIT_COMMITTER_NAME: "retention fixture", GIT_COMMITTER_EMAIL: "fixture@modex.local" };
  const git = args => { const result = spawnSync("git", args, { cwd: repoRoot, env, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git(["init", "-q"]); git(["add", "."]); git(["-c", "commit.gpgsign=false", "commit", "-qm", "fixture source"]); const ref = git(["rev-parse", "HEAD"]);
  const other = path.join(f.dir, "other-core"); fs.cpSync(f.core, other, { recursive: true }); fs.unlinkSync(f.alias); fs.symlinkSync(other, f.alias, "dir");
  const bin = path.join(f.dir, "bin"), effect = path.join(f.dir, "build-started"), output = path.join(f.dir, "output"); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pnpm"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(effect)}, 'ran'); process.exit(91);\n`, { mode: 0o755 });
  const previous = process.env.PATH; process.env.PATH = bin + path.delimiter + previous; t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous; });
  assert.throws(() => retention.prepareRetention({ repoRoot, output, baseline: ref, current: ref }), /desktop core binding/i);
  assert.equal(fs.existsSync(effect), false, "no build command may start against another installed core"); assert.equal(fs.existsSync(output), false);
});
