#!/usr/bin/env node
// Turns raw CLI captures into the committed fixtures in this folder. Usage:
//
//   node sanitize.mjs claude <raw.jsonl> <out.jsonl> <capture cwd>
//   node sanitize.mjs codex  <raw.jsonl> <out.jsonl> <capture cwd>
//   node sanitize.mjs codex-protocol <codex_app_server_protocol.v2.schemas.json> <out.json> <codex version>
//
// What it keeps: every line Modex's adapters read, byte for byte apart from the replacements below.
// What it removes or replaces:
// - the capture directory and the home directory (paths become /fixture/project and /Users/user);
// - Claude's opaque thinking signatures (OPAQUE-SIGNATURE-REMOVED), which Modex must never show;
// - Claude `rate_limit_event` lines and the account, tool, plugin, MCP and skill inventory in
//   `system/init` (only the fields Modex reads stay);
// - Codex lines about the local MCP servers, hooks, config warnings, account and rate limits, and
//   the JSON-RPC replies to the capture driver's own requests (the test's fake server answers those).
import fs from "node:fs";

const [mode, input, output, arg] = process.argv.slice(2);
if (!mode || !input || !output || !arg) {
  console.error("usage: sanitize.mjs claude|codex <raw.jsonl> <out.jsonl> <capture cwd> | codex-protocol <schema.json> <out.json> <version>");
  process.exit(2);
}

const SIGNATURE = "OPAQUE-SIGNATURE-REMOVED";
const home = process.env.HOME ?? "/Users/user";

function scrub(text, cwd) {
  return text.split(cwd).join("/fixture/project").split(cwd.replace(/^\/private/, "")).join("/fixture/project").split(home).join("/Users/user");
}

function claude(lines, cwd) {
  const out = [];
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (msg.type === "rate_limit_event") continue;
    if (msg.type === "system" && msg.subtype === "init") {
      const keep = ["type", "subtype", "session_id", "uuid", "cwd", "model", "permissionMode", "apiKeySource", "claude_code_version", "fast_mode_state", "fast_mode_disabled_reason"];
      out.push(Object.fromEntries(keep.filter((k) => k in msg).map((k) => [k, msg[k]])));
      continue;
    }
    if (msg.type === "stream_event" && msg.event?.delta?.type === "signature_delta") msg.event.delta.signature = SIGNATURE;
    if (msg.type === "stream_event" && msg.event?.content_block?.signature) msg.event.content_block.signature = SIGNATURE;
    for (const block of msg.message?.content ?? []) {
      if (block && typeof block === "object" && "signature" in block) block.signature = SIGNATURE;
      if (block && typeof block === "object" && block.type === "redacted_thinking") block.data = SIGNATURE;
    }
    out.push(msg);
  }
  return out.map((m) => scrub(JSON.stringify(m), cwd));
}

const CODEX_KEEP = /^(thread\/started|thread\/status\/changed|turn\/started|turn\/completed|item\/|serverRequest\/resolved|error$|thread\/tokenUsage\/updated)/;

function codex(lines, cwd) {
  const out = [];
  for (const line of lines) {
    const msg = JSON.parse(line);
    if (!msg.method) continue; // replies to the driver's requests
    if (!CODEX_KEEP.test(msg.method)) continue;
    out.push(scrub(JSON.stringify(msg), cwd));
  }
  return out;
}

function protocol(schemaPath, version) {
  const defs = JSON.parse(fs.readFileSync(schemaPath, "utf8")).definitions;
  const enumOf = (name) => {
    const d = defs[name];
    if (d.enum) return d.enum;
    return d.oneOf.flatMap((o) => o.enum ?? []);
  };
  const fields = (name) => ({ required: defs[name].required, properties: Object.keys(defs[name].properties) });
  return {
    source: `codex app-server generate-json-schema (codex-cli ${version}); excerpt of codex_app_server_protocol.v2.schemas.json`,
    enums: Object.fromEntries(["MessagePhase", "TurnStatus", "CommandExecutionStatus", "PatchApplyStatus", "McpToolCallStatus", "DynamicToolCallStatus", "CollabAgentToolCallStatus"].map((n) => [n, enumOf(n)])),
    notifications: Object.fromEntries(["AgentMessageDeltaNotification", "ReasoningSummaryTextDeltaNotification", "ReasoningTextDeltaNotification", "ReasoningSummaryPartAddedNotification", "ItemStartedNotification", "ItemCompletedNotification", "TurnCompletedNotification"].map((n) => [n, fields(n)])),
  };
}

if (mode === "codex-protocol") {
  fs.writeFileSync(output, JSON.stringify(protocol(input, arg), null, 2) + "\n");
} else {
  const lines = fs.readFileSync(input, "utf8").split("\n").filter((l) => l.trim());
  const out = mode === "claude" ? claude(lines, arg) : mode === "codex" ? codex(lines, arg) : null;
  if (!out) { console.error(`unknown mode ${mode}`); process.exit(2); }
  fs.writeFileSync(output, out.join("\n") + "\n");
}
