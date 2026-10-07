import crypto, { X509Certificate } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import type { AppState, ApprovalAnswer, BackendId, Thread, ThreadItem } from "../../shared/types.js";
import { publishCompanion, type CompanionPublisher } from "./companion-discovery.js";
import { discoverMobileCommands } from "./mobile-commands.js";

interface CompanionSource {
  state(): AppState;
  items(threadId: string): ThreadItem[];
  status(threadId: string): string;
  create?(projectId: string, options: { worktree: boolean; backend?: BackendId; auto?: boolean }): Promise<Thread>;
  send(threadId: string, text: string): Promise<{ ok: boolean; error?: string }>;
  answer(threadId: string, itemId: string, answer: ApprovalAnswer): void;
}

interface Config { enabled: boolean; token: string; port?: number }
export interface CompanionStatus { enabled: boolean; addresses: string[]; port?: number; pairingUri?: string }

/** A deliberately small, paired LAN API. Coding turns still run in the Mac's CLI-backed runner. */
export class CompanionServer {
  private server: https.Server | null = null;
  private starting: Promise<CompanionStatus> | null = null;
  private generation = 0;
  private port = 0;
  private host = "";
  private config: Config;
  private fingerprint = "";
  private monitor?: ReturnType<typeof setInterval>;
  private unpublish?: () => void;
  private reconnecting: Promise<void> | null = null;
  private readonly dir: string;

  constructor(home: string, private readonly source: CompanionSource, private readonly addresses = localAddresses, private readonly publish: CompanionPublisher = publishCompanion) {
    this.dir = path.join(home, "companion");
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = path.join(this.dir, "config.json");
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<Config>;
      this.config = {
        enabled: raw.enabled === true,
        token: typeof raw.token === "string" && /^[a-f0-9]{64}$/.test(raw.token) ? raw.token : crypto.randomBytes(32).toString("hex"),
        ...(typeof raw.port === "number" && Number.isInteger(raw.port) && raw.port >= 1024 && raw.port <= 65535 ? { port: raw.port } : {}),
      };
    } catch {
      this.config = { enabled: false, token: crypto.randomBytes(32).toString("hex") };
    }
    this.save();
  }

  get shouldStart(): boolean { return this.config.enabled; }

  private save(): void {
    const file = path.join(this.dir, "config.json");
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.config), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private certificate(): { key: Buffer; cert: Buffer } {
    const keyFile = path.join(this.dir, "key.pem");
    const certFile = path.join(this.dir, "cert.pem");
    if (!fs.existsSync(keyFile) || !fs.existsSync(certFile)) {
      // macOS ships openssl. Keep this key outside the app bundle and never copy it to the phone.
      // LibreSSL defaults to explicit EC parameters, which Electron and iOS TLS reject.
      execFileSync(process.platform === "darwin" ? "/usr/bin/openssl" : "openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-pkeyopt", "ec_param_enc:named_curve", "-nodes", "-sha256", "-days", "3650", "-subj", "/CN=Modex Companion", "-addext", "basicConstraints=CA:FALSE", "-keyout", keyFile, "-out", certFile], { stdio: "ignore" });
      fs.chmodSync(keyFile, 0o600);
      fs.chmodSync(certFile, 0o600);
    }
    const key = fs.readFileSync(keyFile);
    const cert = fs.readFileSync(certFile);
    this.fingerprint = crypto.createHash("sha256").update(new X509Certificate(cert).raw).digest("hex");
    return { key, cert };
  }

  start(): Promise<CompanionStatus> {
    this.monitor ??= setInterval(() => { void this.refreshNetwork().catch(() => {}); }, 2500).unref();
    if (this.server) return Promise.resolve(this.status());
    if (this.starting) return this.starting;
    const starting = this.listen(++this.generation).finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  private async listen(generation: number): Promise<CompanionStatus> {
    const host = this.addresses()[0];
    if (!host) throw new Error("Connect your Mac to a local network before turning on the iPhone companion.");
    const { key, cert } = this.certificate();
    const server = https.createServer({ key, cert, minVersion: "TLSv1.2" }, (req, res) => {
      void this.handle(server, req, res).catch(() => this.reply(res, 500, { error: "Your Mac could not complete the request." }));
    });
    const bindHost = host === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0";
    const listen = (port: number): Promise<void> => new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, bindHost, () => { server.off("error", reject); resolve(); });
      });
    try {
      await listen(this.config.port ?? 0);
    } catch (err) {
      if (!this.config.port || (err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
      // A different process can claim the old port while Modex is closed.
      await listen(0);
    }
    if (generation !== this.generation) {
      await this.close(server);
      return this.status();
    }
    this.server = server;
    this.host = host;
    this.port = (server.address() as AddressInfo).port;
    this.config.enabled = true;
    this.config.port = this.port;
    this.save();
    this.unpublish = this.publish({ host, port: this.port, fingerprint: this.fingerprint });
    return this.status();
  }

  /** Refresh LAN discovery without interrupting the listener; rebind when its scope changes. */
  refreshNetwork(): Promise<void> {
    if (this.reconnecting) return this.reconnecting;
    const reconnecting = (async () => {
      if (!this.config.enabled || !this.monitor || this.starting) return;
      const host = this.addresses()[0] ?? "";
      if (this.server && this.host !== host) {
        const wasLoopback = this.host === "127.0.0.1";
        const isLoopback = host === "127.0.0.1";
        if (!host || wasLoopback !== isLoopback) {
          const server = this.server;
          this.server = null;
          this.generation += 1;
          this.host = "";
          this.port = 0;
          this.unpublish?.();
          this.unpublish = undefined;
          await this.close(server);
        } else {
          this.host = host;
          this.unpublish?.();
          this.unpublish = this.publish({ host, port: this.port, fingerprint: this.fingerprint });
        }
      }
      if (this.config.enabled && this.monitor && !this.server && host) await this.start();
    })().finally(() => { if (this.reconnecting === reconnecting) this.reconnecting = null; });
    this.reconnecting = reconnecting;
    return reconnecting;
  }

  async stop(): Promise<CompanionStatus> {
    this.config.enabled = false;
    this.save();
    await this.dispose();
    return this.status();
  }

  async dispose(): Promise<void> {
    clearInterval(this.monitor);
    this.monitor = undefined;
    this.unpublish?.();
    this.unpublish = undefined;
    this.generation += 1;
    const starting = this.starting;
    this.starting = null;
    const server = this.server;
    this.server = null;
    this.port = 0;
    this.host = "";
    if (server) await this.close(server);
    await starting?.catch(() => {});
  }

  private close(server: https.Server): Promise<void> {
    return new Promise((resolve) => {
      server.close(() => resolve());
      // A partial upload must not keep access open or prevent the Mac app from quitting.
      server.closeAllConnections();
    });
  }

  resetAccess(): CompanionStatus {
    this.config.token = crypto.randomBytes(32).toString("hex");
    this.save();
    return this.status();
  }

  status(): CompanionStatus {
    const addresses = this.addresses();
    const host = addresses[0];
    // Do not offer a stale QR while offline or awaiting a loopback/LAN rebind.
    if (!this.server || !host || (host === "127.0.0.1") !== (this.host === "127.0.0.1")) {
      return { enabled: this.config.enabled, addresses };
    }
    const data = Buffer.from(JSON.stringify({ url: `https://${host}:${this.port}`, token: this.config.token, fingerprint: this.fingerprint })).toString("base64url");
    return { enabled: true, addresses, port: this.port, pairingUri: `modex://pair?data=${data}` };
  }

  private reply(res: ServerResponse, code: number, body: unknown): void {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    let text = "";
    for await (const chunk of req) {
      text += chunk.toString();
      if (text.length > 32_768) throw new Error("Request is too large.");
    }
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Expected a JSON object.");
    return parsed as Record<string, unknown>;
  }

  private async handle(server: https.Server, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const supplied = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? "")?.[1];
    const authorized = () => server === this.server && !!supplied && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(this.config.token));
    if (!authorized()) {
      this.reply(res, 401, { error: "Pair this phone again in Modex on your Mac." });
      return;
    }
    const url = new URL(req.url ?? "/", "https://localhost");
    if (req.method === "GET" && url.pathname === "/v1/snapshot") {
      const state = this.source.state();
      const threadId = url.searchParams.get("threadId");
      const thread = threadId ? state.threads.find((t) => t.id === threadId) : undefined;
      // Return the current list even if the selected thread was deleted on the Mac.
      // The phone can then leave that transcript without treating this as a lost connection.
      this.reply(res, 200, {
        projects: state.projects.map((p) => ({ id: p.id, name: p.name })),
        threads: state.threads.map((t) => mobileThread(t, this.source.status(t.id))),
        items: thread ? this.source.items(thread.id).map(mobileItem) : [],
        defaultBackend: state.settings.default_backend ?? "codex",
        autoByDefault: state.settings.routing?.auto_by_default ?? false,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/commands") {
      const state = this.source.state();
      const project = state.projects.find((candidate) => candidate.id === url.searchParams.get("projectId"));
      const backend = url.searchParams.get("backend");
      if (!project) { this.reply(res, 404, { error: "Project not found." }); return; }
      if (backend !== "codex" && backend !== "claude" && backend !== "mock") { this.reply(res, 400, { error: "Choose a valid provider." }); return; }
      this.reply(res, 200, { commands: discoverMobileCommands(os.homedir(), project.path, backend) });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/threads") {
      let input: Record<string, unknown>;
      try { input = await this.body(req); }
      catch { this.reply(res, 400, { error: "Invalid request body." }); return; }
      if (!authorized()) { this.reply(res, 401, { error: "Pair this phone again in Modex on your Mac." }); return; }
      const projectId = input.projectId;
      const value = input.text;
      if (typeof projectId !== "string" || !this.source.state().projects.some((project) => project.id === projectId)) { this.reply(res, 404, { error: "Project not found." }); return; }
      if (typeof value !== "string" || !value.trim() || value.length > 20_000) { this.reply(res, 400, { error: "Enter a message under 20,000 characters." }); return; }
      if (typeof input.worktree !== "boolean") { this.reply(res, 400, { error: "Choose Local or Worktree." }); return; }
      const backend = input.backend;
      if (backend !== undefined && backend !== "codex" && backend !== "claude" && backend !== "mock") { this.reply(res, 400, { error: "Choose a valid provider." }); return; }
      if (typeof input.auto !== "boolean") { this.reply(res, 400, { error: "Choose Auto or a provider." }); return; }
      if (!this.source.create) { this.reply(res, 501, { error: "Thread creation is unavailable." }); return; }
      const thread = await this.source.create(projectId, { worktree: input.worktree, ...(backend ? { backend } : {}), auto: input.auto });
      if (!authorized()) { this.reply(res, 401, { error: "Pair this phone again in Modex on your Mac." }); return; }
      const result = await this.source.send(thread.id, value.trim());
      if (!authorized()) { this.reply(res, 401, { error: "Pair this phone again in Modex on your Mac." }); return; }
      if (!result.ok) { this.reply(res, 409, { error: "The first turn could not start on your Mac." }); return; }
      this.reply(res, 201, { thread: mobileThread(thread, this.source.status(thread.id)) });
      return;
    }
    const match = /^\/v1\/threads\/([a-f0-9]{8})\/(send|answer)$/.exec(url.pathname);
    if (req.method !== "POST" || !match) { this.reply(res, 404, { error: "Not found." }); return; }
    const threadId = match[1]!;
    const action = match[2]!;
    if (!this.source.state().threads.some((t) => t.id === threadId)) { this.reply(res, 404, { error: "Thread not found." }); return; }
    let input: Record<string, unknown>;
    try { input = await this.body(req); }
    catch { this.reply(res, 400, { error: "Invalid request body." }); return; }
    if (!authorized()) { this.reply(res, 401, { error: "Pair this phone again in Modex on your Mac." }); return; }
    if (!this.source.state().threads.some((t) => t.id === threadId)) { this.reply(res, 404, { error: "Thread not found." }); return; }
    if (action === "send") {
      const value = input.text;
      if (typeof value !== "string" || !value.trim() || value.length > 20_000) { this.reply(res, 400, { error: "Enter a message under 20,000 characters." }); return; }
      if (this.source.status(threadId) !== "idle") { this.reply(res, 409, { error: "This thread is busy." }); return; }
      const result = await this.source.send(threadId, value.trim());
      if (!authorized()) { this.reply(res, 401, { error: "Pair this phone again in Modex on your Mac." }); return; }
      this.reply(res, result.ok ? 202 : 409, result.ok ? { ok: true } : { ok: false, error: "The follow-up could not start on your Mac." });
      return;
    }
    const itemId = input.itemId;
    const answer = input.answer;
    if (typeof itemId !== "string" || (answer !== "yes" && answer !== "no")) { this.reply(res, 400, { error: "Choose Approve or Deny." }); return; }
    const pending = this.source.items(threadId).some((item) => item.kind === "approval" && item.id === itemId && !item.answer);
    if (!pending || this.source.status(threadId) !== "waiting") { this.reply(res, 409, { error: "This approval is no longer pending." }); return; }
    this.source.answer(threadId, itemId, answer);
    this.reply(res, 200, { ok: true });
  }
}

function mobileThread(thread: Thread, status: string): Record<string, unknown> {
  return { id: thread.id, projectId: thread.projectId, title: thread.title, backend: thread.backend, status, updatedAt: thread.updatedAt };
}

function mobileItem(item: ThreadItem): Record<string, unknown> {
  switch (item.kind) {
    case "user": case "assistant": case "thinking": case "notice": return { id: item.id, kind: item.kind, text: item.text, at: item.at, ...(item.kind === "notice" ? { level: item.level } : {}) };
    case "approval": return { id: item.id, kind: item.kind, question: item.question, detail: item.detail, answer: item.answer, at: item.at };
    case "tool": return { id: item.id, kind: item.kind, title: item.title, status: item.status, ok: item.ok, at: item.at };
    case "route": return { id: item.id, kind: item.kind, text: `${item.backend} · ${item.model || "default"}`, at: item.at };
  }
}

function localAddresses(): string[] {
  const rank = (name: string) => name === "en0" ? 0 : name.startsWith("en") ? 1 : 2;
  return Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list ?? []).map((entry) => ({ ...entry, name })))
    .filter((entry) => entry.family === "IPv4" && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address))
    .sort((a, b) => rank(a.name) - rank(b.name))
    .map((entry) => entry.address);
}
