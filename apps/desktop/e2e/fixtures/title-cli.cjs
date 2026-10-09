// Deterministic provider boundary. The app still runs its real CLI adapters, runner, IPC and store.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const home = process.env.MODEX_HOME;
const codex = process.argv.includes("app-server");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const threads = new Map();
const pending = new Map();
let sequence = 0;

if (process.argv.includes("--version")) {
  console.log(path.basename(process.argv[1]).startsWith("codex") ? "codex-cli 0.160.0" : "2.1.288 (Claude Code)");
  process.exit(0);
}
if (process.argv.includes("auth") || process.argv.includes("login")) {
  console.log('{"loggedIn":true}');
  process.exit(0);
}

function run(text, cwd, complete, key) {
  const naming = path.basename(cwd).startsWith("modex-title-");
  fs.appendFileSync(path.join(home, "title-calls.jsonl"), JSON.stringify({ text, cwd, naming, argv: process.argv.slice(2) }) + "\n");
  if (!naming) return complete("Fixed cookie path handling.", false);
  const requestFile = path.join(home, "title-request.json");
  fs.writeFileSync(`${requestFile}.pending`, JSON.stringify({ text, cwd, argv: process.argv.slice(2) }));
  fs.renameSync(`${requestFile}.pending`, requestFile);
  const timer = setInterval(() => {
    const file = path.join(home, "title-response.json");
    if (!fs.existsSync(file)) return;
    clearInterval(timer);
    pending.delete(key);
    const response = JSON.parse(fs.readFileSync(file, "utf8"));
    complete(response.title, Boolean(response.fail));
    fs.writeFileSync(path.join(home, "title-finished"), "done");
  }, 10);
  pending.set(key, timer);
}

process.on("SIGTERM", () => {
  fs.writeFileSync(path.join(home, "title-cancelled"), "stopped");
  process.exit(0);
});

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (!codex) {
    if (message.type !== "user") return;
    const naming = path.basename(process.cwd()).startsWith("modex-title-");
    const session_id = naming ? "title-session" : "coding-session";
    send({ type: "system", subtype: "init", session_id });
    run(message.message.content, process.cwd(), (text, fail) => {
      send({ type: "assistant", message: { content: [{ type: "text", text }] } });
      send({ type: "result", subtype: fail ? "error" : "success", is_error: fail, session_id });
    }, session_id);
    return;
  }
  const p = message.params ?? {};
  const result = (value) => send({ id: message.id, result: value });
  const completed = (status) => send({ method: "turn/completed", params: { threadId: p.threadId, turn: { id: "turn", status } } });
  if (message.method === "initialize") result({ userAgent: "title-fixture" });
  if (message.method === "model/list") result({ data: [{ id: "fixture", model: "fixture", displayName: "Fixture", isDefault: true }], nextCursor: null });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    const id = p.threadId ?? `thread-${++sequence}`;
    threads.set(id, p.cwd);
    result({ thread: { id } });
  }
  if (message.method === "turn/start") {
    result({ turn: { id: "turn" } });
    run(p.input.map((item) => item.text ?? "").join(""), threads.get(p.threadId), (text, fail) => {
      send({ method: "item/completed", params: { threadId: p.threadId, item: { id: "answer", type: "agentMessage", text, phase: "final_answer" } } });
      completed(fail ? "failed" : "completed");
    }, p.threadId);
  }
  if (message.method === "turn/interrupt") {
    clearInterval(pending.get(p.threadId));
    pending.delete(p.threadId);
    result({});
    completed("interrupted");
    fs.writeFileSync(path.join(home, "title-cancelled"), "stopped");
  }
}).on("close", () => process.exit(0));
