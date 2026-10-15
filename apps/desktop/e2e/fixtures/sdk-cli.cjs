// The real SDK runs this local CLI fixture; no model or network is used.
const fs = require("node:fs");
const path = require("node:path");
const { handleControl } = require("./claude-sdk.cjs");
const home = process.env.MODEX_HOME;
const emit = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const log = (event) => fs.appendFileSync(path.join(home, "sdk-events.jsonl"), JSON.stringify(event) + "\n");
let prompt;
if (process.argv.includes("--version")) { console.log("2.1.301 (Claude Code)"); process.exit(0); }
if (process.argv.includes("auth")) { console.log('{"loggedIn":true}'); process.exit(0); }
const result = (interrupted = false) => emit({ type: "result", subtype: interrupted ? "error_during_execution" : "success", is_error: interrupted, errors: interrupted ? ["interrupted"] : [], session_id: "sdk-e2e", num_turns: 1 });
const reply = (text) => { emit({ type: "assistant", message: { content: [{ type: "text", text }] } }); result(); };
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (handleControl(message)) { log({ initialize: true }); return; }
  if (message.type === "control_request" && message.request.subtype === "interrupt") {
    log({ prompt, interrupt: true });
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    result(true);
    return;
  }
  if (message.type === "control_response") {
    log({ prompt, response: message.response });
    if (message.response.response?.behavior === "allow") {
      fs.writeFileSync(path.join(process.cwd(), "sdk-approved.txt"), "approved\n");
      emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "sdk-tool", content: "Created sdk-approved.txt" }] } });
      reply("Approved command completed.");
    }
    return;
  }
  if (message.type !== "user") return;
  prompt = message.message.content;
  emit({ type: "system", subtype: "init", session_id: "sdk-e2e", model: "fixture", permissionMode: "default" });
  if (prompt === "Fail locally") {
    process.stderr.write("fixture CLI failure\n");
    setTimeout(() => process.exit(7), 50);
    return;
  }
  if (prompt === "Stop locally") {
    emit({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Counting locally" } } });
    return;
  }
  if (prompt !== "Approve locally" && prompt !== "Withdraw locally") return reply("Local SDK acceptance");
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "sdk-tool", name: "Bash", input: { command: "echo approved > sdk-approved.txt" } }] } });
  emit({ type: "control_request", request_id: "permission", request: { subtype: "can_use_tool", tool_name: "Bash", tool_use_id: "sdk-tool", input: { command: "echo approved > sdk-approved.txt" } } });
  if (prompt === "Withdraw locally") {
    let withdrawn = false;
    const timer = setInterval(() => {
      if (!withdrawn && fs.existsSync(path.join(home, "withdraw"))) {
        withdrawn = true;
        emit({ type: "control_cancel_request", request_id: "permission" });
      }
      if (withdrawn && fs.existsSync(path.join(home, "finish-withdraw"))) {
        clearInterval(timer);
        reply("Withdrawn command was not executed.");
      }
    }, 20);
  }
}).on("close", () => { log({ prompt, stdinClosed: true }); process.exit(0); });
