import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { probe } from "../src/main/engine/backends/health.js";
import { resolveCli } from "../src/main/engine/cli-path.js";

const cmdShim = createRequire(import.meta.url)("cmd-shim") as (from: string, to: string) => Promise<void>;

const argumentsToPreserve = ["", "two words", 'embedded "quotes"', "trailing\\", "&|<>^()%MODEX_ARG_TEST%!", "line one\nline two", '{"directory":"C:\\CLI Tools\\project"}'];
const env: NodeJS.ProcessEnv = { ...process.env, MODEX_ARG_TEST: "must not replace literal text" };

test("CLI probing preserves argv without interpreting metacharacters", async () => {
  const result = await probe(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...argumentsToPreserve], undefined, 5000, env);
  assert.equal(result.failure, undefined);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.output), argumentsToPreserve);
});

for (const location of ["npm", "node_modules/.bin"]) {
  test(`native Windows ${location} shim preserves arguments and resolves the selected CLI`, { skip: process.platform !== "win32" }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-cli-launch-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const directory = path.join(root, "CLI tools & fixtures", location);
    fs.mkdirSync(directory, { recursive: true });
    const script = path.join(root, "arguments.cjs");
    fs.writeFileSync(script, "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    const shim = path.join(directory, "codex.cmd");
    await cmdShim(script, path.join(directory, "codex"));
    const childEnv = { ...env, PATH: `${directory};${path.dirname(process.execPath)};${env.PATH ?? ""}`, MODEX_NO_LOGIN_PATH: "1" };
    assert.equal(resolveCli("codex", "", { env: childEnv }), shim);
    const result = await probe(shim, argumentsToPreserve, undefined, 5000, childEnv);
    assert.equal(result.failure, undefined);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.output), argumentsToPreserve);
  });
}

test("Windows npm launch uses node.exe directly with every original argument", async t => {
  const { prepareCliLaunch } = await import("../src/main/engine/cli-launch.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-shim-plan-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, "cli.js");
  fs.writeFileSync(entry, "#!/usr/bin/env node\n");
  await cmdShim(entry, path.join(root, "codex"));
  const contents = fs.readFileSync(path.join(root, "codex.cmd"), "utf8");
  const realRead = fs.readFileSync;
  const files = new Map([[String.raw`C:\CLI Tools\codex.cmd`, contents], [String.raw`C:\CLI Tools\cli.js`, "#!/usr/bin/env node\n"], [String.raw`C:\Node\node.exe`, "binary"]]);
  t.mock.method(fs, "statSync", (file: string) => {
    const content = files.get(file);
    if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isFile: () => true, size: content.length };
  });
  t.mock.method(fs, "readFileSync", (file: string, ...rest: unknown[]) => files.has(file) ? files.get(file)! : Reflect.apply(realRead, fs, [file, ...rest]));
  const source = [...argumentsToPreserve];
  assert.deepEqual(prepareCliLaunch(String.raw`C:\CLI Tools\codex.cmd`, source, { Path: String.raw`relative;C:\Node` }, "win32"), {
    file: String.raw`C:\Node\node.exe`, args: [String.raw`C:\CLI Tools\cli.js`, ...source],
  });
  assert.deepEqual(source, argumentsToPreserve);
  assert.throws(() => prepareCliLaunch(String.raw`C:\CLI Tools\codex.cmd`, source, { PATH: "relative" }, "win32"), /Node.js/i);
  for (const invalid of [contents + "echo unexpected\n", contents.replace('"_prog=node"', '"_prog=python"'), contents.replace('"%_prog%"', '"%_prog%" --extra')]) {
    files.set(String.raw`C:\CLI Tools\codex.cmd`, invalid);
    assert.throws(() => prepareCliLaunch(String.raw`C:\CLI Tools\codex.cmd`, source, { PATH: String.raw`C:\Node` }, "win32"), /npm|native/i);
  }
});

test("Windows CLI environment retains the inherited Node PATH under one canonical key", async () => {
  const { cliEnvironment } = await import("../src/main/engine/backends/health.js");
  const before = { Path: String.raw`C:\Node;C:\Windows\System32`, TOKEN: "preserved" };
  assert.deepEqual(cliEnvironment(String.raw`C:\CLI Tools\codex.cmd`, before, "win32"), {
    PATH: String.raw`C:\CLI Tools;C:\Node;C:\Windows\System32`, TOKEN: "preserved",
  });
  assert.deepEqual(before, { Path: String.raw`C:\Node;C:\Windows\System32`, TOKEN: "preserved" });
});

test("Windows native npm launcher resolves its executable without requiring Node on PATH", async t => {
  const { prepareCliLaunch } = await import("../src/main/engine/cli-launch.js");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-native-shim-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, "claude.exe");
  fs.writeFileSync(entry, "MZfixture");
  await cmdShim(entry, path.join(root, "claude"));
  const contents = fs.readFileSync(path.join(root, "claude.cmd"), "utf8");
  const files = new Map([[String.raw`C:\CLI Tools\claude.cmd`, contents], [String.raw`C:\CLI Tools\claude.exe`, "MZfixture"]]);
  const realRead = fs.readFileSync;
  t.mock.method(fs, "statSync", (file: string) => {
    const content = files.get(file);
    if (content === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isFile: () => true, size: content.length };
  });
  t.mock.method(fs, "readFileSync", (file: string, ...rest: unknown[]) => files.has(file) ? files.get(file)! : Reflect.apply(realRead, fs, [file, ...rest]));
  assert.deepEqual(prepareCliLaunch(String.raw`C:\CLI Tools\claude.cmd`, argumentsToPreserve, {}, "win32"), {
    file: String.raw`C:\CLI Tools\claude.exe`, args: argumentsToPreserve,
  });
  for (const invalid of [contents + "echo unexpected\n", contents.replace('"   %*', '" --extra %*'), contents.replace("claude.exe", "claude.cmd")]) {
    files.set(String.raw`C:\CLI Tools\claude.cmd`, invalid);
    assert.throws(() => prepareCliLaunch(String.raw`C:\CLI Tools\claude.cmd`, argumentsToPreserve, {}, "win32"), /npm|native/i);
  }
});

test("native Windows npm executable shim preserves exact argv", { skip: process.platform !== "win32" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex-native-cli-launch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "CLI tools & fixtures");
  fs.mkdirSync(directory);
  const entry = path.join(directory, "native-cli.exe");
  fs.copyFileSync(process.execPath, entry);
  await cmdShim(entry, path.join(directory, "claude"));
  const shim = path.join(directory, "claude.cmd");
  const result = await probe(shim, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...argumentsToPreserve], undefined, 5000, env);
  assert.equal(result.failure, undefined);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.output), argumentsToPreserve);
});
