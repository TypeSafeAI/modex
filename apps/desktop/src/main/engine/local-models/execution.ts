import fs from "node:fs";
import path from "node:path";
import { CodexBackend } from "../backends/codex.js";
import { cliSpawn } from "../backends/health.js";
import type { Backend, TurnOptions, TurnResult, TurnSink } from "../backends/types.js";
import type { CliExecutable } from "../cli-path.js";
import { modelKey, threadTarget, type LocalThreadTarget } from "../../../shared/local-models.js";
import type { LocalConnectionStore } from "./connections.js";

/**
 * Runs a thread's turns on a local model through the Codex CLI (#379), the same `codex app-server`
 * path cloud turns take; Modex itself never sends an inference request.
 *
 * Each thread with a local target gets its own Codex child: a private home with nothing inherited
 * (no user config, plugins, MCP servers, sign-in or proxy), an environment allowlist, the connection's
 * token in one variable the tool shell cannot see, and the provider and model pinned by `-c` overrides
 * and confirmed by Codex on every open. The child is keyed by the exact target: connection revision
 * (which moves with the address or token), model, context window and working directory. A key change
 * means a fresh child and a fresh native conversation; a handle from a previous process is refused
 * rather than guessed at. One turn at a time reaches any one loopback port.
 *
 * Loopback is the configured destination, not verified locality: the server may forward requests, and
 * Codex's own HTTP client follows redirects (docs/local-models.md).
 */

export const PROVIDER_ID = "modex_local";
export const MIN_CONTEXT_TOKENS = 4096;
export const MAX_CONTEXT_TOKENS = 262_144;
/** Process environment a child may inherit: path and temp lookup, locale and Windows shell basics. */
const INHERITED_ENV = ["PATH", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL"];
const TOKEN_ENV = "MODEX_LOCAL_TOKEN";

export interface LocalExecutionThread {
  id: string;
  cwd: string;
  localTarget?: LocalThreadTarget;
  localContextTokens?: number;
}

/**
 * A `.codex` directory in or above the working directory would layer project configuration under the
 * child's; which of its settings win is not qualified, so it is refused rather than inherited.
 */
function refuseProjectConfiguration(cwd: string): void {
  const roots = new Set([path.resolve(cwd)]);
  try { roots.add(fs.realpathSync(cwd)); } catch { /* an unreadable cwd fails at spawn, with Codex's own message */ }
  for (const root of roots) {
    for (let dir = root; ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, ".codex"))) throw new Error("Local execution cannot use a project .codex configuration. Use a project without one until configuration precedence is qualified.");
      if (dir === path.dirname(dir)) break;
    }
  }
}

export class LocalExecution {
  /** The child owning each thread's native conversation, with the key it was started for. */
  private readonly children = new Map<string, { key: string; backend: CodexBackend; home: string }>();
  private readonly services = new Map<string, { busy: boolean; waiting: Set<() => void> }>();
  private disposed = false;

  constructor(private readonly home: string, private readonly connections: LocalConnectionStore,
    private readonly executable: CliExecutable = "codex", private readonly spawnImpl = cliSpawn) {}

  /** The thread's target, checked against the live profile: exactly its revision, with its token readable. */
  validate(thread: LocalExecutionThread): LocalThreadTarget {
    const target = threadTarget({ backend: "codex", localTarget: thread.localTarget });
    if (target.kind !== "local" || target.target.harness !== "codex") throw new Error("Select a valid Codex local target.");
    const context = thread.localContextTokens;
    if (!Number.isSafeInteger(context) || context! < MIN_CONTEXT_TOKENS || context! > MAX_CONTEXT_TOKENS) throw new Error(`Set a local context window between ${MIN_CONTEXT_TOKENS} and ${MAX_CONTEXT_TOKENS} tokens.`);
    const connection = this.connections.resolve(target.target.model.connection);
    if (!connection) throw new Error("The local connection changed or was deleted. Select its current revision to start a fresh conversation.");
    if (connection.credentialUnavailable) throw new Error("Modex can't read the connection's saved token right now, so it didn't start Codex.");
    // Codex resolves names itself, outside LM-2's loopback-checked socket: execution takes IP literals only.
    if (connection.endpoint.host === "localhost") throw new Error("Use a loopback IP address (127.0.0.1 or ::1) for local execution.");
    if (connection.token && target.target.model.id.includes(connection.token)) throw new Error("A model ID can't contain the connection's token.");
    return target.target;
  }

  /** A backend for this thread's turns. The selection is snapshotted here; a later edit is a different key. */
  backend(thread: LocalExecutionThread): Backend {
    const snapshot = structuredClone(thread);
    return {
      id: "codex", listModels: async () => [], dispose: async () => {},
      runTurn: (text, opts, sink, signal) => this.run(snapshot, text, opts, sink, signal),
      forceStop: () => this.children.get(thread.id)?.backend.forceStop() ?? Promise.resolve(),
    };
  }

  /** One turn at a time per service; a cancelled wait starts nothing. */
  private async acquire(service: string, signal: AbortSignal): Promise<() => void> {
    let slot = this.services.get(service);
    if (!slot) { slot = { busy: false, waiting: new Set() }; this.services.set(service, slot); }
    while (slot.busy) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const ready = () => { cleanup(); resolve(); };
        const aborted = () => { cleanup(); reject(new Error("Stopped while waiting for the local server.")); };
        const cleanup = () => { slot!.waiting.delete(ready); signal.removeEventListener("abort", aborted); };
        slot!.waiting.add(ready);
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) aborted();
      });
    }
    signal.throwIfAborted();
    slot.busy = true;
    return () => { slot!.busy = false; for (const notify of [...slot!.waiting]) notify(); };
  }

  private async run(thread: LocalExecutionThread, text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    let release: (() => void) | undefined;
    try {
      if (this.disposed) throw new Error("Local execution has stopped. Select the local target again after Modex restarts.");
      const target = this.validate(thread);
      if (opts.model !== target.model.id || opts.cwd !== thread.cwd || opts.account) throw new Error("The local target changed. Select it again to start a fresh conversation.");
      if (opts.plan || opts.images || opts.pages || opts.knowledge || opts.attachments?.some(file => file.kind === "image")) throw new Error("Plan, images and Modex's note and knowledge tools are not qualified for local models yet.");
      const connection = this.connections.resolve(target.model.connection)!;
      // Every loopback alias of a port is the same server; separate servers sharing a port also wait on each other.
      release = await this.acquire(`loopback:${connection.endpoint.port}`, signal);
      this.validate(thread); // The profile may have changed while this turn waited.
      if (this.disposed) throw new Error("Local execution has stopped. Select the local target again after Modex restarts.");
      refuseProjectConfiguration(opts.cwd);
      const key = JSON.stringify([modelKey(target.model), thread.localContextTokens, path.resolve(opts.cwd)]);
      let owned = this.children.get(thread.id);
      if (opts.resume && (!owned || owned.key !== key)) throw new Error("This conversation's native session is gone: the target changed or Modex restarted. Select the local target again to start a fresh conversation.");
      if (owned && owned.key !== key) { await this.forget(thread.id); owned = undefined; }
      if (!owned) {
        const home = this.childHome();
        owned = { key, home, backend: this.start(home, connection.endpoint.origin, connection.token, target.model.id, thread.localContextTokens!) };
        this.children.set(thread.id, owned);
      }
      // Effort, fast mode and service tiers are cloud-model settings with no local qualification: none is sent.
      return await owned.backend.runTurn(text, { ...opts, effort: undefined, fast: false }, sink, signal);
    } catch (error) {
      return signal.aborted ? { status: "interrupted" } : { status: "failed", error: (error as Error).message };
    } finally { release?.(); }
  }

  /** A private, empty home per child, so nothing of the person's Codex is read: created 0700 before spawn, since Codex expects it. */
  private childHome(): string {
    const parent = path.join(this.home, "app", "local-codex");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const home = fs.mkdtempSync(path.join(parent, "process-"));
    fs.chmodSync(home, 0o700);
    fs.mkdirSync(path.join(home, ".codex"), { mode: 0o700 });
    return home;
  }

  private start(home: string, origin: string, token: string | null, model: string, contextTokens: number): CodexBackend {
    const env: NodeJS.ProcessEnv = {};
    for (const name of INHERITED_ENV) if (process.env[name]) env[name] = process.env[name];
    Object.assign(env, {
      HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), XDG_CONFIG_HOME: path.join(home, ".config"), APPDATA: path.join(home, "AppData", "Roaming"),
      // No proxy variables are inherited, and none may apply to the loopback destination.
      NO_PROXY: "*", no_proxy: "*",
    });
    if (token) env[TOKEN_ENV] = token;
    const settings = [
      `model_provider="${PROVIDER_ID}"`, `model_providers.${PROVIDER_ID}.name="Modex local"`,
      `model_providers.${PROVIDER_ID}.base_url=${JSON.stringify(`${origin}/v1`)}`,
      `model_providers.${PROVIDER_ID}.wire_api="responses"`, `model_providers.${PROVIDER_ID}.requires_openai_auth=false`,
      `model_providers.${PROVIDER_ID}.supports_websockets=false`,
      ...(token ? [`model_providers.${PROVIDER_ID}.env_key="${TOKEN_ENV}"`] : []),
      `model_providers.${PROVIDER_ID}.request_max_retries=0`, `model_providers.${PROVIDER_ID}.stream_max_retries=0`,
      `model_context_window=${contextTokens}`, `model_auto_compact_token_limit=${Math.floor(contextTokens * 0.85)}`,
      // Tools without local qualification are not offered: web search, image viewing and Codex's sub-agents.
      'web_search="disabled"', "features.view_image=false", "features.multi_agent=false", "features.multi_agent_v2=false",
      `shell_environment_policy.exclude=["${TOKEN_ENV}"]`,
    ];
    return new CodexBackend(this.executable, this.spawnImpl, {
      args: settings.flatMap(setting => ["-c", setting]), env,
      redact: text => token ? text.split(token).join("[local token]") : text,
      local: { model, provider: PROVIDER_ID },
    });
  }

  /** Ends the thread's child and removes its private home; the thread's next local turn starts fresh. */
  async forget(threadId: string): Promise<void> {
    const owned = this.children.get(threadId);
    this.children.delete(threadId);
    if (!owned) return;
    await owned.backend.dispose();
    fs.rmSync(owned.home, { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const slot of this.services.values()) for (const notify of [...slot.waiting]) notify();
    await Promise.all([...this.children.keys()].map(id => this.forget(id)));
  }
}
