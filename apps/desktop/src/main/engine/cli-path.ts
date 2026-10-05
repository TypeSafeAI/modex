import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { probe } from "./backends/health.js";
import type { BackendHealth } from "../../shared/types.js";

type CodingCli = "claude" | "codex";
export type CliExecutable = string | (() => string);
interface Options { env?: NodeJS.ProcessEnv; timeoutMs?: number }
const label = (cli: CodingCli) => cli === "claude" ? "Claude Code" : "Codex";

function executable(file: string): boolean {
  try { return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true); }
  catch { return false; }
}

/** Search only install locations, never project directories or shell aliases/functions. */
function directories(env: NodeJS.ProcessEnv): string[] {
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
  const value = setting.trim();
  const automatic = !value || value === cli;
  const expanded = value.startsWith("~/") ? path.join(env.HOME ?? os.homedir(), value.slice(2)) : value;
  const candidates = automatic ? directories(env).map((dir) => path.join(dir, cli))
    : path.isAbsolute(expanded) ? [expanded]
    : /^[A-Za-z0-9._+-]+$/.test(value) ? directories(env).map((dir) => path.join(dir, value)) : [];
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
