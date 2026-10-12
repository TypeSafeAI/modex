import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyMacUpdateBundle, type VerificationCommand } from "../src/main/engine/update-mac-verification.js";

const input = { runningApp: "/Applications/Modex.app", candidate: "/private/update/Modex.app", version: "0.0.11", arch: "arm64" as const };
function commands(overrides: { fail?: string; failSignature?: number; version?: string; bundle?: string; arch?: string; requirement?: string; gatekeeper?: string } = {}) {
  const calls: { file: string; args: readonly string[] }[] = [];
  let signatures = 0;
  const run: VerificationCommand = async (file, args) => {
    calls.push({ file, args });
    if (overrides.fail && file.endsWith(overrides.fail)) throw new Error("Verification unavailable");
    if (file.endsWith("codesign") && args.includes("--verify") && ++signatures === overrides.failSignature) throw new Error("Signature rejected");
    if (file.endsWith("codesign") && args.includes("--display")) return { stdout: overrides.requirement ?? 'designated => identifier "ai.typesafe.modex" and anchor apple generic', stderr: "" };
    if (file.endsWith("PlistBuddy")) {
      const key = args[1];
      return { stdout: key?.endsWith("CFBundleIdentifier") ? overrides.bundle ?? "ai.typesafe.modex" : key?.endsWith("CFBundleShortVersionString") ? overrides.version ?? "0.0.11" : "Modex", stderr: "" };
    }
    if (file.endsWith("lipo")) return { stdout: overrides.arch ?? "arm64", stderr: "" };
    if (file.endsWith("spctl")) return { stdout: "", stderr: overrides.gatekeeper ?? "accepted\nsource=Notarized Developer ID" };
    return { stdout: "", stderr: "" };
  };
  return { run, calls };
}

test("Mac update verifies trusted running app, candidate publisher, designated requirement, identity and notarization", async () => {
  const { run, calls } = commands();
  await verifyMacUpdateBundle(input, run);
  const signatures = calls.filter(c => c.file === "/usr/bin/codesign" && c.args.includes("--verify"));
  assert.equal(signatures.length, 3);
  assert.equal(signatures[0]!.args.at(-1), input.runningApp);
  assert.equal(signatures[1]!.args.at(-1), input.candidate);
  assert.equal(signatures[2]!.args.at(-1), input.candidate);
  assert.ok(signatures[0]!.args.includes('--all-architectures'));
  assert.ok(signatures[0]!.args.some(a => a.startsWith("=") && a.includes("9LR8Z8UQ9X") && a.includes("ai.typesafe.modex")));
  assert.ok(signatures[2]!.args.some(a => a.startsWith('=identifier "ai.typesafe.modex"')));
  assert.equal(calls.at(-1)!.file, "/usr/sbin/spctl");
});

test("Mac update rejects failed or unavailable native verification without fallback", async () => {
  for (const fail of ["codesign", "PlistBuddy", "lipo", "spctl"]) {
    const { run } = commands({ fail });
    await assert.rejects(verifyMacUpdateBundle(input, run), /Verification unavailable/);
  }
});

test("Mac update independently rejects candidate publisher and designated requirement failures", async () => {
  for (const failSignature of [2, 3]) {
    const { run, calls } = commands({ failSignature });
    await assert.rejects(verifyMacUpdateBundle(input, run), /Signature rejected/);
    assert.equal(calls.filter(c => c.args.includes("--verify")).length, failSignature);
    assert.equal(calls.at(-1)!.args.at(-1), input.candidate);
    assert.ok(calls.every(c => !c.file.endsWith("PlistBuddy") && !c.file.endsWith("spctl")));
  }
});

test("Mac update accepts matching Intel and universal executable architectures", async () => {
  await verifyMacUpdateBundle({ ...input, arch: "x64" }, commands({ arch: "x86_64" }).run);
  for (const arch of ["arm64", "x64"] as const) {
    await verifyMacUpdateBundle({ ...input, arch }, commands({ arch: "x86_64 arm64" }).run);
  }
});

test("Mac update rejects wrong identity, version, architecture, requirement and notarization policy", async () => {
  for (const overrides of [
    { version: "0.0.10" }, { bundle: "other.app" }, { arch: "x86_64" },
    { requirement: "" }, { requirement: "designated => first\ndesignated => second" },
    { gatekeeper: "accepted\nsource=Mac App Store" },
  ]) await assert.rejects(verifyMacUpdateBundle(input, commands(overrides).run));
});

test("Mac update refuses unbounded or invalid input before invoking native commands", async () => {
  const { run, calls } = commands();
  await assert.rejects(verifyMacUpdateBundle({ ...input, candidate: "relative.app" }, run));
  await assert.rejects(verifyMacUpdateBundle({ ...input, version: "0.0.11-beta.1" }, run));
  await assert.rejects(verifyMacUpdateBundle({ ...input, runningApp: "/" + "x".repeat(5000) }, run));
  assert.deepEqual(calls, []);
});
