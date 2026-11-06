// Opt-in macOS qualification only. Starts its own Ollama on a fresh loopback port;
// never changes the person's server, downloads weights or edits global Codex settings.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { LOOPBACK_ONLY_POLICY } from "./local-model-network-policy.mjs";

const script = fileURLToPath(import.meta.url);
const appDir = path.dirname(path.dirname(script));
const inside = process.argv[2] === "--inside";
const model = process.argv[inside ? 3 : 2];
const destination = process.argv[inside ? 4 : 3];
if (process.platform !== "darwin" || !model || !destination || !path.isAbsolute(destination)) {
  throw new Error("Usage on macOS: node scripts/local-model-offline.mjs <approved-installed-model> <absolute-evidence-directory>");
}
const report = path.resolve(destination);
fs.mkdirSync(report, { recursive: true, mode: 0o700 });
const policy = LOOPBACK_ONLY_POLICY;
if (!inside) {
  const evidence = fs.lstatSync(report);
  if (!evidence.isDirectory() || evidence.isSymbolicLink() || fs.readdirSync(report).length !== 0) {
    throw new Error("Choose a new empty evidence directory. Earlier receipts and linked destinations were preserved; no runtime was contacted.");
  }
  const listing = await fetch("http://127.0.0.1:11434/api/tags", { redirect: "error", signal: AbortSignal.timeout(5000) }).then(r => r.json());
  const installed = listing.models?.find(m => m.name === model);
  if (typeof installed?.digest !== "string" || !installed.digest) throw new Error("The exact approved model must already be installed with a recorded digest. This canary never downloads one.");
  fs.writeFileSync(path.join(report, "model.json"), JSON.stringify(installed, null, 2) + "\n");
  const profile = path.join(report, "loopback-only.sb"); fs.writeFileSync(profile, policy);
  const result = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, script, "--inside", model, report], {
    cwd: appDir, env: process.env, encoding: "utf8", timeout: 1_300_000, maxBuffer: 8 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(report, "launcher.log"), `${result.stdout ?? ""}${result.stderr ?? ""}`);
  if (result.status !== 0) {
    if (!fs.existsSync(path.join(report, "offline.json"))) fs.writeFileSync(path.join(report, "offline.json"), JSON.stringify({ status: "failed-before-canary", exitCode: result.status, signal: result.signal, error: result.error?.message }, null, 2) + "\n");
    process.exitCode = 1;
  }
} else {
  const receipt = { status: "running", model, policy, platform: `${os.release()} ${os.arch()}`, hardware: execFileSync("sysctl", ["-n", "machdep.cpu.brand_string"], { encoding: "utf8" }).trim(),
    sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: appDir, encoding: "utf8" }).trim(), contextTokens: 65536 };
  let server;
  try {
    const approved = JSON.parse(fs.readFileSync(path.join(report, "model.json"), "utf8"));
    if (approved.name !== model || typeof approved.digest !== "string" || !approved.digest) throw new Error("The approved model name and digest receipt is missing or invalid.");
    receipt.approvedModelDigest = approved.digest;
    receipt.observedModelDigests = {};
    const requireApprovedDigest = (listed, phase) => {
      const digest = typeof listed?.digest === "string" ? listed.digest : null;
      receipt.observedModelDigests[phase] = digest;
      if (digest !== approved.digest) throw new Error(`Owned model digest ${phase} the native task does not match the approved digest.`);
    };
    receipt.externalProbe = await new Promise(resolve => {
      const socket = net.connect({ host: "192.0.2.1", port: 443 });
      const settle = value => { socket.destroy(); resolve(value); };
      socket.once("connect", () => settle("connected"));
      socket.once("error", error => settle(error.code ?? error.message));
      socket.setTimeout(2000, () => settle("timed-out"));
    });
    if (!["EPERM", "EACCES"].includes(receipt.externalProbe)) throw new Error(`External denial was not demonstrated: ${receipt.externalProbe}`);
    const reservation = net.createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
    const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    receipt.url = `http://127.0.0.1:${port}`;
    const log = fs.openSync(path.join(report, "ollama.log"), "w", 0o600);
    server = spawn("ollama", ["serve"], { env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: path.join(os.homedir(), ".ollama", "models"), OLLAMA_CONTEXT_LENGTH: "65536" }, stdio: ["ignore", log, log] });
    fs.closeSync(log);
    const deadline = Date.now() + 20_000;
    while (true) {
      if (server.exitCode !== null) throw new Error(`Owned Ollama exited: ${server.exitCode}`);
      let listed;
      try {
        const listing = await fetch(`${receipt.url}/api/tags`, { redirect: "error", signal: AbortSignal.timeout(1000) }).then(r => r.json());
        listed = listing.models?.find(m => m.name === model);
        if (!listed) throw new Error("Owned server cannot list the approved model");
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      requireApprovedDigest(listed, "before");
      break;
    }
    receipt.ownedServerPid = server.pid;
    const checked = spawnSync(process.execPath, ["--test", "--test-force-exit", "--test-name-pattern=AC1: a person", "dist/test/local-codex-native.test.js"], {
      cwd: appDir, env: { ...process.env, MODEX_LM3_LIVE: "1", MODEX_LM3_URL: `${receipt.url}/v1`, MODEX_LM3_MODEL: model, MODEX_LM3_CONTEXT: "65536", MODEX_LM3_REPORT: path.join(report, "native") },
      encoding: "utf8", timeout: 1_220_000, maxBuffer: 8 * 1024 * 1024,
    });
    fs.writeFileSync(path.join(report, "native.log"), `${checked.stdout ?? ""}${checked.stderr ?? ""}`);
    receipt.exitCode = checked.status;
    const listing = await fetch(`${receipt.url}/api/tags`, { redirect: "error", signal: AbortSignal.timeout(1000) }).then(r => r.json());
    requireApprovedDigest(listing.models?.find(m => m.name === model), "after");
    receipt.status = checked.status === 0 ? "passed" : "failed";
    if (checked.status !== 0) process.exitCode = 1;
  } catch (error) { receipt.status = "failed"; receipt.error = error.message; process.exitCode = 1; }
  finally {
    if (server && server.exitCode === null) {
      const exited = once(server, "exit"); server.kill("SIGTERM");
      const force = setTimeout(() => server.kill("SIGKILL"), 5000);
      await exited; clearTimeout(force);
    }
    fs.writeFileSync(path.join(report, "offline.json"), JSON.stringify(receipt, null, 2) + "\n");
  }
}
