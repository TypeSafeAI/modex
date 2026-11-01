import { claudeSecretSink } from "./claude-secret-sink.js";
import type { CliExecutable } from "../cli-path.js";
import type { BackendHealth } from "../../../shared/types.js";
import type { Backend, TitleOptions, TurnOptions, TurnResult, TurnSink } from "./types.js";
import { ClaudeBackend } from "./claude.js";
import { cliEnvironment, cliSpawn, health, installation, probe } from "./health.js";
import { claudeAccountEnvironment, type ClaudeAccounts } from "../claude-accounts.js";
import { generateTitle } from "../titles.js";

/**
 * Claude Code under a Modex-managed account (engine/claude-accounts.ts). One `claude -p` child per
 * turn, as before; only its environment changes with the turn's account. "cli" (or no account) is
 * the CLI's own login, unchanged.
 */
export class AccountClaudeBackend extends ClaudeBackend {
  constructor(private readonly accounts: Pick<ClaudeAccounts, "identity" | "environment" | "account" | "status">, executable: CliExecutable = "claude", spawnImpl = cliSpawn, timing: ConstructorParameters<typeof ClaudeBackend>[2] = {}) {
    super(executable, spawnImpl, timing);
  }

  identity(): string { return this.accounts.identity(); }

  /** The base environment plus the account's additions; an empty value removes an inherited variable. */
  private overlay(base: NodeJS.ProcessEnv, account: string | undefined): NodeJS.ProcessEnv {
    if (!account || account === "cli") return base;
    return claudeAccountEnvironment(base, this.accounts.environment(account).env);
  }

  protected override turnEnvironment(bin: string, opts: TurnOptions): NodeJS.ProcessEnv {
    return this.overlay(cliEnvironment(bin), opts.account);
  }

  override async runTurn(text: string, opts: TurnOptions, sink: TurnSink, signal: AbortSignal): Promise<TurnResult> {
    let secret: string | undefined;
    if (opts.account && opts.account !== "cli") {
      if (!this.accounts.account(opts.account)) return { status: "failed", error: "This conversation's Claude account was removed from Modex. Sign in again: add the account in Settings → Coding CLIs, or start a new thread." };
      try { secret = this.accounts.environment(opts.account).secret; }
      catch (error) { return { status: "failed", error: (error as Error).message }; }
    }
    if (!secret) return super.runTurn(text, opts, sink, signal);
    const protectedSink = claudeSecretSink(sink, secret);
    try { return protectedSink.redact(await super.runTurn(text, opts, protectedSink.sink, signal)); }
    catch (error) { throw new Error(protectedSink.redact(error instanceof Error ? error.message : String(error))); }
    finally { protectedSink.finish(); }
  }

  override generateTitle(text: string, opts: TitleOptions, signal: AbortSignal): Promise<string | null> {
    const runTurn = (t: string, o: TurnOptions, s: TurnSink, sig: AbortSignal) => this.runTurn(t, { ...o, account: opts.account }, s, sig);
    const bound: Backend = { id: this.id, runTurn, listModels: () => this.listModels(), dispose: async () => {} };
    return generateTitle(bound, opts, text, signal);
  }

  /** The selected account's health: the CLI's login, a profile's own `auth status`, or a saved gateway key. */
  override async health(): Promise<BackendHealth> {
    const id = this.identity();
    if (id === "cli") return super.health();
    return accountHealth(this.bin, this.spawnImpl, this.accounts, id);
  }
}

/** One pool account's health. Profiles are checked with Claude Code's structured `auth status` in their own directory. */
export async function accountHealth(bin: string, spawnImpl: typeof cliSpawn, accounts: Pick<ClaudeAccounts, "environment" | "account">, id: string): Promise<BackendHealth> {
  const installed = await installation(bin, spawnImpl);
  if (installed.unavailable) return installed.unavailable;
  const account = accounts.account(id);
  if (!account) return health("signed-out", "This Claude account was removed", "available", installed.version);
  let env: NodeJS.ProcessEnv;
  try { env = accounts.environment(id).env; } catch (error) { return health("signed-out", (error as Error).message, "available", installed.version); }
  if (account.kind === "gateway") return health("authenticated", `OrcaRouter gateway key saved · ${account.model ?? "gateway default model"} · model access unverified`, "available", installed.version);
  const result = await probe(bin, ["auth", "status"], spawnImpl, 5000, claudeAccountEnvironment(process.env, env));
  if (result.failure) return health("failed", result.failure === "timeout" ? "Account check timed out" : "Account check failed", "available", installed.version);
  try {
    const status = JSON.parse(result.output) as { loggedIn?: unknown; email?: unknown };
    if (status.loggedIn === true && result.code === 0) return health("authenticated", `Signed in · ${account.label} · model access unverified`, "available", installed.version);
    if (status.loggedIn === false && result.code === 1) return health("signed-out", `Signed out · sign in to ${account.label}`, "available", installed.version);
  } catch { /* Older CLIs do not report structured status. */ }
  return health("unknown", "Account status unavailable · check in Claude CLI", "available", installed.version);
}
