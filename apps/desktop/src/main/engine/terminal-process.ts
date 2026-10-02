import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { IPty, IPtyForkOptions } from "node-pty";

const require = createRequire(import.meta.url);
type Pty = Pick<IPty, "pid" | "kill" | "onExit">;
const controls = new WeakMap<Pty, () => Promise<void>>();

export function spawnTerminal(shell: string, args: string[], options: IPtyForkOptions): IPty {
  const native = require("node-pty") as typeof import("node-pty");
  if (process.platform === "win32") return native.spawn(shell, args, options);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mx-"));
  const socketPath = path.join(dir, "control");
  let socket: net.Socket | undefined;
  let requested = false;
  let clean = false;
  let acknowledge!: () => void;
  let fail!: (error: Error) => void;
  const cleaned = new Promise<void>((resolve, reject) => { acknowledge = resolve; fail = reject; });
  // Natural shell exits can settle before an explicit close/dispose asks for the result.
  void cleaned.catch(() => {});
  const server = net.createServer((connection) => {
    if (socket) { connection.destroy(); return; }
    socket = connection;
    if (requested) connection.write("CLOSE\n");
    let buffer = "";
    let broken: Error | undefined;
    connection.on("data", (data) => {
      buffer += data.toString();
      if (buffer.split("\n").includes("CLEAN")) { clean = true; acknowledge(); }
    });
    // A supervisor that dies can surface as EPIPE/ECONNRESET (CLOSE written before its EOF was read)
    // or as a plain EOF. Both mean no cleanup receipt; "close" always follows "error" and says so.
    connection.on("error", (error) => { broken = error; });
    connection.on("close", () => { if (!clean) fail(new Error("Terminal supervisor exited without confirming cleanup.", { cause: broken })); });
  });
  server.on("error", fail);
  server.listen(socketPath);
  // Native executables need a real file outside Electron's virtual ASAR filesystem.
  const supervisor = fileURLToPath(new URL("./terminal-supervisor", import.meta.url)).replace(/app\.asar\//, "app.asar.unpacked/");
  let pty: IPty;
  try { pty = native.spawn(supervisor, [socketPath, shell, ...args], options); }
  catch (error) { server.close(); fs.rmSync(dir, { recursive: true, force: true }); throw error; }
  const exited = new Promise<void>((resolve) => {
    const subscription = pty.onExit(() => {
      subscription.dispose();
      resolve();
      setImmediate(() => { if (!socket) fail(new Error("Terminal supervisor exited before connecting.")); });
    });
  });
  const complete = Promise.all([cleaned, exited]).then(() => {});
  void complete.catch(() => {});
  void exited.then(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  controls.set(pty, async () => {
    requested = true;
    if (socket && !socket.destroyed && !clean) socket.write("CLOSE\n");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([complete, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Terminal commands did not stop; the working directory has been preserved.")), 5000);
      })]);
    } finally { clearTimeout(timer); }
  });
  return pty;
}

export async function stopTerminalProcess(pty: Pty): Promise<void> {
  const close = controls.get(pty);
  if (close) return close();
  if (process.platform !== "win32") throw new Error("Terminal has no cleanup supervisor.");
  await promisify(execFile)("taskkill", ["/pid", String(pty.pid), "/T", "/F"], { timeout: 5000 });
}
