import fs from "node:fs";
import path from "node:path";
import { CodexBackend } from "../backends/codex.js";
import { cliSpawn } from "../backends/health.js";
import type { Backend, TurnOptions, TurnResult, TurnSink } from "../backends/types.js";
import type { CliExecutable } from "../cli-path.js";
import { modelKey, threadTarget, type LocalThreadTarget } from "../../../shared/local-models.js";
import { LocalConnectionStore } from "./connections.js";

export interface LocalExecutionThread {
  id: string;
  cwd: string;
  localTarget?: LocalThreadTarget;
  localContextTokens?: number;
}

/** Reject project provider, MCP, plugin and profile overrides until native precedence is qualified. */
function checkProjectConfiguration(cwd: string): void {
  for (const root of new Set([path.resolve(cwd), fs.realpathSync(cwd)])) {
    for (let dir = root; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".codex"))) throw new Error("Local execution cannot use inherited project .codex configuration. Use a clean project until configuration precedence is qualified.");
      if (dir === path.dirname(dir)) break;
    }
  }
}

/** Native coding execution only. Never sends an inference request from Modex. */
export class LocalExecution {
  private readonly children = new Map<string, { key: string; backend: CodexBackend }>();
  private readonly services = new Map<string, { busy: boolean; waiting: Set<() => void> }>();
  private disposed = false;
  constructor(private readonly home: string, private readonly connections: LocalConnectionStore,
    private readonly executable: CliExecutable = "codex", private readonly spawnImpl = cliSpawn) {}

  validate(thread: LocalExecutionThread): LocalThreadTarget {
    const target = threadTarget({ backend: "codex", localTarget: thread.localTarget });
    if (target.kind !== "local" || target.target.harness !== "codex") throw new Error("Select a valid Codex local target.");
    if (!Number.isSafeInteger(thread.localContextTokens) || thread.localContextTokens! < 4096 || thread.localContextTokens! > 262144) throw new Error("Set an effective local context between 4096 and 262144 tokens.");
    const connection = this.connections.resolve(target.target.model.connection);
    if (!connection) throw new Error("The local connection changed or was deleted. Select its current revision to start a fresh conversation.");
    if (connection.credentialUnavailable) throw new Error("The local connection credential is unavailable.");
    // Native transport does not use LM-2's checked DNS socket. Require literal loopback for execution.
    if (connection.endpoint.host === "localhost") throw new Error("Use a loopback IP address (127.0.0.1 or ::1) for native local execution.");
    if (connection.token && target.target.model.id.includes(connection.token)) throw new Error("A model identifier cannot contain the connection credential.");
    return target.target;
  }

  backend(thread: LocalExecutionThread): Backend {
    // Snapshot public selection before setup awaits; never follow a live mutable Thread object.
    const snapshot = structuredClone(thread);
    return {
      id: "codex", listModels: async () => [], dispose: async () => {},
      runTurn: (text, opts, sink, signal) => this.run(snapshot, text, opts, sink, signal),
      forceStop: () => this.children.get(thread.id)?.backend.forceStop() ?? Promise.resolve(),
    };
  }

  private async acquire(origin: string, signal: AbortSignal): Promise<() => void> {
    let service = this.services.get(origin);
    if (!service) { service = { busy: false, waiting: new Set() }; this.services.set(origin, service); }
    while (service.busy) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const ready = () => { cleanup(); resolve(); };
        const aborted = () => { cleanup(); reject(new Error("Local queue cancelled.")); };
        const cleanup = () => { service!.waiting.delete(ready); signal.removeEventListener("abort", aborted); };
        service!.waiting.add(ready);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
    }
    signal.throwIfAborted();
    service.busy = true;
    return () => { service!.busy = false; for (const notify of [...service!.waiting]) notify(); };
  }

  private async run(thread: LocalExecutionThread, text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    let release: (() => void) | undefined;
    try {
      if (this.disposed) throw new Error("Local execution stopped. A fresh conversation is required after restart.");
      const target = this.validate(thread);
      if (opts.model !== target.model.id || opts.cwd !== thread.cwd || opts.account) throw new Error("Local execution target changed.");
      if (opts.plan || opts.images || opts.pages || opts.knowledge || opts.attachments?.some(file => file.kind === "image")) throw new Error("Local Plan, image and external-tool capabilities are not qualified yet.");
      const connection = this.connections.resolve(target.model.connection)!;
      // All literal loopback aliases on one port share capacity, including mapped IPv6.
      // This deliberately serializes separate listeners sharing a port as a conservative bound.
      const serviceOrigin = `loopback:${connection.endpoint.port}`;
      release = await this.acquire(serviceOrigin, signal);
      this.validate(thread); // Profile may have changed while queued.
      if (this.disposed) throw new Error("Local execution stopped. Start a fresh conversation.");
      checkProjectConfiguration(opts.cwd);
      const key = JSON.stringify([modelKey(target.model), thread.localContextTokens, path.resolve(opts.cwd)]);
      let owned = this.children.get(thread.id);
      if (opts.resume && (!owned || owned.key !== key)) throw new Error("Local resume is unavailable after a target change or restart. Select the local target again to start a fresh conversation.");
      if (owned && owned.key !== key) { await owned.backend.dispose(); this.children.delete(thread.id); owned = undefined; }
      if (!owned) {
        const parent = path.join(this.home, "app", "local-codex");
        fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
        const childHome = fs.mkdtempSync(path.join(parent, "process-"));
        fs.chmodSync(childHome, 0o700);
        fs.mkdirSync(path.join(childHome, ".codex"), { mode: 0o700 });
        const env: NodeJS.ProcessEnv = {};
        for (const name of ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"]) if (process.env[name]) env[name] = process.env[name];
        Object.assign(env, { HOME: childHome, USERPROFILE: childHome, CODEX_HOME: path.join(childHome, ".codex"), XDG_CONFIG_HOME: path.join(childHome, ".config"), APPDATA: path.join(childHome, "AppData", "Roaming"), NO_PROXY: "*", no_proxy: "*" });
        if (connection.token) env.MODEX_LOCAL_TOKEN = connection.token;
        const settings = [
          'model_provider="modex_local"', 'model_providers.modex_local.name="Modex local"',
          `model_providers.modex_local.base_url=${JSON.stringify(connection.endpoint.origin + "/v1")}`,
          'model_providers.modex_local.wire_api="responses"', 'model_providers.modex_local.requires_openai_auth=false',
          'model_providers.modex_local.supports_websockets=false',
          ...(connection.token ? ['model_providers.modex_local.env_key="MODEX_LOCAL_TOKEN"'] : []),
          'model_providers.modex_local.request_max_retries=0', 'model_providers.modex_local.stream_max_retries=0',
          `model_context_window=${thread.localContextTokens}`, `model_auto_compact_token_limit=${Math.floor(thread.localContextTokens! * 0.85)}`,
          'web_search="disabled"', 'features.view_image=false', 'shell_environment_policy.exclude=["MODEX_LOCAL_TOKEN"]', 'features.multi_agent=false', 'features.multi_agent_v2=false',
        ];
        const secret = connection.token;
        const backend = new CodexBackend(this.executable, this.spawnImpl, { args: settings.flatMap(setting => ["-c", setting]), env,
          redact: text => secret ? text.split(secret).join("[local credential]") : text,
          local: { model: target.model.id, provider: "modex_local" },
        });
        owned = { key, backend };
        this.children.set(thread.id, owned);
      }
      return await owned.backend.runTurn(text, { ...opts, effort: "low", fast: false }, sink, signal);
    } catch (error) {
      return signal.aborted ? { status: "interrupted" } : { status: "failed", error: (error as Error).message };
    } finally { release?.(); }
  }

  async forget(threadId: string): Promise<void> {
    const owned = this.children.get(threadId);
    this.children.delete(threadId);
    await owned?.backend.dispose();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const service of this.services.values()) for (const notify of [...service.waiting]) notify();
    const children = [...this.children.values()];
    this.children.clear();
    await Promise.all(children.map(child => child.backend.dispose()));
  }
}
