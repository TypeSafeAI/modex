import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";

function regular(file: string): boolean {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** Recognize npm's plain Node/native shim, never reinterpret a custom batch program. */
function npmTarget(contents: string): { entry: string; node: boolean } | null {
  const lines = contents.replace(/\r\n/g, "\n").trim().split("\n").map(line => line.trim()).filter(Boolean);
  const last = lines.at(-1) ?? "";
  const target = last.match(/"%dp0%\\([^"%\r\n]+)"\s+%\*$/)?.[1];
  if (!target || !/\.(?:c?js|mjs|exe)$/i.test(target)) return null;
  const node = !/\.exe$/i.test(target);
  const prefix = ["@echo off", "goto start", ":find_dp0", "set dp0=%~dp0", "exit /b", ":start", "setlocal", "call :find_dp0"];
  if (!node) {
    const normalized = lines.map(line => line.replace(`"%dp0%\\${target}"`, '"<entry>"').replace(/\s+/g, " ").toLowerCase());
    const expected = [...prefix, '"<entry>" %*'];
    return normalized.length === expected.length && normalized.every((line, i) => line === expected[i]) ? { entry: target, node } : null;
  }
  // npm versions differ only in where they remove .JS from PATHEXT. Node
  // receives the script and argv directly, so neither batch command runs.
  const pathext = "set PATHEXT=%PATHEXT:;.JS;=;%";
  const normalized = lines.filter(line => line.toLowerCase() !== pathext.toLowerCase()).map(line =>
    line.replace(`"%dp0%\\${target}"`, '"<entry>"').replace(`${pathext} & `, "").replace(/\s+/g, " ").toLowerCase());
  const expected = [
    ...prefix,
    'if exist "%dp0%\\node.exe" (', 'set "_prog=%dp0%\\node.exe"', ") else (", 'set "_prog=node"', ")",
    'endlocal & goto #_undefined_# 2>nul || title %comspec% & "%_prog%" "<entry>" %*',
  ];
  return normalized.length === expected.length && normalized.every((line, i) => line === expected[i]) ? { entry: target, node } : null;
}

/** Resolve Windows npm launchers without cmd.exe's quoting and line-length semantics. */
export function prepareCliLaunch(bin: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): { file: string; args: string[] } {
  if (platform !== "win32" || /\.(?:exe|com)$/i.test(bin)) return { file: bin, args: [...args] };
  const unsupported = () => new Error("Choose a native CLI executable or a standard npm launcher. Custom Windows batch commands are unsupported.");
  if (!/\.cmd$/i.test(bin) || !path.win32.isAbsolute(bin)) throw unsupported();
  const stat = fs.statSync(bin);
  if (!stat.isFile() || stat.size > 65536) throw unsupported();
  const target = npmTarget(fs.readFileSync(bin, "utf8"));
  if (!target) throw unsupported();
  const entry = path.win32.resolve(path.win32.dirname(bin), target.entry);
  if (!regular(entry)) throw new Error("The npm CLI entrypoint is missing. Reinstall the CLI, then retry.");
  if (!target.node) return { file: entry, args: [...args] };
  const key = Object.keys(env).sort().find(key => key.toUpperCase() === "PATH");
  const directories = (key ? env[key] ?? "" : "").split(";").map(dir => dir.replace(/^"(.*)"$/, "$1"))
    .filter(dir => /^[A-Za-z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(dir));
  const node = [path.win32.join(path.win32.dirname(bin), "node.exe"), ...directories.map(dir => path.win32.join(dir, "node.exe"))].find(regular);
  if (!node) throw new Error("This npm CLI needs Node.js on PATH. Install Node.js or choose a native CLI executable.");
  return { file: node, args: [entry, ...args] };
}

export function cliSpawn(bin: string, args: readonly string[], options: SpawnOptions): ChildProcess {
  if (options.shell) throw new Error("CLI launches do not accept shell commands.");
  const launch = prepareCliLaunch(bin, args, options.env);
  if (process.platform === "win32") {
    const supervisor = fileURLToPath(new URL("./cli-supervisor.exe", import.meta.url)).replace(/app\.asar([\\/])/, "app.asar.unpacked$1");
    return spawn(supervisor, [String(process.pid), launch.file, ...launch.args], { ...options, shell: false, windowsHide: true });
  }
  return spawn(launch.file, launch.args, { ...options, shell: false, windowsHide: true });
}
