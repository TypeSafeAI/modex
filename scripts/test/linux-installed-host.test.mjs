import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = process.env.MODEX_TEST_LINUX_HOST_SCRIPT ?? fileURLToPath(new URL("../prepare-linux-installed-host.sh", import.meta.url));
const packages = ["xvfb", "libgbm1", "libasound2t64", "dbus", "gnome-keyring", "libsecret-1-0", "libglib2.0-bin", "libfuse2t64", "libkf5wallet-bin"];

// Exercise the real shell helper. Only privilege escalation and external APT are replaced;
// configuration creation, argument boundaries, exit handling and cleanup remain real.
function run(t, scenario = "success", overrides = {}, codename = "noble") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "modex linux host test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin"), log = path.join(root, "calls.jsonl");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "apt-get"), `#!/usr/bin/env node
const fs = require("node:fs"), args = process.argv.slice(2);
const sourceArg = args.find(x => x.toLowerCase().startsWith("dir::etc::sourcelist="));
const source = sourceArg?.slice("Dir::Etc::sourcelist=".length);
const parts = args.find(x => x.toLowerCase().startsWith("dir::etc::sourceparts="))?.split("=").slice(1).join("=");
const verb = args.find(x => x === "update" || x === "install");
fs.appendFileSync(process.env.MODEX_APT_TEST_LOG, JSON.stringify({ args, verb, source, parts, partsEntries: parts ? fs.readdirSync(parts) : null, sources: source ? fs.readFileSync(source, "utf8") : null }) + "\\n");
if (!source || (process.env.MODEX_APT_TEST_SCENARIO === "security-dns-fails" && fs.readFileSync(source, "utf8").includes("https://security.ubuntu.com/ubuntu")) || (process.env.MODEX_APT_TEST_SCENARIO === "update-fails" && verb === "update")) {
  console.error("Temporary failure resolving the package mirror");
  const strict = args.some(x => x.toLowerCase() === "apt::update::error-mode=any");
  process.exit(verb === "update" && !strict ? 0 : 100);
}
if (process.env.MODEX_APT_TEST_SCENARIO === "install-fails" && verb === "install") process.exit(100);
`, { mode: 0o755 });
  const result = spawnSync("bash", [script, codename], { encoding: "utf8", timeout: 5000, env: {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_ACTIONS: "true", RUNNER_OS: "Linux", RUNNER_TEMP: root,
    MODEX_APT_TEST_LOG: log, MODEX_APT_TEST_SCENARIO: scenario, ...overrides,
  } });
  assert.ifError(result.error);
  const calls = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x)) : [];
  return { ...result, calls, root };
}

test("host preparation uses signed official Noble indexes for every required package when the image mirror is unavailable", t => {
  const r = run(t);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map(c => c.verb), ["update", "install"]);
  assert.equal(r.calls[0].source, r.calls[1].source);
  for (const c of r.calls) {
    assert.ok(c.source.startsWith(r.root + path.sep));
    assert.match(c.sources, /URIs: https:\/\/archive\.ubuntu\.com\/ubuntu/);
    assert.match(c.sources, /Suites: noble noble-updates noble-backports noble-security/);
    assert.doesNotMatch(c.sources, /security\.ubuntu\.com/);
    assert.equal((c.sources.match(/Signed-By: \/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/g) ?? []).length, 1);
    assert.ok(c.parts.startsWith(r.root + path.sep));
    assert.deepEqual(c.partsEntries, []);
    const options = new Map(c.args.filter(x => x.includes("=")).map(x => [x.slice(0, x.indexOf("=")).toLowerCase(), x.slice(x.indexOf("=") + 1)]));
    assert.ok(Number(options.get("acquire::retries")) >= 0 && Number(options.get("acquire::retries")) <= 1);
    for (const kind of ["http", "https"]) assert.ok(Number(options.get(`acquire::${kind}::timeout`)) > 0 && Number(options.get(`acquire::${kind}::timeout`)) <= 30);
    assert.ok(c.args.includes("APT::Update::Error-Mode=any"));
    assert.doesNotMatch(c.args.join(" ") + c.sources, /allow-unauthenticated|AllowInsecure|trusted=yes|Verify-Peer=false/i);
  }
  const install = r.calls[1].args;
  assert.deepEqual(install.slice(install.indexOf("install") + 1), ["-y", ...packages]);
  assert.equal(fs.existsSync(r.calls[0].source), false, "owned temporary source configuration is cleaned after use");
});

test("an index failure prevents package installation", t => {
  const r = run(t, "update-fails");
  assert.equal(r.status, 100);
  assert.deepEqual(r.calls.map(c => c.verb), ["update"]);
  assert.ok(r.calls[0].source);
  assert.equal(fs.existsSync(r.calls[0].source), false);
  assert.equal(fs.existsSync(r.calls[0].parts), false);
});

test("a package failure remains a failed preparation", t => {
  const r = run(t, "install-fails");
  assert.equal(r.status, 100);
  assert.deepEqual(r.calls.map(c => c.verb), ["update", "install"]);
  assert.ok(r.calls[0].source);
  assert.equal(fs.existsSync(r.calls[0].source), false);
  assert.equal(fs.existsSync(r.calls[0].parts), false);
});

test("host preparation refuses a non-CI invocation before privileged commands", t => {
  const r = run(t, "success", { GITHUB_ACTIONS: "false" });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, []);
});

test("host preparation refuses a release that does not match the KWallet5 runner", t => {
  const r = run(t, "success", {}, "resolute");
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, []);
});

test("host preparation refuses a non-Linux runner before privileged commands", t => {
  const r = run(t, "success", { RUNNER_OS: "Windows" });
  assert.notEqual(r.status, 0);
  assert.deepEqual(r.calls, []);
});

test("host preparation refuses missing or relative temporary directories before privileged commands", t => {
  for (const temporary of ["", "relative-temp"]) {
    const r = run(t, "success", { RUNNER_TEMP: temporary });
    assert.notEqual(r.status, 0);
    assert.deepEqual(r.calls, []);
  }
});

// The actual fc593e0 hosted attempt fetched archive indexes but failed DNS for security.
test("security updates remain signed and available through the official archive when the security host cannot resolve", t => {
  const r = run(t, "security-dns-fails");
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map(c => c.verb), ["update", "install"]);
  assert.match(r.calls[0].sources, /URIs: https:\/\/archive\.ubuntu\.com\/ubuntu/);
  assert.match(r.calls[0].sources, /Suites: noble noble-updates noble-backports noble-security/);
  assert.match(r.calls[0].sources, /Signed-By: \/usr\/share\/keyrings\/ubuntu-archive-keyring\.gpg/);
  assert.doesNotMatch(r.calls[0].sources, /security\.ubuntu\.com/);
  const install = r.calls[1].args;
  assert.deepEqual(install.slice(install.indexOf("install") + 1), ["-y", ...packages]);
});
