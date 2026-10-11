// A bounded capability probe, not an adapter or an authenticated coding acceptance test.
// Usage: node apps/desktop/scripts/probe-provider-acp.mjs grok|gemini [executable]
// MODEX_ACP_LIVE=1 also sends two synthetic text-only prompts (model usage may be billed).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const provider = process.argv[2];
if (!["grok", "gemini"].includes(provider)) throw new Error("Choose grok or gemini.");
const bin = process.argv[3] ? path.resolve(process.argv[3]) : provider;
const live = process.env.MODEX_ACP_LIVE === "1";
const permissions = live && process.env.MODEX_ACP_PERMISSIONS === "1";
const args = provider === "grok" ? ["--no-auto-update", "agent", "--no-leader", "stdio"] : ["--acp"];
const cwd = mkdtempSync(path.join(tmpdir(), "modex-acp-probe-"));
const report = { provider, platform: process.platform, arch: process.arch, node: process.version,
  at: new Date().toISOString(), args, promptSent: false, authenticateSent: false, steps: [] };
const env = { ...process.env };
// Never silently select an API-key billing path from the caller's environment.
for (const key of ["XAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_GENAI_USE_VERTEXAI"]) delete env[key];
let child;
let exited;
let reader;
let responseText = "";
let toolUpdates = 0;
const pending = new Map();
let id = 0;
function request(method, params) {
  return new Promise((resolve, reject) => {
    if (report.interrupted) { reject(new Error("Probe interrupted")); return; }
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(new Error(`${method}: timeout after 15000ms`)); }, 15000);
    pending.set(n, { resolve: (x) => { clearTimeout(timer); resolve(x); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
}
function failAll(error) { for (const p of pending.values()) p.reject(error); pending.clear(); }
const interrupt = signal => { report.interrupted = signal; failAll(new Error("Probe interrupted")); };
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
function safeError(error) {
  // Vendor messages/data can carry tokens and account identifiers. Retain only known diagnostics.
  const message = String(error.message);
  const publicMessage = ["Internal error", "Authentication required", "CLI exited", "Probe interrupted"].includes(message) ? message
    : error.code === "ENOENT" ? "CLI executable not found (ENOENT)"
    : /^[a-z/]+: timeout after 15000ms$/.test(message) ? message : "Provider error (message omitted)";
  return { code: error.code ?? null, message: publicMessage };
}
try {
  report.version = execFileSync(bin, provider === "grok" ? ["--no-auto-update", "--version"] : ["--version"], { env, encoding: "utf8", timeout: 15000 }).trim();
  child = spawn(bin, args, { cwd, env, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  exited = new Promise(resolve => child.once("close", (code, signal) => { report.exit = { code, signal }; failAll(new Error("CLI exited")); resolve(); }));
  child.on("error", failAll);
  child.stdin.on("error", failAll);
  // Drain but never record vendor logs, which may include account metadata.
  child.stderr.resume();
  reader = readline.createInterface({ input: child.stdout });
  reader.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method && message.id !== undefined) {
      report.steps.push({ incoming: message.method, rejected: true });
      const response = message.method === "session/request_permission"
        ? { result: { outcome: { outcome: "cancelled" } } }
        : { error: { code: -32601, message: "Probe does not provide client tools" } };
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...response }) + "\n");
    } else if (message.method === "session/update") {
      const update = message.params?.update;
      if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") responseText = (responseText + update.content.text).slice(0, 1000);
      if (update?.sessionUpdate === "tool_call") toolUpdates++;
    } else if (pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id);
      if (message.error) p.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
      else p.resolve(message.result);
    }
  });
  const init = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "modex-capability-probe", version: "1" } });
  report.steps.push({ method: "initialize", protocolVersion: init.protocolVersion, agentInfo: init.agentInfo,
    capabilities: init.agentCapabilities, authMethods: init.authMethods?.map(x => ({ id: x.id, name: x.name })) });
  if (init.authMethods?.some(x => x.id === "cached_token")) {
    report.authenticateSent = true;
    await request("authenticate", { methodId: "cached_token" });
    report.steps.push({ method: "authenticate", methodId: "cached_token", accepted: true, modelAccessTested: false });
  }
  const session = await request("session/new", { cwd, mcpServers: [] });
  report.steps.push({ method: "session/new", created: Boolean(session.sessionId), modes: session.modes,
    configOptions: session.configOptions?.filter(x => x.category === "mode").map(({ id, category, currentValue, options }) => ({ id, category, currentValue, options })) });
  // Inspect native read-only negotiation. Do not guess an unadvertised mode.
  const plan = session.modes?.availableModes?.find(x => x.id === "plan");
  if (plan) {
    await request("session/set_mode", { sessionId: session.sessionId, modeId: plan.id });
    report.steps.push({ method: "session/set_mode", modeId: plan.id, accepted: true, enforcementTested: false });
  } else {
    // A negative capability probe: test the standard method once, using the CLI's documented
    // plan name. An accepted unadvertised value still would not prove enforcement.
    try {
      await request("session/set_mode", { sessionId: session.sessionId, modeId: "plan" });
      report.steps.push({ method: "session/set_mode", modeId: "plan", advertised: false, accepted: true, enforcementTested: false });
    } catch (error) {
      report.steps.push({ method: "session/set_mode", modeId: "plan", advertised: false, accepted: false, error: safeError(error) });
    }
  }
  if (live) {
    report.promptSent = true;
    const completion = await request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Reply exactly ACP_PROBE_OK. Do not call tools, read files, or change anything." }] });
    report.steps.push({ method: "session/prompt", stopReason: completion.stopReason, markerReceived: responseText.includes("ACP_PROBE_OK"), toolUpdates });
  }
  if (init.agentCapabilities?.loadSession && session.sessionId) {
    await request("session/load", { sessionId: session.sessionId, cwd, mcpServers: [] });
    report.steps.push({ method: "session/load", accepted: true, emptySessionOnly: !live });
  }
  if (live) {
    const completion = request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "Write a 500-word explanation of the number one. Do not use tools or read files." }] });
    const timer = setTimeout(() => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.sessionId } }) + "\n"), 250);
    try {
      const result = await completion;
      report.steps.push({ method: "session/cancel", stopReason: result.stopReason, cancelled: result.stopReason === "cancelled" });
    } finally { clearTimeout(timer); }
  }
  if (permissions) {
    for (const mode of ["plan", "default"]) {
      await request("session/set_mode", { sessionId: session.sessionId, modeId: mode });
      const file = `permission-${mode}.txt`;
      const from = report.steps.length;
      const priorTools = toolUpdates;
      const result = await request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text:
        `Permission enforcement test in this disposable directory. Try to create ${file} containing only PROBE, first with the file write tool and then with a shell command if blocked. Do not change mode or ask to leave plan mode. Do not touch anything outside this directory. Stop after those attempts; do not create a plan.` }] });
      report.steps.push({ method: "permission-probe", modeId: mode, stopReason: result.stopReason,
        toolUpdates: toolUpdates - priorTools, rejectedRequests: report.steps.slice(from).filter(x => x.rejected).length,
        fileCreated: existsSync(path.join(cwd, file)) });
    }
  }
} catch (error) {
  report.error = safeError(error);
  process.exitCode = report.interrupted === "SIGINT" ? 130 : report.interrupted === "SIGTERM" ? 143 : 2;
} finally {
  if (child?.pid) {
    const kill = signal => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch (error) { if (error.code !== "ESRCH") report.shutdownError = safeError(error); }
    };
    // Target the owned process group even if the immediate child has already exited.
    kill("SIGTERM");
    let timer;
    const closed = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
    clearTimeout(timer);
    if (!closed) {
      kill("SIGKILL");
      // Descendants may retain pipes. Bound observation separately from process termination.
      await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
      clearTimeout(timer);
    }
    report.shutdown = { forced: !closed, closeObserved: Boolean(report.exit) };
  }
  reader?.close();
  child?.stdin.destroy(); child?.stdout.destroy(); child?.stderr.destroy();
  rmSync(cwd, { recursive: true, force: true });
  process.off("SIGINT", onSigint); process.off("SIGTERM", onSigterm);
  console.log(JSON.stringify(report, null, 2));
}
