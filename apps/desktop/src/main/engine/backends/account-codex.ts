import { spawn } from "node:child_process";
import type { Backend, ModelInfo, TurnOptions, TurnResult, TurnSink } from "./types.js";
import { CodexBackend } from "./codex.js";
import { health, installation } from "./health.js";
import type { ChatGPTAuth } from "../chatgpt-auth.js";
import { generateTitle } from "../titles.js";

interface Runtime { backend: CodexBackend | null; token: string; expiresAt: number; leases: number; preparing: Promise<CodexBackend> | null }
export const planArgs = ["--listen", "stdio://", ...[
  'model_provider="openai_chatgpt_plan"',
  'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
  'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
  'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
  'model_providers.openai_chatgpt_plan.wire_api="responses"',
  'model_providers.openai_chatgpt_plan.requires_openai_auth=false',
  'model_providers.openai_chatgpt_plan.supports_websockets=false',
  'shell_environment_policy.filters.ACCESS_TOKEN="exclude"',
  'shell_environment_policy.set.ACCESS_TOKEN=""',
].flatMap((setting) => ["-c", setting])];

/** Separate shared app-server per registration; each lease includes async turn initialization. */
export class AccountCodexBackend implements Backend {
  readonly id = "codex" as const;
  private readonly runtimes = new Map<string, Runtime>();
  private readonly changing = new Set<string>();
  private disposed = false;
  private readonly cli: CodexBackend;
  constructor(private readonly auth: Pick<ChatGPTAuth, "identity" | "grant" | "status">, private readonly bin = "codex", private readonly spawnImpl = spawn) {
    this.cli = new CodexBackend(bin, spawnImpl);
  }
  identity(): string { return this.auth.identity(); }
  busy(id: string): boolean { const runtime = this.runtimes.get(id); return Boolean(runtime && (runtime.leases || runtime.preparing)); }
  async accountChange<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.changing.has(id)) throw new Error("This account already has an operation in progress.");
    this.changing.add(id);
    try { await this.releaseAccount(id); return await action(); }
    finally { this.changing.delete(id); }
  }
  async releaseAccount(id: string): Promise<void> {
    if (this.busy(id)) throw new Error("Wait for this account's active or initializing turns to finish before signing out.");
    const runtime = this.runtimes.get(id); this.runtimes.delete(id); await runtime?.backend?.dispose();
  }
  private async use<T>(id: string, action: (backend: CodexBackend) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("Modex is shutting down.");
    if (this.changing.has(id)) throw new Error("Wait for this account's sign-in or sign-out to finish.");
    if (id === "cli") return action(this.cli);
    let runtime = this.runtimes.get(id);
    if (!runtime) { runtime = { backend: null, token: "", expiresAt: 0, leases: 0, preparing: null }; this.runtimes.set(id, runtime); }
    // Refuse renewal while another turn uses the old process. Never replay or terminate it.
    if (runtime.backend && runtime.expiresAt <= Date.now() + 60000 && runtime.leases > 0) throw new Error("ChatGPT token renewal is waiting for another turn to finish. Retry after it completes.");
    runtime.leases++;
    try {
      if (!runtime.preparing && (!runtime.backend || runtime.expiresAt <= Date.now() + 60000)) {
        const owned = runtime;
        owned.preparing = (async () => {
          const grant = await this.auth.grant(id);
          if (this.disposed) throw new Error("Modex is shutting down.");
          if (owned.backend && owned.token !== grant.token) await owned.backend.dispose();
          if (!owned.backend || owned.token !== grant.token) {
            const env = { ...process.env, ACCESS_TOKEN: grant.token };
            owned.backend = new CodexBackend(this.bin, this.spawnImpl, { args: planArgs, env, redact: (text) => text.split(grant.token).join("[redacted]") });
          }
          owned.token = grant.token; owned.expiresAt = grant.expiresAt;
          return owned.backend;
        })();
      }
      const backend = runtime.preparing ? await runtime.preparing : runtime.backend!;
      return await action(backend);
    } finally { runtime.leases--; if (runtime.leases === 0) runtime.preparing = null; }
  }
  runTurn(text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    const id = opts.account ?? this.identity();
    // Legacy resume handles are CLI-owned; explicitly bound handles stay with their original account.
    if (opts.resume && !opts.account && id !== "cli") return Promise.resolve({ status: "failed", error: "This conversation belongs to Codex CLI authentication. Select CLI authentication to resume it." });
    return this.use(id, (backend) => signal.aborted ? Promise.resolve({ status: "interrupted" as const }) : backend.runTurn(text, opts, sink, signal));
  }
  generateTitle(text: string, opts: { model: string; account?: string }, signal: AbortSignal): Promise<string | null> {
    const id = opts.account ?? this.identity();
    return this.use(id, (backend) => generateTitle(backend, opts, text, signal));
  }
  listModels(): Promise<ModelInfo[]> { return this.use(this.identity(), (backend) => backend.listModels()); }
  async health() {
    const id = this.identity(); if (id === "cli") return this.cli.health();
    const installed = await installation(this.bin, this.spawnImpl);
    if (installed.unavailable) return installed.unavailable;
    const account = this.auth.status().accounts.find((account) => account.id === id);
    return account?.signedIn ? health("authenticated", account.planEnabled ? "ChatGPT account signed in · model access unverified" : "Identity signed in · ChatGPT plan usage not authorized", "available", installed.version) : health("signed-out", "Sign in to this ChatGPT registration again", "available", installed.version);
  }
  async forceStop(account = "cli"): Promise<void> {
    if (account === "cli") return this.cli.forceStop();
    // The runner's explicit second Stop names the affected account; other accounts survive.
    await this.runtimes.get(account)?.backend?.forceStop();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.allSettled([...this.runtimes.values()].flatMap((runtime) => runtime.preparing ? [runtime.preparing] : []));
    await Promise.all([this.cli.dispose(), ...[...this.runtimes.values()].map(async (runtime) => runtime.backend?.dispose())]);
    this.runtimes.clear();
  }
}
