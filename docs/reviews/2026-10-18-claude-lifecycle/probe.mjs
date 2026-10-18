// Live probe of claude -p stream-json lifecycle. Usage: node probe.mjs <bin> <scenario> <outfile>
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const [bin, scenario, out] = process.argv.slice(2);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "modex-cf2-probe-"));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE|^ANTHROPIC/.test(k)));
const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio", "--permission-mode", "default", "--model", "haiku", "--effort", "low"];
const t0 = Date.now();
const log = [];
const rec = (dir, o) => { const e = { t: Date.now() - t0, dir, ...o }; log.push(e); };
const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const seen = [];
const waiters = [];
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { rec("out-raw", { line }); continue; }
    const brief = { type: msg.type, subtype: msg.subtype ?? msg.request?.subtype ?? msg.response?.subtype, request_id: msg.request_id ?? msg.response?.request_id, ev: msg.event?.type, delta: msg.event?.delta?.type, is_error: msg.is_error, num_turns: msg.num_turns, result: typeof msg.result === "string" ? msg.result.slice(0, 120) : undefined, content: msg.message?.content?.map((b) => b.type + (b.type === "text" ? ":" + b.text.slice(0, 60) : b.type === "tool_result" ? ":" + JSON.stringify(b.content).slice(0, 100) + (b.is_error ? ":ERR" : "") : b.type === "tool_use" ? ":" + b.name : "")), caps: msg.capabilities, version: msg.claude_code_version, response: msg.response?.response, error: msg.response?.error, stop_reason: msg.stop_reason, terminal_reason: msg.terminal_reason, errors: msg.errors };
    for (const k of Object.keys(brief)) if (brief[k] === undefined) delete brief[k];
    if (msg.type === "stream_event" && !["message_start", "message_stop"].includes(msg.event?.type) && msg.event?.delta?.type !== "text_delta") continue;
    rec("out", brief);
    seen.push(msg);
    for (const w of [...waiters]) if (w.pred(msg)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(msg); }
  }
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });
const exited = new Promise((r) => child.on("close", (code, sig) => { rec("exit", { code, sig }); r(); }));
const send = (o) => { rec("in", { type: o.type, subtype: o.request?.subtype ?? o.response?.subtype, request_id: o.request_id ?? o.response?.request_id }); child.stdin.write(JSON.stringify(o) + "\n"); };
const until = (pred, ms = 60000) => new Promise((resolve, reject) => { const hit = seen.find(pred); if (hit) return resolve(hit); const w = { pred, resolve }; waiters.push(w); setTimeout(() => reject(new Error("timeout waiting")), ms); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const user = (text) => send({ type: "user", message: { role: "user", content: text } });
const interrupt = (id) => send({ type: "control_request", request_id: id, request: { subtype: "interrupt" } });
try {
  if (scenario === "pending-approval") {
    user("Use the Bash tool to run exactly: sleep 20 && touch probe-done.txt. Do not write anything before calling the tool.");
    const req = await until((m) => m.type === "control_request" && m.request?.subtype === "can_use_tool");
    await sleep(300);
    interrupt("int-1");
    await sleep(4000);
    // A late answer to the (possibly withdrawn) request.
    send({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response: { behavior: "allow", updatedInput: req.request.input } } });
    await sleep(2000);
  } else if (scenario === "streaming") {
    user("Write a 400-word story about a lighthouse. No tools.");
    await until((m) => m.type === "stream_event" && m.event?.delta?.type === "text_delta");
    await sleep(400);
    interrupt("int-1");
    await sleep(4000);
  } else if (scenario === "running-tool") {
    user("Use the Bash tool to run exactly: sleep 20 && touch probe-done.txt. Do not write anything before calling the tool.");
    const req = await until((m) => m.type === "control_request" && m.request?.subtype === "can_use_tool");
    send({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response: { behavior: "allow", updatedInput: req.request.input } } });
    await sleep(2500);
    interrupt("int-1");
    await sleep(5000);
  } else if (scenario === "idle") {
    user("Reply with the single word: pong");
    await until((m) => m.type === "result");
    await sleep(300);
    interrupt("int-1");
    await sleep(2000);
  } else if (scenario === "interrupt-eof-tool") {
    user("Use the Bash tool to run exactly: sleep 20 && touch probe-done.txt. Do not write anything before calling the tool.");
    const req = await until((m) => m.type === "control_request" && m.request?.subtype === "can_use_tool");
    send({ type: "control_response", response: { subtype: "success", request_id: req.request_id, response: { behavior: "allow", updatedInput: req.request.input } } });
    await sleep(2500);
    interrupt("int-1");
    rec("in", { type: "stdin-end" }); child.stdin.end();
    await Promise.race([exited, sleep(15000)]);
  } else if (scenario === "interrupt-eof-stream") {
    user("Write a 400-word story about a lighthouse. No tools.");
    await until((m) => m.type === "stream_event" && m.event?.delta?.type === "text_delta");
    await sleep(400);
    interrupt("int-1");
    rec("in", { type: "stdin-end" }); child.stdin.end();
    await Promise.race([exited, sleep(15000)]);
  } else if (scenario === "eof-midturn") {
    user("Write a 300-word story about a lighthouse. No tools.");
    await until((m) => m.type === "stream_event" && m.event?.delta?.type === "text_delta");
    rec("in", { type: "stdin-end" });
    child.stdin.end();
    await Promise.race([exited, sleep(30000)]);
  }
} catch (e) { rec("error", { message: e.message }); }
if (child.exitCode === null && child.signalCode === null) { rec("in", { type: "stdin-end" }); child.stdin.end(); }
const closeStart = Date.now();
await Promise.race([exited, sleep(10000)]);
if (child.exitCode === null && child.signalCode === null) { rec("in", { type: "SIGTERM" }); child.kill("SIGTERM"); await Promise.race([exited, sleep(5000)]); }
rec("summary", { exitAfterStdinEndMs: Date.now() - closeStart, stderrTail: stderr.slice(-600) });
fs.writeFileSync(out, JSON.stringify({ bin, scenario, args, log }, null, 1));
fs.rmSync(cwd, { recursive: true, force: true });
console.log(log.map((e) => JSON.stringify(e)).join("\n"));
