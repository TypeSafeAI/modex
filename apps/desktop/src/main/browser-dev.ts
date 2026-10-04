import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { BridgeCommands, ThreadEvent } from "../shared/types.js";
import { registerCommands } from "./commands.js";
import { Store } from "./engine/store.js";
import { ThreadRunner } from "./engine/runner.js";
import { TerminalManager } from "./engine/terminal.js";
import { SecretStore, noCipher } from "./engine/secrets.js";
import { hydratePath } from "./engine/shell-env.js";
import { openTerminal } from "./engine/open-terminal.js";

/** Local development transport only; never included in the packaged renderer. */
export function createBrowserDev(home: string) {
  const token = randomBytes(32).toString("hex");
  const store = new Store(home);
  const clients = new Set<ServerResponse>();
  const handlers = new Map<string, (payload: never) => unknown>();
  let closing = false;
  const pathReady = hydratePath(process.env).catch((error: Error) => {
    console.error("[modex] login-shell PATH failed:", error.message);
  });
  const broadcast = (kind: string, event: unknown) => {
    const message = `event: ${kind}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      // A background tab must not buffer unbounded terminal/agent output in the server.
      if (!client.write(message)) { client.end(); clients.delete(client); }
    }
  };
  const emit = (event: ThreadEvent) => broadcast("thread", event);
  const runner = new ThreadRunner({ home, store, emit, secrets: new SecretStore(home, noCipher), beforeDeleteThread: (id) => terminals.close(id) });
  const terminals = new TerminalManager((id) => {
    runner.assertThreadAvailable(id);
    return store.thread(id)!.cwd;
  }, (event) => broadcast("terminal", event), undefined, process.env,
  process.env.MODEX_E2E ? { file: "/bin/bash", args: ["--noprofile", "--norc"] } : undefined);
  registerCommands((channel, handler) => handlers.set(channel, handler as (payload: never) => unknown), {
    store, runner, terminals, emit,
    pickDirectory: async () => { throw new Error("Enter the local project folder's absolute path."); },
    openPath: async (path) => {
      const file = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
      await promisify(execFile)(file, [path]);
    },
    openTerminal,
  });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  };
  async function handle(req: IncomingMessage, res: ServerResponse, next: () => void): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!url.pathname.startsWith("/__modex/")) return next();
    const host = req.headers.host;
    const allowedHosts = [`127.0.0.1:${req.socket.localPort}`, `localhost:${req.socket.localPort}`];
    const suppliedToken = url.pathname === "/__modex/events" ? url.searchParams.get("token") : req.headers["x-modex-token"];
    if (!host || !allowedHosts.includes(host) || suppliedToken !== token
      || (req.headers.origin && req.headers.origin !== `http://${host}`)
      || (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))) {
      return json(res, 403, { error: "Untrusted browser bridge request." });
    }
    if (closing) return json(res, 503, { error: "Modex is shutting down." });
    if (url.pathname === "/__modex/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15_000);
      res.on("close", () => { clients.delete(res); clearInterval(heartbeat); });
      return;
    }
    if (url.pathname !== "/__modex/invoke" || req.method !== "POST") return json(res, 404, { error: "Unknown bridge endpoint." });
    if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Expected JSON." });
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024 * 1024) return json(res, 413, { error: "Bridge request too large." });
        chunks.push(chunk);
      }
      const { channel, payload } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { channel: keyof BridgeCommands; payload: never };
      const handler = handlers.get(channel);
      if (!handler) return json(res, 400, { error: "Unknown bridge command." });
      if (channel === "project:add") {
        const folder = (payload as BridgeCommands["project:add"]["req"])?.path;
        if (!folder || !path.isAbsolute(folder) || !fs.statSync(folder).isDirectory()) throw new Error("Choose an existing local project folder by its absolute path.");
      }
      await pathReady;
      if (closing) return json(res, 503, { error: "Modex is shutting down." });
      json(res, 200, { value: await handler(payload) });
    } catch (error) {
      json(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    token, handle,
    async dispose() {
      closing = true;
      for (const client of clients) client.end();
      clients.clear();
      const results = await Promise.allSettled([terminals.dispose(), runner.dispose()]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}
