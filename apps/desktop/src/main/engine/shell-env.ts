import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";

/**
 * Finder/Dock-launched apps on macOS get launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin),
 * so `claude`, `codex`, and `jev` — usually installed under nvm, Homebrew, or ~/.local — are
 * invisible. This resolves the PATH the user's own terminal sees, once, and merges it into the
 * environment every CLI spawn inherits.
 *
 * Interactive login (`-ilc`) because nvm and friends are normally loaded from ~/.zshrc, which a
 * non-interactive shell skips. The PATH is printed between sentinels so anything a profile
 * echoes (banners, nvm notices) cannot leak into it. Falls back to `-lc`, then to nothing.
 */
const START = "__MODEX_PATH_START__";
const END = "__MODEX_PATH_END__";

type ExecFileLike = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number; encoding: "utf8" }, cb: (err: Error | null, stdout: string) => void) => unknown;

export interface LoginPathOptions {
  platform?: NodeJS.Platform;
  shell?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  execFileImpl?: ExecFileLike;
}

export interface LoginPathResult {
  path: string | null;
  /** Which invocation produced it, for diagnostics. */
  via: "-ilc" | "-lc" | "none" | "disabled" | "inherited";
}

function inheritedPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  // Match Node's child-process selection when a Windows environment contains
  // multiple spellings of the case-insensitive key.
  const key = platform === "win32" ? Object.keys(env).sort().find((key) => key.toUpperCase() === "PATH") : "PATH";
  return key ? env[key] ?? "" : "";
}

/** Extracts the PATH printed between the sentinels; null when absent or empty. */
export function extractPath(stdout: string): string | null {
  const s = stdout.indexOf(START);
  const e = stdout.indexOf(END, s + START.length);
  if (s < 0 || e < 0) return null;
  const value = stdout.slice(s + START.length, e).trim();
  return value || null;
}

function run(flag: "-ilc" | "-lc", o: Required<Pick<LoginPathOptions, "shell" | "timeoutMs">> & { env: NodeJS.ProcessEnv; execFileImpl: ExecFileLike }): Promise<string | null> {
  return new Promise((resolve) => {
    o.execFileImpl(o.shell, [flag, `printf '%s%s%s' '${START}' "$PATH" '${END}'`], { env: o.env, timeout: o.timeoutMs, encoding: "utf8" }, (err, stdout) => {
      // A non-zero exit can still carry a good PATH (a profile command failed after PATH was set).
      const p = extractPath(String(stdout ?? ""));
      resolve(p ?? (err ? null : null));
    });
  });
}

export async function readLoginPath(opts: LoginPathOptions = {}): Promise<LoginPathResult> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (env.MODEX_NO_LOGIN_PATH) return { path: null, via: "disabled" };
  // Windows inherits its user/system PATH; Unix login flags do not apply even
  // when Git Bash happens to set SHELL in the parent environment.
  if (platform === "win32") return { path: inheritedPath(env, platform), via: "inherited" };
  const o = {
    shell: opts.shell ?? env.SHELL ?? (platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
    timeoutMs: opts.timeoutMs ?? 10_000,
    // TERM=dumb keeps prompt themes quiet; the child never gets a tty.
    env: { ...env, TERM: "dumb" },
    execFileImpl: opts.execFileImpl ?? (execFile as unknown as ExecFileLike),
  };
  const interactive = await run("-ilc", o);
  if (interactive) return { path: interactive, via: "-ilc" };
  const login = await run("-lc", o);
  if (login) return { path: login, via: "-lc" };
  return { path: null, via: "none" };
}

/** Joins PATH lists in priority order, dropping empties and duplicates. */
export function mergePaths(...lists: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const dir of (list ?? "").split(path.delimiter)) {
      const d = dir.trim();
      if (!d || seen.has(d)) continue;
      seen.add(d);
      out.push(d);
    }
  }
  return out.join(path.delimiter);
}

/** Directories worth having even when the login shell cannot be read. */
export function fallbackDirs(home = os.homedir()): string {
  return ["/opt/homebrew/bin", "/usr/local/bin", path.join(home, ".local", "bin")].join(path.delimiter);
}

/**
 * Resolves the login PATH and writes the merged result into `env.PATH` (login first, then what
 * the process already had, then the fallbacks). Safe to call when launched from a terminal:
 * the result is a superset of the existing PATH.
 */
export async function hydratePath(env: NodeJS.ProcessEnv = process.env, opts: Omit<LoginPathOptions, "env"> = {}): Promise<LoginPathResult & { merged: string }> {
  const r = await readLoginPath({ ...opts, env });
  // Opting out means the process PATH is used exactly as given — no fallbacks either.
  if (r.via === "disabled") return { ...r, merged: inheritedPath(env, opts.platform ?? process.platform) };
  if (r.via === "inherited") {
    // Downstream CLI discovery uses PATH. Remove alternate spellings so Node
    // cannot pass a stale Path value to a child instead of the canonical one.
    for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
    env.PATH = r.path ?? "";
    return { ...r, merged: env.PATH };
  }
  const merged = mergePaths(r.path, env.PATH, fallbackDirs(env.HOME ?? os.homedir()));
  env.PATH = merged;
  return { ...r, merged };
}
