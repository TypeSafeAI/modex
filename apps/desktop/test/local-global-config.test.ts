import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { SpawnOptions } from "node:child_process";
import { LocalConnectionStore } from "../src/main/engine/local-models/connections.js";
import { LocalExecution } from "../src/main/engine/local-models/execution.js";
import { SecretStore, testCipher } from "../src/main/engine/secrets.js";
import { FakeProcess, fakeSpawn, collectSink } from "./fakeproc.js";
import { globalCodexConfig } from "./local-global-config-guard.js";
import { tmpdir } from "./helpers.js";

const MODEL = "scripted-fixture-model";

/** The effective configuration Codex reports for its own `-c` flags, over an empty user and system layer. */
function reported(args: string[]) {
  const flags: Record<string, any> = {};
  const origins: Record<string, unknown> = {};
  const origin = { name: { type: "sessionFlags" }, version: "sha256:flags" };
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "-c") continue;
    const setting = args[++i]!; const eq = setting.indexOf("=");
    const keys = setting.slice(0, eq).split("."); const value = JSON.parse(setting.slice(eq + 1));
    let node = flags; for (const key of keys.slice(0, -1)) node = node[key] ??= {}; node[keys.at(-1)!] = value;
    origins[keys.join(".")] = origin;
  }
  const config: Record<string, any> = { model: null, model_reasoning_summary: null, openai_base_url: null, mcp_servers: {}, ...structuredClone(flags) };
  for (const provider of Object.values(config.model_providers ?? {}) as Record<string, unknown>[]) Object.assign(provider, { experimental_bearer_token: null, auth: null, http_headers: null, env_http_headers: null, query_params: null, ...provider });
  return { config, origins, layers: [{ name: { type: "sessionFlags" }, version: "sha256:flags", config: flags }, { name: { type: "user", file: "/private/home/.codex/config.toml", profile: null }, version: "sha256:empty", config: {} }, { name: { type: "system", file: "/etc/codex/config.toml" }, version: "sha256:empty", config: {} }] };
}

/**
 * LM-3 AC4 (#379): the person's `~/.codex/config.toml` keeps its exact bytes through a local turn. The scripted child
 * resolves its home the way Codex does (`CODEX_HOME`, else `$HOME/.codex`, from the environment Modex gave it) and writes
 * there, so a child handed the person's home would rewrite the fixture file. The write landing in the private home is the
 * positive control that this check can fail.
 */
test("a local turn leaves the person's ~/.codex/config.toml byte-identical, while the child writes only to its private home", async () => {
  const global = globalCodexConfig();
  const home = tmpdir("lm3-config-");
  const connections = new LocalConnectionStore(home, new SecretStore(home, testCipher));
  const connection = connections.create({ label: "Local", runtime: "responses", url: "http://127.0.0.1:18511/v1" });
  const written: string[] = [];
  const children: FakeProcess[] = [];
  const spawnImpl = ((bin: string, args: string[], opts: SpawnOptions) => {
    const proc = new FakeProcess();
    children.push(proc);
    const codexHome = opts.env!.CODEX_HOME ?? path.join(opts.env!.HOME!, ".codex");
    const config = path.join(codexHome, "config.toml");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.appendFileSync(config, "# written by the child\n");
    written.push(config);
    proc.stdin.on("data", (d: Buffer) => {
      for (const line of d.toString().trim().split("\n")) {
        const m = JSON.parse(line);
        if (m.method === "initialize") proc.emitLine({ id: m.id, result: { userAgent: "codex/0.166.0" } });
        if (m.method === "config/read") proc.emitLine({ id: m.id, result: reported(args) });
        if (m.method === "configRequirements/read") proc.emitLine({ id: m.id, result: { supportsIndependentSpeedModes: true, requirements: null } });
        if (m.method === "thread/start") proc.emitLine({ id: m.id, result: { thread: { id: "native-1" }, model: m.params.model, modelProvider: m.params.modelProvider } });
        if (m.method === "turn/start") {
          proc.emitLine({ id: m.id, result: { turn: { id: "turn" } } });
          proc.emitLine({ method: "turn/started", params: { threadId: "native-1", turn: { id: "turn" } } });
          proc.emitLine({ method: "turn/completed", params: { threadId: "native-1", turn: { id: "turn", status: "completed" } } });
        }
      }
    });
    return fakeSpawn(proc).spawn(bin, args, opts);
  }) as ConstructorParameters<typeof LocalExecution>[3];
  const execution = new LocalExecution(home, connections, "codex", spawnImpl);
  const thread = { id: "modex-1", cwd: tmpdir("lm3-config-cwd-"), localContextTokens: 32768, localTarget: { schema: 1 as const, harness: "codex" as const, model: { schema: 1 as const, connection: { id: connection.id, revision: 1 }, id: MODEL } } };
  try {
    const result = await execution.backend(thread).runTurn("read", { cwd: thread.cwd, mode: "agent", plan: false, model: MODEL }, collectSink().sink, new AbortController().signal);
    assert.equal(result.status, "completed", result.error);
    assert.equal(children.length, 1);
    assert.equal(written.length, 1, "the scripted child made its write");
    assert.deepEqual(global.unchanged(), { sha256: global.sha256, bytes: true, mtimeMs: true, tree: true });
    assert.notEqual(written[0], global.file, "the child's home is not the person's");
    assert.ok(written[0]!.startsWith(path.join(home, "app", "local-codex")), `child wrote to ${written[0]}`);
    assert.equal(fs.readFileSync(written[0]!, "utf8"), "# written by the child\n", "the private config held only the child's write");
    await execution.forget(thread.id);
    assert.equal(fs.existsSync(written[0]!), false, "the private home is gone with the child");
    assert.deepEqual(global.unchanged(), { sha256: global.sha256, bytes: true, mtimeMs: true, tree: true });
  } finally {
    await execution.dispose();
    global.restore();
  }
});
