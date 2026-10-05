import crypto, { X509Certificate } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DESKTOP_PROTOCOL } from "../../shared/desktop-protocol.js";

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const hex = /^[a-f0-9]{64}$/;
interface Grant { id: string; name: string; tokenHash: string; createdAt: string }
interface HostConfig { port?: number; grants: Grant[] }
interface HostSource {
  version: string;
  channels(): string[];
  invoke(channel: string, payload: unknown, authorized: () => boolean): Promise<unknown>;
}

/** Full desktop authority requires its own invitation; phone credentials never enter this transport. */
export class DesktopHost {
  private readonly dir: string;
  private config: HostConfig;
  private server?: https.Server;
  private fingerprint = "";
  private port = 0;
  private invitation?: { hash: string; expires: number };
  private readonly streams = new Map<ServerResponse, string>();
  private readonly pending = new Set<ServerResponse>();

  constructor(home: string, private readonly source: HostSource) {
    this.dir = path.join(home, "desktop-host");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.config = { grants: [] };
    const file = path.join(this.dir, "clients.json");
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, "utf8")) as HostConfig;
      if (!Array.isArray(saved.grants) || saved.grants.some((g) => !hex.test(g.id) || !hex.test(g.tokenHash) || typeof g.name !== "string" || typeof g.createdAt !== "string")) throw new Error("Desktop access records are invalid.");
      this.config = { grants: saved.grants, ...(Number.isInteger(saved.port) && saved.port! >= 1024 && saved.port! <= 65535 ? { port: saved.port } : {}) };
    }
  }

  private save(): void {
    const file = path.join(this.dir, "clients.json");
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(this.config), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  async start(): Promise<void> {
    if (this.server) return;
    const keyFile = path.join(this.dir, "key.pem");
    const certFile = path.join(this.dir, "cert.pem");
    if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
      execFileSync(process.platform === "darwin" ? "/usr/bin/openssl" : "openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-sha256", "-days", "3650", "-subj", "/CN=Modex Desktop Host", "-addext", "basicConstraints=CA:FALSE", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
      fs.chmodSync(keyFile, 0o600);
      fs.chmodSync(certFile, 0o600);
    }
    const cert = fs.readFileSync(certFile);
    this.fingerprint = crypto.createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
    const server = https.createServer({ key: fs.readFileSync(keyFile), cert, minVersion: "TLSv1.2" }, (req, res) => {
      void this.handle(req, res).catch(() => this.reply(res, 500, { error: "The host could not complete this request." }));
    });
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.config.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    this.config.port = this.port;
    this.save();
  }

  /** Called only by an explicit host-side pairing action. Replaces any outstanding invitation. */
  invite(): string {
    if (!this.server) throw new Error("Start the desktop host first.");
    const code = crypto.randomBytes(32).toString("hex");
    this.invitation = { hash: hash(code), expires: Date.now() + 5 * 60_000 };
    const query = new URLSearchParams({ port: String(this.port), fingerprint: this.fingerprint, code });
    return `modex-desktop://pair?${query}`;
  }

  clients(): { id: string; name: string; createdAt: string }[] {
    return this.config.grants.map(({ tokenHash: _secret, ...client }) => client);
  }

  revoke(id: string): void {
    this.config.grants = this.config.grants.filter((g) => g.id !== id);
    this.save();
    for (const [stream, owner] of this.streams) if (owner === id) {
      stream.write(`event: revoked\ndata: {}\n\n`);
      stream.end();
      this.streams.delete(stream);
    }
  }

  broadcast(kind: "thread" | "terminal", event: unknown): void {
    const message = `event: ${kind}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of this.streams.keys()) if (!stream.write(message)) {
      stream.destroy();
      this.streams.delete(stream);
    }
  }

  async dispose(): Promise<void> {
    this.invitation = undefined;
    for (const stream of this.streams.keys()) stream.destroy();
    for (const response of this.pending) response.destroy();
    this.streams.clear();
    this.pending.clear();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }

  private reply(res: ServerResponse, status: number, value: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(value));
  }

  private grant(req: IncomingMessage): Grant | undefined {
    const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if (!token) return;
    const digest = Buffer.from(hash(token), "hex");
    return this.config.grants.find((g) => crypto.timingSafeEqual(Buffer.from(g.tokenHash, "hex"), digest));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (req.headers["content-type"] !== "application/json") throw new Error("Expected JSON.");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error("Request is too large.");
      chunks.push(chunk);
    }
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected an object.");
    return body as Record<string, unknown>;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== `127.0.0.1:${this.port}` || req.headers.origin || req.headers["sec-fetch-site"]) return this.reply(res, 403, { error: "Untrusted desktop request." });
    if (req.url !== "/pair" && req.url !== "/invoke" && req.url !== "/events") return this.reply(res, 404, { error: "Unknown endpoint." });
    if (req.url === "/pair" && req.method === "POST") {
      let body: Record<string, unknown>;
      try { body = await this.body(req); } catch { return this.reply(res, 400, { error: "Invalid pairing request." }); }
      const { code, clientId, name, protocol } = body;
      const invitation = this.invitation;
      if (protocol !== DESKTOP_PROTOCOL) return this.reply(res, 409, { error: "Update the desktop client and host to compatible versions." });
      if (typeof code !== "string" || !hex.test(code) || !invitation || invitation.expires < Date.now() || !crypto.timingSafeEqual(Buffer.from(invitation.hash, "hex"), Buffer.from(hash(code), "hex"))) return this.reply(res, 401, { error: "Create a new connection link in the host." });
      if (typeof clientId !== "string" || !hex.test(clientId) || typeof name !== "string" || !name.trim() || name.length > 80 || /[\x00-\x1f]/.test(name)) return this.reply(res, 400, { error: "Invalid desktop identity." });
      this.invitation = undefined; // Consume synchronously, before any response or further await.
      this.revoke(clientId);
      const token = crypto.randomBytes(32).toString("hex");
      this.config.grants.push({ id: clientId, name: name.trim(), tokenHash: hash(token), createdAt: new Date().toISOString() });
      this.save();
      return this.reply(res, 200, { token, protocol: DESKTOP_PROTOCOL, version: this.source.version });
    }
    const grant = this.grant(req);
    if (!grant) return this.reply(res, 401, { error: "This desktop no longer has host access. Pair again from the host." });
    if (req.url === "/events" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      res.write(`event: connected\ndata: ${JSON.stringify({ protocol: DESKTOP_PROTOCOL, version: this.source.version })}\n\n`);
      this.streams.set(res, grant.id);
      const heartbeat = setInterval(() => { if (!res.write(": heartbeat\n\n")) res.destroy(); }, 15_000);
      res.on("close", () => { clearInterval(heartbeat); this.streams.delete(res); });
      return;
    }
    if (req.url !== "/invoke" || req.method !== "POST") return this.reply(res, 405, { error: "Unsupported method." });
    this.pending.add(res);
    res.once("close", () => this.pending.delete(res));
    try {
      const { channel, payload, protocol } = await this.body(req);
      if (protocol !== DESKTOP_PROTOCOL) return this.reply(res, 409, { error: "Desktop protocol mismatch." });
      if (typeof channel !== "string" || !this.source.channels().includes(channel)) return this.reply(res, 400, { error: "Unknown desktop command." });
      const authorized = () => Boolean(this.server && !res.destroyed && this.config.grants.some((g) => g.id === grant.id && g.tokenHash === grant.tokenHash));
      if (!authorized()) return this.reply(res, 401, { error: "Desktop access was revoked." });
      const value = await this.source.invoke(channel, payload, authorized);
      if (!authorized()) return this.reply(res, 401, { error: "Desktop access was revoked." });
      this.reply(res, 200, { value });
    } catch (error) {
      this.reply(res, 400, { error: error instanceof Error ? error.message : "Desktop command failed." });
    }
  }
}
