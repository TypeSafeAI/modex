import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { Store } from "../../../desktop/dist/src/main/engine/store.js";
import { ThreadRunner } from "../../../desktop/dist/src/main/engine/runner.js";
import { CompanionServer } from "../../../desktop/dist/src/main/engine/companion.js";
import { LocalItems } from "../../../desktop/dist/src/main/engine/backends/local-items.js";

// The job log is the only record of this process. In CI runs 38707861067, 38832248437 and 38848571338
// it left a delivered /resume, a snapshot request and a TLS ClientHello unanswered for 5–10 s or more
// while otherwise idle. Log what the phone asked for, and every event-loop stall of a second or more
// with what the process did meanwhile: CPU time means our own work, major faults paging, neither a
// starved process.
const log = (message) => process.stderr.write(`[fixture ${new Date().toISOString()}] ${message}\n`);
let lastTick = performance.now();
let lastUsage = process.resourceUsage();
setInterval(() => {
  const now = performance.now();
  const usage = process.resourceUsage();
  const late = now - lastTick - 250;
  if (late >= 1000) {
    const delta = (key) => usage[key] - lastUsage[key];
    log(`event loop stalled ${Math.round(late)} ms: cpu ${Math.round((delta("userCPUTime") + delta("systemCPUTime")) / 1000)} ms, major faults ${delta("majorPageFault")}, involuntary switches ${delta("involuntaryContextSwitches")}, fs reads ${delta("fsRead")}, fs writes ${delta("fsWrite")}`);
  }
  lastTick = now;
  lastUsage = usage;
}, 250).unref();

const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-ios-e2e-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "modex-ios-e2e-repo-"));
const store = new Store(home);
const reconnect = process.env.MODEX_IOS_RECONNECT === "1";
if (reconnect && process.env.MODEX_IOS_LAN !== "1") throw new Error("The reconnect acceptance run requires MODEX_IOS_LAN=1 for Bonjour.");
let closing = false;
let restartTimer;
let restartTask;
let blocker;
let resumePausedMac;
const project = store.addProject(repo);
const emptyProjectPath = path.join(repo, "empty-project");
fs.mkdirSync(emptyProjectPath);
store.addProject(emptyProjectPath);
fs.mkdirSync(path.join(repo, ".codex", "skills", "mobile-check"), { recursive: true });
fs.writeFileSync(path.join(repo, ".codex", "skills", "mobile-check", "SKILL.md"), "---\nname: mobile-check\ndescription: Verify the mobile companion flow.\n---\n");
const threadId = "abcdef12";
store.addThread({ id: threadId, projectId: project.id, title: "Review launch changes", cwd: repo, backend: "mock", mode: "chat", model: "mock", plan: false, status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const backend = {
  id: "mock",
  async listModels() { return []; },
  async dispose() {},
  async runTurn(text, _opts, sink) {
    // Replies go through the typed observation path (docs/conversation-events.md), ids assigned here.
    const reply = new LocalItems(sink);
    if (text === "Prepare the change") {
      // As a native backend does (docs/human-requests.md): the decision counts once it is handed to the CLI.
      const native = { runtime: "ios-fixture", request: randomUUID() };
      const answer = await sink.approval({ question: "Apply the launch change?", detail: "One file in the test project", canAlways: false, action: { backend: "mock", tool: "apply_patch", title: "Apply launch change" }, native });
      let consumed = !sink.deliverRequest;
      await sink.deliverRequest?.(native, async () => { consumed = true; });
      reply.assistant(consumed && answer === "yes" ? "The launch change was approved." : "The launch change was denied.");
    } else {
      reply.assistant(`Follow-up received: ${text}`);
      if (text === "Pause for recovery") {
        restartTimer = setTimeout(() => { restartTask = pauseMac(); }, 1500);
      } else if (reconnect && text === "Please summarize the result") {
        restartTimer = setTimeout(() => { restartTask = restartMac(); }, 1500);
      } else if (reconnect && text === "Revoke this phone") {
        restartTimer = setTimeout(() => { server.resetAccess(); }, 1000);
      }
    }
    return { status: "completed" };
  },
};
const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { mock: backend } });
const server = new CompanionServer(home, {
  state: () => store.snapshot(),
  items: (id) => runner.items(id),
  status: (id) => runner.status(id),
  create: (projectId, options) => { log(`phone creates a thread in ${projectId}`); return runner.createThread(projectId, { ...options, backend: "mock", auto: false }); },
  send: async (id, text) => { log(`phone sends "${text}" to ${id}`); void runner.send(id, text); return { ok: true }; },
  answer: (id, itemId, answer) => { log(`phone answers ${itemId} with ${answer}`); runner.answer(id, itemId, answer); },
  setArchived: (id, archived) => runner.setArchived(id, archived),
}, process.env.MODEX_IOS_LAN === "1" ? undefined : () => ["127.0.0.1"]);
await server.start();
void runner.send(threadId, "Prepare the change");
while (runner.status(threadId) !== "waiting") await new Promise((resolve) => setTimeout(resolve, 20));
// The test owns the outage duration: a loaded simulator may still be in the rescan
// sheet after 25 seconds. Keep the Mac paused until cancellation has been verified.
const resumePath = `/resume/${randomUUID()}`;
const control = http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== resumePath) {
    response.writeHead(404).end();
    return;
  }
  log(`resume requested${resumePausedMac ? "" : " while not paused"}`);
  if (!resumePausedMac) {
    response.writeHead(409).end();
    return;
  }
  const resume = resumePausedMac;
  resumePausedMac = undefined;
  resume();
  try {
    await restartTask;
    log("resumed; answering 204");
    response.writeHead(204).end();
  } catch (error) {
    log(`resume failed: ${error}`);
    response.writeHead(500).end();
  }
});
await new Promise((resolve) => control.listen(0, "127.0.0.1", resolve));
const resumeURL = `http://127.0.0.1:${control.address().port}${resumePath}`;
fs.writeFileSync(process.argv[2], JSON.stringify({ link: server.status().pairingUri, reconnect, resumeURL }));

async function pauseMac() {
  const resumed = new Promise((resolve) => { resumePausedMac = resolve; });
  log("pausing the companion");
  await server.dispose();
  log("companion paused");
  await resumed;
  resumePausedMac = undefined;
  if (!closing) await server.start();
  if (!closing) log(`companion listening again on ${server.status().port}`);
}

async function restartMac() {
  const status = server.status();
  const data = JSON.parse(Buffer.from(new URL(status.pairingUri).searchParams.get("data"), "base64url").toString());
  await server.dispose();
  if (closing) return;
  // Occupy the original port so only Bonjour can reconnect the saved pairing.
  // The client may reset its stalled TLS socket while moving to the new endpoint.
  blocker = net.createServer((socket) => { socket.on("error", () => {}); });
  await new Promise((resolve) => blocker.listen(status.port, new URL(data.url).hostname, resolve));
  await new Promise((resolve) => setTimeout(resolve, 4000));
  if (closing) return;
  await server.start();
  store.updateThread(threadId, { title: "Reconnected to your Mac" });
}

async function close() {
  closing = true;
  clearTimeout(restartTimer);
  resumePausedMac?.();
  await restartTask;
  await new Promise((resolve) => control.close(resolve));
  await server.stop();
  if (blocker?.listening) await new Promise((resolve) => blocker.close(resolve));
  await runner.dispose();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
