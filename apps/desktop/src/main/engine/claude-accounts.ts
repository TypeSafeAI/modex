import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ClaudeAccountsStatus } from "../../shared/types.js";
import type { SecretStore } from "./secrets.js";

/**
 * Modex's own pool of Claude Code accounts, in the spirit of the multi-subscription routers
 * (CC-Router, OmniRoute, teamclaude) but without a proxy on the request path: every turn still
 * runs through the installed `claude` CLI, and Modex only decides which credential set that
 * child starts with.
 *
 * Two kinds of account:
 *  - `profile`: a separate Claude Code configuration directory under `app/claude-profiles/<id>`,
 *    passed to the child as `CLAUDE_CONFIG_DIR`. Claude Code owns the browser login and the
 *    credential file inside it, exactly as it does for `~/.claude`. Modex never reads a token.
 *  - `gateway`: an Anthropic-protocol gateway key (OrcaRouter, `sk-orca-…`). The child gets
 *    `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`; the key lives in the OS-encrypted secret
 *    store and never crosses IPC. Claude Code's own `~/.claude` configuration stays in use, so
 *    sessions resume across the CLI account and a gateway account.
 *
 * The pool is the router: `pick()` returns the active account unless it is cooling down after a
 * usage limit and rotation is on, in which case the next account in order that is not cooling
 * down is chosen. A thread is bound to the account its first turn ran on (the runner stores it,
 * as for Codex), because a profile's sessions live in its own directory. Rotation therefore
 * affects new conversations; a failed turn's card says which account to continue on.
 */
export type ClaudeAccountKind = "profile" | "gateway";
export interface ClaudeAccountRecord { id: string; kind: ClaudeAccountKind; label: string; provider?: "orcarouter"; model?: string; createdAt: string }
interface Data { version: 1; active: string | null; rotate: boolean; accounts: ClaudeAccountRecord[] }

export const ORCAROUTER_BASE_URL = "https://api.orcarouter.ai";
/** A usage-limited account stays out of rotation this long when the CLI gave no reset time. */
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000;
const LABEL_MAX = 80;
const MAX_ACCOUNTS = 20;

export class ClaudeAccounts {
  readonly file: string;
  readonly profilesDir: string;
  private readonly cooldowns = new Map<string, number>();
  private cache: Data | null = null;
  /** Fires after any change so Settings and the health card can refresh. */
  onChange?: () => void;

  constructor(private readonly home: string, private readonly secrets: Pick<SecretStore, "get" | "set" | "clear" | "available">, private readonly now: () => number = Date.now) {
    this.file = path.join(home, "app", "claude-accounts.json");
    this.profilesDir = path.join(home, "app", "claude-profiles");
  }

  private read(): Data {
    if (this.cache) return this.cache;
    let data: Data = { version: 1, active: null, rotate: false, accounts: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Data>;
      if (raw.version === 1 && Array.isArray(raw.accounts)) {
        const accounts = raw.accounts.filter((a): a is ClaudeAccountRecord => Boolean(a) && typeof a.id === "string" && /^[a-f0-9-]{36}$/.test(a.id) && (a.kind === "profile" || a.kind === "gateway") && typeof a.label === "string");
        data = { version: 1, accounts, rotate: raw.rotate === true, active: typeof raw.active === "string" && accounts.some((a) => a.id === raw.active) ? raw.active : null };
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Claude account storage could not be read. The file was left in place.");
    }
    this.cache = data;
    return data;
  }

  private write(data: Data): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    this.cache = data;
    this.onChange?.();
  }

  /** The persisted account for `id`, or undefined for the CLI's own login ("cli") and unknown ids. */
  account(id: string | null | undefined): ClaudeAccountRecord | undefined {
    return id ? this.read().accounts.find((a) => a.id === id) : undefined;
  }

  /** The profile directory Claude Code reads and writes for this account. Created on demand, owner-only. */
  profileDir(id: string): string {
    const dir = path.join(this.profilesDir, id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * What the `claude` child's environment gains for `id`: nothing for the CLI's own login, the
   * profile directory for a profile, the gateway's base URL and key for a gateway. The key is the
   * only secret and the caller redacts it from every diagnostic.
   */
  environment(id: string): { env: NodeJS.ProcessEnv; secret?: string } {
    const account = this.account(id);
    if (!account) return { env: {} };
    if (account.kind === "profile") return { env: { CLAUDE_CONFIG_DIR: this.profileDir(account.id), ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_BASE_URL: "" } };
    const key = this.secrets.get(`claude_account:${account.id}`);
    if (!key) throw new Error(`The gateway key for "${account.label}" is missing. Add it again in Settings → Coding CLIs.`);
    // Claude Code reads ANTHROPIC_AUTH_TOKEN as a bearer token for a non-Anthropic endpoint; the
    // base URL has no /v1 because the CLI appends /v1/messages itself (OrcaRouter's documented rule).
    // An empty value removes an inherited variable (an ANTHROPIC_API_KEY in the person's shell would win over the
    // bearer token). CLAUDE_CODE_SUBPROCESS_ENV_SCRUB (Claude Code 2.1.316) strips Anthropic credentials from the
    // environment of the shell commands the model runs, so the key reaches the CLI but not its tools.
    const env: NodeJS.ProcessEnv = { ANTHROPIC_BASE_URL: ORCAROUTER_BASE_URL, ANTHROPIC_AUTH_TOKEN: key, ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1" };
    if (account.model) { env.ANTHROPIC_MODEL = account.model; env.ANTHROPIC_DEFAULT_OPUS_MODEL = account.model; env.ANTHROPIC_DEFAULT_SONNET_MODEL = account.model; env.ANTHROPIC_DEFAULT_HAIKU_MODEL = account.model; }
    return { env, secret: key };
  }

  /** The account a new conversation runs on: "cli" for Claude Code's own login. */
  identity(): string { return this.pick(this.read().active); }

  /**
   * The router's choice. The preferred account (the active one, or the one a caller names) unless
   * it is cooling down and rotation is on; then the next account in list order that is not cooling
   * down, wrapping around, with the CLI's own login as the last resort when every pool account is out.
   */
  pick(preferred: string | null): string {
    const data = this.read();
    const cooling = (id: string) => (this.cooldowns.get(id) ?? 0) > this.now();
    const want = preferred ?? "cli";
    if (!data.rotate || !cooling(want)) return want;
    const order = [...data.accounts.map((a) => a.id), "cli"];
    const start = order.indexOf(want);
    for (let step = 1; step <= order.length; step++) {
      const candidate = order[(start + step) % order.length]!;
      if (!cooling(candidate)) return candidate;
    }
    return want;
  }

  /** Marks `id` usage-limited until `resetAt` (ms since epoch) or the default cooldown. Returns where new conversations go now. */
  noteLimit(id: string, resetAt?: number): { until: number; next: string } {
    const until = resetAt && resetAt > this.now() ? resetAt : this.now() + DEFAULT_COOLDOWN_MS;
    this.cooldowns.set(id, until);
    this.onChange?.();
    return { until, next: this.identity() };
  }

  /** Clears a cooldown, e.g. after a completed turn proved the account usable again. */
  clearLimit(id: string): void { if (this.cooldowns.delete(id)) this.onChange?.(); }

  /** True while `id` is held out of rotation. */
  coolingDown(id: string): boolean { return (this.cooldowns.get(id) ?? 0) > this.now(); }

  status(health: Record<string, { signedIn: boolean; detail: string }> = {}): ClaudeAccountsStatus {
    const data = this.read();
    return {
      available: this.secrets.available(),
      active: data.active,
      rotate: data.rotate,
      accounts: data.accounts.map((a) => {
        const cooldownUntil = this.cooldowns.get(a.id);
        const h = health[a.id];
        return {
          id: a.id, kind: a.kind, label: a.label, ...(a.provider ? { provider: a.provider } : {}), ...(a.model ? { model: a.model } : {}),
          signedIn: h ? h.signedIn : a.kind === "gateway" ? Boolean(this.secrets.get(`claude_account:${a.id}`)) : false,
          detail: h?.detail ?? (a.kind === "gateway" ? "Gateway key saved · model access unverified" : "Sign-in not checked"),
          ...(cooldownUntil && cooldownUntil > this.now() ? { cooldownUntil: new Date(cooldownUntil).toISOString() } : {}),
        };
      }),
      detail: data.accounts.length ? data.rotate ? "New conversations move to the next account when one hits its usage limit." : "New conversations use the selected account." : "Add a Claude account to keep separate sign-ins, or a gateway key.",
    };
  }

  /** Adds a profile (a fresh configuration directory, signed out) and returns its id. */
  addProfile(label: string): ClaudeAccountRecord {
    const data = this.read();
    const record: ClaudeAccountRecord = { id: randomUUID(), kind: "profile", label: this.validLabel(label, data), createdAt: new Date(this.now()).toISOString() };
    this.profileDir(record.id);
    this.write({ ...data, accounts: [...data.accounts, record] });
    return record;
  }

  /** Adds an OrcaRouter gateway account. The key goes to the secret store, never to this file. */
  addGateway(label: string, key: string, model?: string): ClaudeAccountRecord {
    const data = this.read();
    if (!this.secrets.available()) throw new Error("Protected OS credential storage is unavailable, so a gateway key cannot be saved.");
    const trimmed = key.trim();
    if (!/^sk-orca-[A-Za-z0-9_-]{8,200}$/.test(trimmed)) throw new Error("That is not an OrcaRouter key. Keys start with sk-orca-.");
    const chosen = model?.trim();
    if (chosen && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/.test(chosen)) throw new Error("Model ids use the vendor/model form, such as anthropic/claude-opus-4.8.");
    const record: ClaudeAccountRecord = { id: randomUUID(), kind: "gateway", provider: "orcarouter", label: this.validLabel(label, data), ...(chosen ? { model: chosen } : {}), createdAt: new Date(this.now()).toISOString() };
    this.secrets.set(`claude_account:${record.id}`, trimmed);
    this.write({ ...data, accounts: [...data.accounts, record] });
    return record;
  }

  select(id: string | null): void {
    const data = this.read();
    if (id !== null && !data.accounts.some((a) => a.id === id)) throw new Error("That Claude account no longer exists.");
    this.write({ ...data, active: id });
  }

  setRotation(rotate: boolean): void { this.write({ ...this.read(), rotate }); }

  /**
   * Forgets an account. A profile's directory (Claude Code's own credential and session files) is
   * removed with it; a gateway's key is cleared from the secret store. Threads bound to it keep their
   * transcripts and fail with a sign-in card on their next turn.
   */
  remove(id: string): void {
    const data = this.read();
    const account = data.accounts.find((a) => a.id === id);
    if (!account) throw new Error("That Claude account no longer exists.");
    if (account.kind === "gateway") this.secrets.clear(`claude_account:${id}`);
    else fs.rmSync(path.join(this.profilesDir, id), { recursive: true, force: true });
    this.cooldowns.delete(id);
    this.write({ ...data, active: data.active === id ? null : data.active, accounts: data.accounts.filter((a) => a.id !== id) });
  }

  private validLabel(label: string, data: Data): string {
    const trimmed = label.trim().replace(/\s+/g, " ");
    if (!trimmed) throw new Error("Give the account a name.");
    if (trimmed.length > LABEL_MAX) throw new Error(`Account names are at most ${LABEL_MAX} characters.`);
    if (data.accounts.length >= MAX_ACCOUNTS) throw new Error(`At most ${MAX_ACCOUNTS} Claude accounts.`);
    if (data.accounts.some((a) => a.label.toLowerCase() === trimmed.toLowerCase())) throw new Error("Another Claude account already has that name.");
    return trimmed;
  }
}

/**
 * The moment a usage limit lifts, from Claude Code's own wording ("resets at 3pm", "resets Nov 2 at 7pm (UTC)",
 * "try again in 2 hours"), or undefined when it gave none. Exported for tests.
 */
export function limitResetAt(message: string, now = Date.now()): number | undefined {
  const relative = /(?:try again|retry|resets?) in (\d+)\s*(second|sec|minute|min|hour|hr|day)s?/i.exec(message);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2]!.toLowerCase();
    const ms = unit.startsWith("s") ? 1000 : unit.startsWith("m") ? 60_000 : unit.startsWith("h") ? 3_600_000 : 86_400_000;
    return now + n * ms;
  }
  // A clock time ("resets 9am", "resets at 3:30pm (UTC)") is read in local time: the next time it occurs.
  const clock = /resets?\b[^|\n]*?\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(message);
  const dated = /resets? (?:on )?([A-Za-z]{3,9} \d{1,2})(?:,? \d{4})?(?:,? at)? /i.exec(message);
  if (clock) {
    const hour = (Number(clock[1]) % 12) + (clock[3]!.toLowerCase() === "pm" ? 12 : 0);
    const at = new Date(now);
    if (dated) {
      const day = new Date(`${dated[1]} ${at.getFullYear()}`);
      if (!Number.isNaN(day.getTime())) at.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
    }
    at.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (at.getTime() <= now) at.setTime(at.getTime() + (dated ? 365 : 1) * 86_400_000);
    return at.getTime();
  }
  return undefined;
}

/** Apply account overrides consistently for turns, status and login; empty entries remove inheritance. */
export function claudeAccountEnvironment(base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === "" || value === undefined) delete env[name]; else env[name] = value;
  }
  return env;
}
