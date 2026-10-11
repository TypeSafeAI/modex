import path from "node:path";
import { cliSpawn } from "../cli-launch.js";
import type { BackendHealth } from "../../../shared/types.js";

export { cliSpawn };

/** Keep an nvm CLI's adjacent Node runtime reachable even when a shell profile failed. */
export function cliEnvironment(bin: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const paths = platform === "win32" ? path.win32 : path;
  if (!paths.isAbsolute(bin)) return env;
  const result = { ...env };
  const key = platform === "win32" ? Object.keys(env).sort().find(key => key.toUpperCase() === "PATH") : "PATH";
  const inherited = key ? env[key] : undefined;
  if (platform === "win32") for (const name of Object.keys(result)) if (name.toUpperCase() === "PATH") delete result[name];
  result.PATH = [paths.dirname(bin), inherited].filter(Boolean).join(paths.delimiter);
  return result;
}

/** A bounded, non-inference CLI probe. Raw output never crosses IPC. */
export function probe(bin: string, args: string[], spawnImpl = cliSpawn, timeoutMs = 5000, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; output: string; failure?: "missing" | "timeout" | "failed" }> {
  return new Promise((resolve) => {
    let done = false;
    let output = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { code: number | null; output: string; failure?: "missing" | "timeout" | "failed" }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      const child = spawnImpl(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: cliEnvironment(bin, env) });
      child.stderr?.resume();
      child.stdout?.on("data", (data: Buffer) => {
        if (done) return;
        output += data.toString();
        if (output.length > 65536) { finish({ code: null, output: "", failure: "failed" }); child.kill(); }
      });
      child.on("error", (error: NodeJS.ErrnoException) => finish({ code: null, output: "", failure: error.code === "ENOENT" ? "missing" : "failed" }));
      child.on("close", (code) => finish({ code, output }));
      timer = setTimeout(() => { finish({ code: null, output: "", failure: "timeout" }); child.kill(); }, timeoutMs);
    } catch { finish({ code: null, output: "", failure: "failed" }); }
  });
}

export function health(authentication: BackendHealth["authentication"], detail: string, executable: BackendHealth["executable"] = "available", version?: string): BackendHealth {
  return { executable, authentication, access: "unverified", detail, ...(version ? { version } : {}) };
}

export async function installation(bin: string, spawnImpl = cliSpawn): Promise<{ version?: string; unavailable?: BackendHealth }> {
  const result = await probe(bin, ["--version"], spawnImpl);
  if (!result.failure && result.code === 0) {
    // Only a bounded version token leaves main; never return arbitrary CLI output to the renderer.
    return { version: result.output.match(/\b\d{1,4}\.\d{1,4}\.\d{1,4}(?:[-+][A-Za-z0-9.-]{1,32})?\b/)?.[0] };
  }
  return { unavailable: health("unknown", result.failure === "missing" ? "CLI not found" : result.failure === "timeout" ? "CLI check timed out" : "CLI check failed", result.failure === "missing" ? "missing" : "unknown") };
}
