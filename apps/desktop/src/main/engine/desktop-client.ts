import crypto from "node:crypto";
import https from "node:https";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { DESKTOP_PROTOCOL } from "../../shared/desktop-protocol.js";

export interface DesktopCredentials { port: number; fingerprint: string; token: string; clientId: string }
export interface DesktopConnectionStatus { state: "unpaired" | "connecting" | "connected" | "offline"; detail: string }
interface Invitation { port: number; fingerprint: string; code: string }
const hex = /^[a-f0-9]{64}$/;

export function parseDesktopInvitation(value: string): Invitation {
  if (value.length > 512) throw new Error("Paste the connection link from your Modex host.");
  const url = new URL(value.trim());
  const params = url.searchParams;
  const port = Number(params.get("port"));
  const fingerprint = params.get("fingerprint") ?? "";
  const code = params.get("code") ?? "";
  if (url.protocol !== "modex-desktop:" || url.hostname !== "pair" || url.pathname || url.username || url.password || url.port || url.hash
    || [...params.keys()].length !== 3 || !["port", "fingerprint", "code"].every((key) => params.getAll(key).length === 1)
    || !Number.isInteger(port) || port < 1024 || port > 65535 || !hex.test(fingerprint) || !hex.test(code)) throw new Error("This is not a valid Modex desktop connection link.");
  return { port, fingerprint, code };
}

/** Inspect a TLS certificate without sending HTTP, pairing codes or access tokens. */
export async function pinnedDesktopCertificate(port: number, fingerprint: string): Promise<string> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !hex.test(fingerprint)) throw new Error("Invalid host identity.");
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.once("error", fail);
    socket.setTimeout(5000, () => fail(new Error("Start your Modex host to connect.")));
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const digest = cert.raw && crypto.createHash("sha256").update(cert.raw).digest("hex");
      if (digest !== fingerprint || Date.parse(cert.valid_from) > Date.now() || Date.parse(cert.valid_to) < Date.now()) return fail(new Error("The host identity changed. Create a new link from your trusted Modex host."));
      const identityError = tls.checkServerIdentity("127.0.0.1", cert);
      if (identityError) return fail(new Error("The host certificate is not valid for this Mac."));
      const pem = `-----BEGIN CERTIFICATE-----\n${cert.raw.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
      socket.destroy();
      resolve(pem);
    });
  });
}

class HostResponseError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request(port: number, ca: string, endpoint: string, body: unknown, token?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname: "127.0.0.1", port, path: endpoint, method: "POST", ca, rejectUnauthorized: true,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("error", reject);
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { res.destroy(); reject(new Error("The host response was too large.")); }
        else chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) throw new Error("Host redirects are not allowed.");
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          if (res.statusCode !== 200) throw new HostResponseError(typeof value.error === "string" ? value.error : "The host could not complete this action.", res.statusCode ?? 500);
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.once("error", reject);
    req.setTimeout(180_000, () => req.destroy(new Error("The host did not respond. Check its connection and retry.")));
    req.end(data);
  });
}

/** Credentials stay in the Store app's main process; the renderer receives status and events only. */
export class DesktopClient extends EventEmitter {
  private credentials?: DesktopCredentials;
  private ca?: string;
  private generation = 0;
  private stream?: IncomingMessage;
  private streamRequest?: ClientRequest;
  private timer?: ReturnType<typeof setTimeout>;
  private retryDelay = 500;
  private state: DesktopConnectionStatus = { state: "unpaired", detail: "Connect to your Modex host to open the workspace." };

  constructor(private readonly save: (credentials: DesktopCredentials | undefined) => void) { super(); }
  status(): DesktopConnectionStatus { return { ...this.state }; }
  private update(state: DesktopConnectionStatus): void { this.state = state; this.emit("status", this.status()); }

  async pair(uri: string, clientId: string): Promise<void> {
    if (!hex.test(clientId)) throw new Error("Invalid desktop installation identity.");
    const generation = this.generation;
    const invitation = parseDesktopInvitation(uri);
    const ca = await pinnedDesktopCertificate(invitation.port, invitation.fingerprint);
    if (generation !== this.generation) throw new Error("Pairing was cancelled.");
    const result = await request(invitation.port, ca, "/pair", { code: invitation.code, clientId, name: "Modex Store Preview", protocol: DESKTOP_PROTOCOL });
    if (generation !== this.generation) throw new Error("Pairing was cancelled.");
    if (result.protocol !== DESKTOP_PROTOCOL || typeof result.token !== "string" || !hex.test(result.token)) throw new Error("The host returned invalid desktop access.");
    const credentials = { port: invitation.port, fingerprint: invitation.fingerprint, token: result.token, clientId };
    this.save(credentials);
    this.start(credentials);
  }

  start(credentials: DesktopCredentials): void {
    if (!hex.test(credentials.token) || !hex.test(credentials.clientId) || !hex.test(credentials.fingerprint) || !Number.isInteger(credentials.port) || credentials.port < 1024 || credentials.port > 65535) throw new Error("Saved desktop access is invalid. Pair again from the host.");
    this.dispose();
    this.credentials = credentials;
    this.retryDelay = 500;
    this.update({ state: "connecting", detail: "Connecting to your trusted Mac host…" });
    void this.connect(this.generation);
  }

  disconnect(): void {
    this.save(undefined);
    this.dispose();
    this.credentials = undefined;
    this.update({ state: "unpaired", detail: "Connect again with a new link from your Modex host." });
  }

  dispose(): void {
    ++this.generation;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.stream?.destroy();
    this.streamRequest?.destroy();
    this.stream = undefined;
    this.streamRequest = undefined;
    this.ca = undefined;
  }

  private revoked(): void {
    try { this.save(undefined); } catch { /* A persisted revoked token cannot regain host access. */ } finally {
      this.dispose();
      this.credentials = undefined;
      this.update({ state: "unpaired", detail: "Your Mac removed this desktop's access. Create a new connection link in the host." });
    }
  }

  async invoke(channel: string, payload: unknown): Promise<unknown> {
    const credentials = this.credentials;
    const generation = this.generation;
    if (!credentials || !this.ca || this.state.state !== "connected") throw new Error("Your Mac host is disconnected. Your draft is still here; retry when it reconnects.");
    try {
      const result = await request(credentials.port, this.ca, "/invoke", { channel, payload, protocol: DESKTOP_PROTOCOL }, credentials.token);
      if (generation !== this.generation) throw new Error("The desktop connection changed during this action.");
      return result.value;
    } catch (error) {
      if (generation === this.generation && error instanceof HostResponseError && error.status === 401) this.revoked();
      throw error;
    }
  }

  private async connect(generation: number): Promise<void> {
    const credentials = this.credentials;
    if (generation !== this.generation || !credentials) return;
    const retry = () => {
      if (generation !== this.generation || this.timer) return;
      this.ca = undefined;
      this.update({ state: "offline", detail: "Waiting for your Mac host. Your pairing and draft are kept." });
      this.timer = setTimeout(() => { this.timer = undefined; void this.connect(generation); }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 5000);
    };
    try {
      const ca = await pinnedDesktopCertificate(credentials.port, credentials.fingerprint);
      if (generation !== this.generation) return;
      const req = https.get({ hostname: "127.0.0.1", port: credentials.port, path: "/events", ca, rejectUnauthorized: true, headers: { Authorization: `Bearer ${credentials.token}` } }, (res) => {
        if (generation !== this.generation) { res.destroy(); return; }
        if (res.statusCode === 401) { res.destroy(); this.revoked(); return; }
        if (res.statusCode !== 200 || !res.headers["content-type"]?.startsWith("text/event-stream")) { res.destroy(); retry(); return; }
        this.stream = res;
        req.setTimeout(0);
        res.setTimeout(45_000, () => res.destroy());
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
          if (generation !== this.generation) return;
          buffer += chunk;
          if (buffer.length > 1024 * 1024) { res.destroy(); return; }
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const kind = frame.match(/^event: (.+)$/m)?.[1];
            const data = frame.match(/^data: (.+)$/m)?.[1];
            if (!kind || !data) continue;
            try {
              const value = JSON.parse(data) as Record<string, unknown>;
              if (kind === "revoked") { this.revoked(); return; }
              if (kind === "connected") {
                if (value.protocol !== DESKTOP_PROTOCOL) throw new Error("Incompatible host.");
                this.ca = ca;
                this.retryDelay = 500;
                this.update({ state: "connected", detail: "Connected to your Mac host" });
                this.emit("connected");
              } else if (this.state.state === "connected" && (kind === "thread" || kind === "terminal")) this.emit(kind, value);
            } catch { res.destroy(); }
          }
        });
        res.once("error", retry);
        res.once("close", retry);
      });
      this.streamRequest = req;
      req.setTimeout(10_000, () => req.destroy(new Error("Host connection timed out.")));
      req.once("error", retry);
    } catch { retry(); }
  }
}
