import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

// The complete canary tree inherits network denial; Codex uses its documented externalSandbox mode.
export const LOOPBACK_ONLY_POLICY = '(version 1)\n(allow default)\n(deny network*)\n(allow network-inbound (local ip "localhost:*"))\n(allow network-outbound (remote ip "localhost:*"))\n';

export function offlineSandboxPolicy(root, cache) {
  for (const directory of [root, cache]) {
    if (!path.isAbsolute(directory) || directory === path.parse(directory).root) throw new Error("A sandbox write root must be a bounded absolute directory.");
  }
  return LOOPBACK_ONLY_POLICY + `(deny file-write*)\n(allow file-write* (subpath ${JSON.stringify(root)}) (subpath ${JSON.stringify(cache)}) (literal "/dev/null"))\n`;
}

/** Run once outside the sandbox, before any native/model work. No model is loaded or contacted. */
export function prepareOfflineSandbox(report) {
  if (fs.lstatSync(report).isSymbolicLink()) throw new Error("Sandbox evidence must be a real directory.");
  const root = fs.realpathSync(report);
  const cache = fs.realpathSync(execFileSync("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8" }).trim());
  const policy = offlineSandboxPolicy(root, cache), profile = path.join(root, "loopback-only.sb");
  const temporary = path.join(root, "tmp"); fs.mkdirSync(temporary, { mode: 0o700 });
  const outsideProbe = path.join(path.dirname(root), `.${path.basename(root)}-outside-${randomUUID()}`);
  // Positive control: this same account can write here before the host profile is installed.
  fs.writeFileSync(outsideProbe, "ordinary write control\n", { flag: "wx", mode: 0o600 }); fs.unlinkSync(outsideProbe);
  const boundaryId = "sha256:" + createHash("sha256").update(policy).digest("hex");
  fs.writeFileSync(profile, policy, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(path.join(root, "sandbox.json"), JSON.stringify({ root, cache, outsideProbe, outsideWriteControl: "succeeded", boundaryId }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return { profile, env: { TMPDIR: temporary }, boundaryId };
}

/** Verify the installed kernel boundary before telling Codex that sandboxing is already provided. */
export async function verifyOfflineSandbox(report) {
  const root = fs.realpathSync(report), metadata = JSON.parse(fs.readFileSync(path.join(root, "sandbox.json"), "utf8"));
  const profile = fs.readFileSync(path.join(root, "loopback-only.sb"), "utf8");
  const boundaryId = "sha256:" + createHash("sha256").update(profile).digest("hex");
  if (metadata.root !== root || metadata.boundaryId !== boundaryId || profile !== offlineSandboxPolicy(root, metadata.cache)
    || metadata.outsideWriteControl !== "succeeded" || path.dirname(metadata.outsideProbe) !== path.dirname(root)
    || !path.basename(metadata.outsideProbe).startsWith(`.${path.basename(root)}-outside-`)) throw new Error("The installed sandbox boundary receipt is missing or changed.");
  let writeProbe;
  try {
    fs.writeFileSync(metadata.outsideProbe, "must remain denied\n", { flag: "wx", mode: 0o600 });
    fs.unlinkSync(metadata.outsideProbe); writeProbe = "allowed";
  } catch (error) { writeProbe = error.code ?? error.message; }
  if (!["EPERM", "EACCES"].includes(writeProbe)) throw new Error(`The host sandbox did not deny an outside write: ${writeProbe}`);
  const externalProbe = await new Promise(resolve => {
    const socket = net.connect({ host: "192.0.2.1", port: 443 });
    const settle = value => { socket.destroy(); resolve(value); };
    socket.once("connect", () => settle("connected")); socket.once("error", error => settle(error.code ?? error.message)); socket.setTimeout(2000, () => settle("timed-out"));
  });
  if (!["EPERM", "EACCES"].includes(externalProbe)) throw new Error(`The host sandbox did not deny external TCP: ${externalProbe}`);
  return { hostSandbox: { type: "externalSandbox", networkAccess: "restricted", boundaryId }, externalProbe, writeProbe };
}
