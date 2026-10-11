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
import { LIMITS } from "../shared/attachments.js";
import { revealAttachment } from "./reveal-attachment.js";
import { openTerminal } from "./engine/open-terminal.js";

/** Local development transport only; never included in the packaged renderer. */
export function createBrowserDev(home: string) {
  const token = randomBytes(32).toString("hex");
  const store = new Store(home);
  const clients = new Set<ServerResponse>();
  const handlers = new Map<string, (payload: never) => unknown>();
  let closing = false;
  const uploads = new Set<IncomingMessage>();
  const maxEncodedFile = 4 * Math.ceil(LIMITS.fileBytes / 3);
  const maxUploadBody = maxEncodedFile + 2048;
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
    openTerminal, revealAttachment,
  });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    if (res.destroyed) return;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
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
    if (url.pathname === "/__modex/attachments/image" && req.method === "GET") {
      const image = runner.attachments.readImage(url.searchParams.get("rel") ?? "");
      if (!image) return json(res, 404, { error: "Attachment image unavailable." });
      res.writeHead(200, { "Content-Type": image.mime, "Content-Length": image.data.length,
        "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(image.data);
      return;
    }
    if (url.pathname === "/__modex/attachments/stage" && req.method === "POST") {
      if (req.headers["content-type"] !== "application/json") return json(res, 415, { error: "Expected JSON." });
      // One in-flight file across tabs. Body, decoded file, and JSON overhead stay bounded;
      // the ordinary invoke route keeps its 1 MiB cap. No disk writes precede complete parsing.
      if (uploads.size) return json(res, 429, { error: "Another attachment is uploading. Try again when it finishes." });
      const declared = req.headers["content-length"];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maxUploadBody)) {
        return json(res, 413, { error: "Attachment request too large." });
      }
      uploads.add(req);
      const timeout = setTimeout(() => req.destroy(), 30_000);
      let staged: { id: string }[] = [];
      const cleanup = () => {
        if (!res.writableFinished && staged.length) {
          const ids = staged.map(file => file.id); staged = [];
          try { runner.attachments.discard(ids); } catch { /* The store retains ownership for a later sweep if storage changed. */ }
        }
      };
      res.once("close", cleanup);
      res.once("error", cleanup);
      try {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > maxUploadBody) {
            res.shouldKeepAlive = false;
            req.resume();
            return json(res, 413, { error: "Attachment request too large." });
          }
          chunks.push(chunk);
        }
        if (!req.complete || (declared !== undefined && size !== Number(declared))) throw new Error("Incomplete upload");
        const payload = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
        if (!Array.isArray(payload?.files) || payload.files.length !== 1) return json(res, 400, { error: "Upload one attachment at a time." });
        const file = payload.files[0];
        if (file && typeof file.data === "string" && file.data.length > maxEncodedFile) return json(res, 413, { error: "Attachment request too large." });
        if (!file || typeof file.name !== "string" || file.name.length > 1024
          || (file.mime !== undefined && (typeof file.mime !== "string" || file.mime.length > 128))) {
          return json(res, 400, { error: "Invalid attachment metadata." });
        }
        if (closing || res.destroyed) return;
        const result = runner.attachments.stage(payload.files, { bytesOnly: true });
        staged = result.staged;
        json(res, 200, { value: result });
      } catch {
        cleanup();
        if (!req.aborted) json(res, 400, { error: "Invalid or incomplete attachment upload." });
      } finally {
        clearTimeout(timeout);
        uploads.delete(req);
      }
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
      for (const upload of uploads) upload.destroy();
      for (const client of clients) client.end();
      clients.clear();
      const results = await Promise.allSettled([terminals.dispose(), runner.dispose()]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    },
  };
}
