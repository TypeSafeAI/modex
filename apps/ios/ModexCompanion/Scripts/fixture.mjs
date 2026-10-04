import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../../desktop/dist/src/main/engine/store.js";
import { ThreadRunner } from "../../../desktop/dist/src/main/engine/runner.js";
import { CompanionServer } from "../../../desktop/dist/src/main/engine/companion.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-ios-e2e-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "modex-ios-e2e-repo-"));
const store = new Store(home);
const project = store.addProject(repo);
const threadId = "abcdef12";
store.addThread({ id: threadId, projectId: project.id, title: "Review launch changes", cwd: repo, backend: "mock", mode: "chat", model: "mock", plan: false, status: "idle", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const backend = {
  id: "mock",
  async listModels() { return []; },
  async dispose() {},
  async runTurn(text, _opts, sink) {
    if (text === "Prepare the change") {
      const answer = await sink.approval({ question: "Apply the launch change?", detail: "One file in the test project", canAlways: false, action: { backend: "mock", tool: "apply_patch", title: "Apply launch change" } });
      sink.assistant(answer === "yes" ? "The launch change was approved." : "The launch change was denied.");
    } else sink.assistant(`Follow-up received: ${text}`);
    return { status: "completed" };
  },
};
const runner = new ThreadRunner({ home, store, emit: () => {}, backends: { mock: backend } });
const server = new CompanionServer(home, {
  state: () => store.snapshot(),
  items: (id) => runner.items(id),
  status: (id) => runner.status(id),
  send: async (id, text) => { void runner.send(id, text); return { ok: true }; },
  answer: (id, itemId, answer) => runner.answer(id, itemId, answer),
}, process.env.MODEX_IOS_LAN === "1" ? undefined : () => ["127.0.0.1"]);
await server.start();
void runner.send(threadId, "Prepare the change");
while (runner.status(threadId) !== "waiting") await new Promise((resolve) => setTimeout(resolve, 20));
fs.writeFileSync(process.argv[2], JSON.stringify({ link: server.status().pairingUri }));

async function close() {
  await server.stop();
  await runner.dispose();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
  process.exit(0);
}
process.once("SIGINT", () => { void close(); });
process.once("SIGTERM", () => { void close(); });
