/** Shared scripted app-server for integration tests. This never represents real-model evidence. */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { LocalExecution } from "../src/main/engine/local-models/execution.js";
import { FakeProcess, fakeSpawn } from "./fakeproc.js";
import { effectiveConfiguration } from "./local-codex-configuration.js";
let generation = 0;
const node = process.env.MODEX_E2E_NODE ?? process.execPath;
export const localWorkflowSpawn: ConstructorParameters<typeof LocalExecution>[3] = (bin, args, opts) => {
    const proc = new FakeProcess();
    const native = `fixture-${++generation}`;
    let cwd = "", turn = "", command = "";
    let child: import("node:child_process").ChildProcess | undefined;
    let sequence = 0;
    const emit = (method: string, params: Record<string, unknown>) => proc.emitLine({ method, params: { threadId: native, ...params } });
    const finish = (status: "completed" | "interrupted", output = "", exitCode: number | null = null) => {
      emit("item/completed", { turnId: turn, item: { id: command, type: "commandExecution", command: "node fixture-check.cjs", cwd, status: status === "interrupted" ? "interrupted" : "completed", aggregatedOutput: output, exitCode } });
      if (status === "completed") emit("item/completed", { turnId: turn, item: { id: `answer-${turn}`, type: "agentMessage", text: "Fixture task completed; inspect the actual file and check result.", phase: "final" } });
      emit("turn/completed", { turn: { id: turn, status } });
    };
    proc.stdin.on("data", bytes => {
      for (const line of bytes.toString().trim().split("\n")) {
        const message = JSON.parse(line);
        const reply = (result: unknown) => proc.emitLine({ id: message.id, result });
        if (message.method === "initialize") reply({ userAgent: "scripted-codex-fixture/0.166.0" });
        if (message.method === "config/read") reply(effectiveConfiguration([...args]));
        if (message.method === "configRequirements/read") reply({ supportsIndependentSpeedModes: true, requirements: null });
        if (message.method === "thread/start" || message.method === "thread/resume") {
          cwd = message.params.cwd;
          reply({ thread: { id: native }, model: message.params.model, modelProvider: message.params.modelProvider });
        }
        if (message.method === "turn/start") {
          turn = `turn-${++sequence}`;
          command = `command-${turn}`;
          const text = JSON.stringify(message.params.input);
          reply({ turn: { id: turn } });
          emit("turn/started", { turn: { id: turn } });
          if (text.includes("SERVER_FAILURE")) {
            emit("turn/completed", { turn: { id: turn, status: "failed", error: { message: "Local fixture server unavailable", codexErrorInfo: "internalServerError" } } });
          } else if (text.includes("STOP_FIXTURE")) {
            emit("item/started", { turnId: turn, item: { id: command, type: "commandExecution", command: "node delayed-write.cjs", cwd, status: "inProgress" } });
            child = spawn(node, ["-e", "const fs=require('node:fs'); fs.appendFileSync('stop-started.txt','started\\n'); setTimeout(()=>fs.writeFileSync('late-effect.txt','bad'),60000)"], { cwd, stdio: "ignore" });
          } else {
            emit("item/started", { turnId: turn, item: { id: command, type: "commandExecution", command: "node fixture-check.cjs", cwd, status: "inProgress" } });
            proc.emitLine({ id: `approval-${turn}`, method: "item/commandExecution/requestApproval", params: { threadId: native, turnId: turn, itemId: command, command: "node fixture-check.cjs", cwd, reason: "Edit the disposable fixture and run its independent check." } });
          }
        }
        if (message.id === `approval-${turn}` && message.result) {
          if (message.result.decision !== "accept") { finish("completed", "Denied", 1); continue; }
          fs.appendFileSync(path.join(cwd, "edits.txt"), "edit\n");
          fs.writeFileSync(path.join(cwd, "greeting.txt"), "hello, local\n");
          const checked = spawnSync(node, ["fixture-check.cjs"], { cwd, encoding: "utf8" });
          finish("completed", `${checked.stdout}${checked.stderr}`, checked.status);
        }
        if (message.method === "turn/interrupt") {
          reply({});
          if (child) {
            const running = child; child = undefined;
            running.once("exit", () => finish("interrupted")); running.kill("SIGTERM");
          } else finish("interrupted");
        }
      }
    });
    proc.once("exit", () => child?.kill("SIGTERM"));
    return fakeSpawn(proc).spawn(bin, args, opts);
  };
