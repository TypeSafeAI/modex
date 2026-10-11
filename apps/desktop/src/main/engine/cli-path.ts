import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probe } from "./backends/health.js";
import type { BackendHealth } from "../../shared/types.js";

type CodingCli = "claude" | "codex" | "op";
export type CliExecutable = string | (() => string);
interface Options { env?: NodeJS.ProcessEnv; timeoutMs?: number; platform?: NodeJS.Platform }
const label = (cli: CodingCli) => cli === "claude" ? "Claude Code" : cli === "op" ? "1Password" : "Codex";

function executable(file: string): boolean {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); }
  catch { return false; }
}

/** Search only install locations, never project directories or shell aliases/functions. */
function windowsVariable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).sort().find(key => key.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function absolute(file: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return path.isAbsolute(file);
  // A leading slash alone uses the current drive; C:foo uses its current directory.
  return /^[A-Za-z]:[\\/]/.test(file) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(file);
}

function windowsNames(file: string, env: NodeJS.ProcessEnv): string[] {
  const supported = new Set([".exe", ".com", ".cmd"]);
  const extension = path.win32.extname(file).toLowerCase();
  if (extension) return supported.has(extension) ? [file] : [];
  const extensions = (windowsVariable(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").map(ext => ext.trim().toLowerCase()).filter(ext => supported.has(ext));
  return [...new Set(extensions)].map(ext => file + ext);
}

function directories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === "win32") {
    const fromPath = (windowsVariable(env, "PATH") ?? "").split(";").map(dir => dir.replace(/^"(.*)"$/, "$1")).filter(dir => absolute(dir, platform));
    const home = windowsVariable(env, "USERPROFILE") ?? os.homedir();
    const appData = windowsVariable(env, "APPDATA");
    const candidates = env.MODEX_NO_LOGIN_PATH ? fromPath : [...fromPath,
      ...[".local/bin", ".claude/local", ".volta/bin", ".bun/bin"].map(dir => path.win32.join(home, dir)),
      ...(appData ? [path.win32.join(appData, "npm")] : []),
      windowsVariable(env, "NVM_HOME") ?? "", windowsVariable(env, "NVM_SYMLINK") ?? ""];
    const seen = new Set<string>();
    return candidates.filter(dir => {
      if (!absolute(dir, platform) || seen.has(dir.toLowerCase())) return false;
      seen.add(dir.toLowerCase()); return true;
    });
  }
  const home = env.HOME ?? os.homedir();
  const fromPath = (env.PATH ?? "").split(path.delimiter).filter((dir) => path.isAbsolute(dir));
  if (env.MODEX_NO_LOGIN_PATH) return fromPath;
  const userDirs = [".local/bin", ".claude/local", ".volta/bin", ".asdf/shims", ".local/share/mise/shims", ".npm-global/bin", ".bun/bin"].map((dir) => path.join(home, dir));
  // A broken/slow shell profile can hide nvm entirely from a Finder launch.
  const nvm = path.join(env.NVM_DIR ?? path.join(home, ".nvm"), "versions/node");
  try {
    userDirs.push(...fs.readdirSync(nvm).filter((version) => /^v\d+\.\d+\.\d+$/.test(version))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).map((version) => path.join(nvm, version, "bin")));
  } catch { /* nvm is optional */ }
  return [...new Set([...fromPath, ...userDirs, "/opt/homebrew/bin", "/usr/local/bin"])];
}

/** Resolves afresh for each launch; a saved override is one executable, never a shell command. */
export function resolveCli(cli: CodingCli, setting: string, options: Options = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? path.win32 : path;
  const value = setting.trim();
  const automatic = !value || value === cli;
  const home = (platform === "win32" ? windowsVariable(env, "USERPROFILE") : env.HOME) ?? os.homedir();
  const expanded = value.startsWith("~/") || (platform === "win32" && value.startsWith("~\\")) ? paths.join(home, value.slice(2)) : value;
  const names = (file: string) => platform === "win32" ? windowsNames(file, env) : [file];
  const search = (name: string) => directories(env, platform).flatMap(dir => names(name).map(file => paths.join(dir, file)));
  const candidates = automatic ? search(cli)
    : absolute(expanded, platform) ? names(expanded)
    : /^[A-Za-z0-9._+-]+$/.test(value) ? search(value) : [];
  const found = candidates.find(executable);
  if (found) return found;
  const message = automatic ? `${label(cli)} CLI not found. Install it or choose an executable in Settings.`
    : `${label(cli)} executable is invalid or not executable. Enter its path without arguments, or clear the override for automatic discovery.`;
  throw Object.assign(new Error(message), { code: "ENOENT" });
}

/** No inference/auth request: check that the selected file runs and identifies the expected CLI. */
export async function verifyCliOverride(cli: CodingCli, value: string, options: Options = {}): Promise<string> {
  if (typeof value !== "string") throw new Error(`${label(cli)} executable must be a path.`);
  if (!value.trim() || value.trim() === cli) return cli;
  const bin = resolveCli(cli, value, options);
  const result = await probe(bin, ["--version"], undefined, options.timeoutMs ?? 5000, options.env);
  const identity = cli === "claude" ? /\b\d+\.\d+\.\d+[^\r\n]*\(Claude Code\)/i : /\bcodex-cli\s+\d+\.\d+\.\d+/i;
  if (result.failure === "timeout") throw new Error(`${label(cli)} executable check timed out. Settings were not saved.`);
  if (result.failure || result.code !== 0 || !identity.test(result.output)) throw new Error(`${label(cli)} executable could not be verified with --version. Choose the correct CLI; settings were not saved.`);
  return bin;
}

/** Keep a broken override local to its backend and show the actual executable used this session. */
export async function cliHealth(cli: CodingCli, setting: string, check: () => Promise<BackendHealth>): Promise<BackendHealth> {
  try {
    const resolvedPath = resolveCli(cli, setting);
    return { ...await check(), resolvedPath };
  } catch (error) {
    return { executable: "missing", authentication: "unknown", access: "unverified", detail: error instanceof Error ? error.message : "CLI check failed" };
  }
}
