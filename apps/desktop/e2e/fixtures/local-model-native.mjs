// Real transport for the existing opt-in disposable-home Electron bootstrap. Not packaged.
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { LocalExecution } from "../../dist/src/main/engine/local-models/execution.js";
import { cliSpawn } from "../../dist/src/main/engine/backends/health.js";
import { resolveCli } from "../../dist/src/main/engine/cli-path.js";
import { ALLOWED, MODEL, CONTEXT } from "./local-native-spec.mjs";
import { nativeQualification } from "./native-qualification-guard.mjs";

export function createNativeExecution(home, connections, runner) {
  const { cwd, origin } = nativeQualification({ home, enabled: process.env.MODEX_LM_NATIVE_E2E, e2e: process.env.MODEX_E2E, packaged: app.isPackaged });
  const bin = resolveCli("codex", "codex");
  const children = new Map();
  const events = [];
  let cloudCalls = 0;
  const record = event => {
    const value = { at: Date.now(), ...event }; events.push(value);
    fs.appendFileSync(path.join(home, "app/local-native-events.jsonl"), JSON.stringify(value) + "\n", { mode: 0o600 });
  };
  const observeLines = (direction, child) => {
    let buffer = "";
    return bytes => {
      buffer += bytes.toString();
      if (buffer.length > 1024 * 1024) throw new Error("Native qualification observer exceeded its bound.");
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.method) record({ type: "rpc", direction, pid: child.pid, method: frame.method, ...(frame.params?.threadId ? { threadId: frame.params.threadId } : {}), ...(frame.params?.turn?.status ? { turnStatus: frame.params.turn.status } : {}), ...(frame.method === "error" ? { willRetry: frame.params?.willRetry, error: frame.params?.error } : {}) });
        } catch { record({ type: "observer-error", direction, pid: child.pid }); }
      }
    };
  };
  const spawn = (executable, args, options) => {
    if (executable !== bin || args[0] !== "app-server" || !options.env?.HOME?.startsWith(path.join(home, "app/local-codex") + path.sep)) throw new Error("Refusing a non-owned native child.");
    const child = cliSpawn(executable, args, options);
    const row = { child, home: options.env.HOME, running: true }; children.set(child.pid, row);
    record({ type: "spawn", pid: child.pid, executable, home: row.home });
    const input = observeLines("out", child), write = child.stdin.write;
    child.stdin.write = function (bytes, ...rest) { input(bytes); return write.call(this, bytes, ...rest); };
    child.stdout.on("data", observeLines("in", child));
    child.once("exit", (code, signal) => { row.running = false; record({ type: "exit", pid: child.pid, code, signal }); });
    return child;
  };
  const execution = new LocalExecution(home, connections, bin, spawn);
  const validate = execution.validate.bind(execution);
  execution.validate = thread => {
    const target = validate(thread), connection = connections.resolve(target.model.connection);
    if (target.model.id !== MODEL || connection?.endpoint.origin !== origin || thread.localContextTokens !== CONTEXT || fs.realpathSync(thread.cwd) !== cwd) throw new Error("Native qualification refused an unapproved target.");
    return target;
  };
  const pending = () => [...runner.live].flatMap(([threadId, live]) => Object.values(live.requests.requests).filter(r => r.state === "pending" && r.request.kind === "approval" && live.pending.has(r.request.id)).map(r => r.request).map(r => ({ threadId, itemId: r.id,
    command: r.action?.tool === "command" ? String(r.action.input?.command ?? "") : "", cwd: r.action?.cwd,
    allowed: r.action?.tool === "command" && ALLOWED.includes(String(r.action.input?.command ?? "")) && r.action.cwd && fs.realpathSync(r.action.cwd) === cwd })));
  globalThis.__modexLocalNative = {
    snapshot: () => ({ kind: "real Codex and Ollama; test-only admission", executable: bin, cloudCalls, events: [...events], children: [...children].map(([pid, row]) => ({ pid, home: row.home, running: row.running })), pending: pending(),
      provenance: Object.fromEntries(runner.o.store.snapshot().threads.filter(t => t.localTarget).map(t => [t.id, execution.provenance(t.id)])) }),
    killCodex: pid => {
      const row = children.get(pid);
      if (!row || !row.running || row.child.exitCode !== null || row.child.signalCode) throw new Error("Native PID is no longer owned and running.");
      record({ type: "injected-codex-loss", pid }); return row.child.kill("SIGKILL");
    },
    cloudCalled: () => { cloudCalls++; record({ type: "forbidden-cloud-call" }); },
  };
  const answer = runner.answer.bind(runner);
  runner.answer = (threadId, itemId, decision, by) => {
    const request = pending().find(r => r.threadId === threadId && r.itemId === itemId);
    if (decision !== "no" && !request?.allowed) throw new Error("Native qualification refuses approval outside its exact command allowlist.");
    record({ type: "approval", threadId, itemId, decision, command: request?.command ?? "" });
    return answer(threadId, itemId, decision, by);
  };
  return execution;
}
