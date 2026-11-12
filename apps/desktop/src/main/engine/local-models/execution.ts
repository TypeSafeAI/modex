import fs from "node:fs";
import path from "node:path";
import { CodexBackend } from "../backends/codex.js";
import { cliSpawn } from "../backends/health.js";
import type { Backend, TurnOptions, TurnResult, TurnSink } from "../backends/types.js";
import type { CliExecutable } from "../cli-path.js";
import { modelKey, threadTarget, type LocalModelRef, type LocalThreadTarget } from "../../../shared/local-models.js";
import type { LocalConnectionStore } from "./connections.js";
import { admitLocalConfiguration, type LocalConfigurationProvenance, type LocalHostSandbox, type ExpectedLocalConfiguration } from "./run-policy.js";
import { OLLAMA_CLOUD_NAME, type AdvertisedContext } from "./discovery.js";
import { redactingSink, TOKEN_MASK } from "./redacting-sink.js";

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

/**
 * Codex words every HTTP 500 as a cloud service under load ("We're currently experiencing high demand"). From a
 * loopback server that is not what happened: it is the person's own server failing, often out of memory. Codex's
 * text stays in the detail; the turn's error says what is known (#380 AC4). Recognized context-limit
 * failures likewise explain recovery without changing the failed outcome or resending a turn.
 */
function truthful(result: TurnResult): TurnResult {
  if (result.status !== "failed") return result;
  const detail = result.detail as { turnError?: { codexErrorInfo?: unknown }; errorNotification?: { codexErrorInfo?: unknown } } | undefined;
  // A turn that completes with no error of its own reports the `error` notification's text instead (backends/codex.ts).
  const info = detail?.turnError?.codexErrorInfo ?? detail?.errorNotification?.codexErrorInfo;
  if (info === "internalServerError") {
    return { ...result, error: "The local server returned an internal error (HTTP 500). Check its log: it may have run out of memory or crashed while loading the model. Modex didn't retry the turn or switch models." };
  }
  let contextExceeded = info === "contextWindowExceeded";
  if (!contextExceeded && result.error && result.error.length <= 8192) {
    try {
      const response = JSON.parse(result.error) as { error?: { code?: unknown; type?: unknown; message?: unknown } } | null;
      const error = response?.error;
      // Ollama's observed HTTP 400 has a null code. Recognize only its structured
      // context-limit form, not arbitrary native/tool text mentioning context.
      contextExceeded = error?.code === "context_length_exceeded" || (error?.type === "invalid_request_error"
        && typeof error.message === "string"
        && /^request \(\d+ tokens\) exceeds the available context size \(\d+ tokens\)(?:,.*)?$/.test(error.message));
    } catch { /* Unstructured failures keep their original diagnostic. */ }
  }
  if (!contextExceeded) return result;
  return { ...result, error: "This request exceeded the local model's context limit. Start a new local conversation with less context. Earlier commands may already have run; review their results before continuing. Modex didn't retry the turn or switch models." };
}

export class LocalExecution {
  /** The child owning each thread's native conversation, with the key it was started for. */
  private readonly children = new Map<string, { key: string; backend: CodexBackend; home: string; validateProfile: () => void; provenance?: LocalConfigurationProvenance }>();
  private readonly services = new Map<string, { busy: boolean; waiting: Set<() => void> }>();
  private disposed = false;
  private readonly hostSandbox?: LocalHostSandbox;

  /** `advertisedContext` reads main's record of the runtime's own listing (LocalModelDiscovery); without it, nothing was checked. */
  constructor(private readonly home: string, private readonly connections: LocalConnectionStore,
    private readonly executable: CliExecutable = "codex", private readonly spawnImpl = cliSpawn,
    private readonly advertisedContext: (model: LocalModelRef) => AdvertisedContext | undefined = () => undefined,
    hostSandbox?: LocalHostSandbox) {
    // Only the trusted host can provide this. Normal product wiring has no external-boundary option.
    if (hostSandbox && (hostSandbox.type !== "externalSandbox" || hostSandbox.networkAccess !== "restricted" || !/^sha256:[a-f0-9]{64}$/.test(hostSandbox.boundaryId))) {
      throw new Error("A host sandbox requires a restricted, identified external boundary.");
    }
    this.hostSandbox = hostSandbox ? Object.freeze({ ...hostSandbox }) : undefined;
  }

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
    // A model the runtime itself says is served elsewhere is never a local target, listed or not (#380).
    const listed = this.advertisedContext(target.target.model);
    if (listed?.unselectable === "cloud" || (connection.runtime === "ollama" && OLLAMA_CLOUD_NAME.test(target.target.model.id))) throw new Error("The local server forwards this model to a cloud service, so it can't run as a local model. Choose a model the server runs itself.");
    if (listed?.unselectable) throw new Error(`The local server lists this model as ${listed.unselectable === "embedding" ? "an embedding model" : "a model that doesn't generate text"}, so it can't run coding turns.`);
    // A window above what the runtime itself advertised would overflow there, not here: refuse it rather than find out mid-turn.
    const advertised = listed?.tokens;
    if (typeof advertised === "number" && context! > advertised) throw new Error(`The local context window (${context} tokens) is larger than the ${advertised} tokens the server advertised for this model. Lower it, or raise the server's own setting and check its models again.`);
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
  private async acquire(service: string, signal: AbortSignal, onWaiting: () => void): Promise<() => void> {
    let slot = this.services.get(service);
    if (!slot) { slot = { busy: false, waiting: new Set() }; this.services.set(service, slot); }
    let announced = false;
    while (slot.busy) {
      signal.throwIfAborted();
      if (!announced) { announced = true; onWaiting(); }
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
      sink = redactingSink(sink, connection.token);
      // Every loopback alias of a port is the same server; separate servers sharing a port also wait on each other.
      let queuedForCapacity = false;
      release = await this.acquire(`loopback:${connection.endpoint.port}`, signal, () => {
        queuedForCapacity = true;
        sink.notice("info", "Waiting for another Modex run on this local server to finish.");
      });
      signal.throwIfAborted();
      this.validate(thread); // The profile may have changed while this turn waited.
      if (this.disposed) throw new Error("Local execution has stopped. Select the local target again after Modex restarts.");
      if (queuedForCapacity) sink.notice("info", "Continuing this turn.");
      refuseProjectConfiguration(opts.cwd);
      const directory = fs.realpathSync(opts.cwd);
      const key = JSON.stringify([modelKey(target.model), thread.localContextTokens, path.resolve(opts.cwd), directory, this.hostSandbox?.boundaryId ?? null]);
      let owned = this.children.get(thread.id);
      if (opts.resume && (!owned || owned.key !== key)) throw new Error("This conversation's native session is gone: the target changed or Modex restarted. Select the local target again to start a fresh conversation.");
      if (owned && owned.key !== key) { await this.forget(thread.id); owned = undefined; }
      if (!owned) {
        const home = this.childHome();
        const privateRoot = fs.realpathSync(home), configRoot = fs.realpathSync(path.join(home, ".codex"));
        const selectedDirectory = path.resolve(opts.cwd);
        const privateWorkspace = Object.freeze({ directory, configFile: path.join(configRoot, "config.toml") });
        const validateProfile = () => {
          try {
            if (fs.realpathSync(home) === privateRoot && fs.realpathSync(path.join(home, ".codex")) === configRoot
              && fs.realpathSync(selectedDirectory) === directory) return;
          } catch { /* A missing or replaced private directory cannot retain the native session. */ }
          throw new Error("Local execution refused: the workspace or private native profile changed. Select the local target again to start a fresh conversation.");
        };
        const child: { key: string; backend: CodexBackend; home: string; validateProfile: () => void; provenance?: LocalConfigurationProvenance } = { key, home, validateProfile, backend: undefined as unknown as CodexBackend };
        const advertised = this.advertisedContext(target.model);
        child.backend = this.start(home, connection.endpoint.origin, connection.token, target.model.id, thread.localContextTokens!, privateWorkspace, validateProfile, provenance => {
          child.provenance = { ...provenance, ...(this.hostSandbox ? { hostSandbox: this.hostSandbox } : {}), context: { configured: thread.localContextTokens!, source: "person", effective: thread.localContextTokens!,
            advertised: advertised ? { ...advertised } : "not-checked", loaded: "unknown" } };
        });
        owned = child;
        this.children.set(thread.id, owned);
      }
      owned.validateProfile();
      // Effort, fast mode and service tiers are cloud-model settings with no local qualification: none is sent.
      return truthful(await owned.backend.runTurn(text, { ...opts, effort: undefined, fast: false }, sink, signal));
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

  /** The configuration the thread's child was admitted on, once it has opened a thread; no secrets. */
  provenance(threadId: string): LocalConfigurationProvenance | undefined {
    return this.children.get(threadId)?.provenance;
  }

  private start(home: string, origin: string, token: string | null, model: string, contextTokens: number, privateWorkspace: NonNullable<ExpectedLocalConfiguration["privateWorkspace"]>, validateProfile: () => void, admitted: (provenance: LocalConfigurationProvenance) => void): CodexBackend {
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
      redact: text => token ? text.split(token).join(TOKEN_MASK) : text,
      local: { model, provider: PROVIDER_ID, ...(this.hostSandbox ? { externalSandbox: true } : {}),
        // Before each thread open, validate these flags plus only the bound private workspace trust mark (#380).
        admit: reads => { validateProfile(); admitted(admitLocalConfiguration(reads.config as Parameters<typeof admitLocalConfiguration>[0], reads.requirements as Parameters<typeof admitLocalConfiguration>[1], { provider: PROVIDER_ID, origin, contextTokens, tokenEnv: token ? TOKEN_ENV : null, privateWorkspace })); } },
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
