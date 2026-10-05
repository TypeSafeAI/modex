import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { pinnedDesktopCertificate } from "./desktop-client.js";
import { DESKTOP_PROTOCOL } from "../../shared/desktop-protocol.js";

export interface DiscoveredDesktop { port: number; fingerprint: string; version: string }
const fingerprintPattern = /^[a-f0-9]{64}$/;
const helper = fileURLToPath(new URL("./desktop-system", import.meta.url)).replace(/app\.asar\//, "app.asar.unpacked/");
export async function desktopSystem(action: "directory" | "installed" | "launch", appPath?: string): Promise<string> {
  const result = await promisify(execFile)(helper, [action, ...(appPath ? [appPath] : [])], { timeout: 15_000, maxBuffer: 8192 });
  return result.stdout.trim();
}

export function publishDesktop(directory: string, host: DiscoveredDesktop): () => void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${host.fingerprint}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...host, protocol: DESKTOP_PROTOCOL }), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return () => { try { fs.rmSync(file, { force: true }); } catch { /* Stale records fail the live TLS probe. */ } };
}

/** Discovery shares only public host identity. A live TLS pin check precedes every offer. */
export async function discoverDesktops(directory: string): Promise<DiscoveredDesktop[]> {
  let files: string[];
  try { files = fs.readdirSync(directory).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 16); } catch { return []; }
  const results = await Promise.all(files.map(async (name) => {
    try {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 4096) return;
      const host = JSON.parse(fs.readFileSync(file, "utf8")) as DiscoveredDesktop & { protocol: number };
      if (host.protocol !== DESKTOP_PROTOCOL || !Number.isInteger(host.port) || host.port < 1024 || host.port > 65535
        || !fingerprintPattern.test(host.fingerprint) || name !== `${host.fingerprint}.json`
        || typeof host.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(host.version)) return;
      await pinnedDesktopCertificate(host.port, host.fingerprint, 600);
      return { port: host.port, fingerprint: host.fingerprint, version: host.version };
    } catch { return; }
  }));
  return results.filter((host): host is DiscoveredDesktop => !!host);
}
