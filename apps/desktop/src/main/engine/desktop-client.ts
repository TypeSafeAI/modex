import crypto from "node:crypto";
import https from "node:https";
import tls from "node:tls";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { DESKTOP_PROTOCOL, type DesktopConnectionStatus } from "../../shared/desktop-protocol.js";

export interface DesktopCredentials { port: number; fingerprint: string; token: string; clientId: string }
export type { DesktopConnectionStatus } from "../../shared/desktop-protocol.js";
export class DesktopIdentityError extends Error {
  constructor(message: string) { super(message); this.name = "DesktopIdentityError"; }
}
const identityCodes = new Set(["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_SIGNATURE_FAILURE", "UNABLE_TO_GET_ISSUER_CERT", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"]);
function identityFailure(error: unknown): boolean {
  return error instanceof DesktopIdentityError || (error instanceof Error && "code" in error && identityCodes.has(String(error.code)));
}
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
export async function pinnedDesktopCertificate(port: number, fingerprint: string, timeoutMs = 5000): Promise<string> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !hex.test(fingerprint)) throw new Error("Invalid host identity.");
  return new Promise((resolve, reject) => {
    // The host uses an app-owned self-signed certificate, so the invitation/discovery
    // fingerprint is the trust root. The connection sends no data before the raw DER,
    // validity window and loopback identity checks below succeed.
    // codeql[js/disabling-certificate-validation]
    const socket = tls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false, minVersion: "TLSv1.2" });
    const fail = (error: Error) => { socket.destroy(); reject(error); };
    socket.once("error", fail);
    socket.setTimeout(timeoutMs, () => fail(new Error("Start your Modex host to connect.")));
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      const digest = cert.raw && crypto.createHash("sha256").update(cert.raw).digest("hex");
      if (digest !== fingerprint) return fail(new DesktopIdentityError("The host identity changed. Check your trusted Modex host before reconnecting."));
      const from = Date.parse(cert.valid_from), to = Date.parse(cert.valid_to);
      if (!Number.isFinite(from) || !Number.isFinite(to) || from > Date.now() || to < Date.now()) return fail(new DesktopIdentityError("The host certificate is outside its valid dates. Check your Mac's clock and trusted host."));
      const identityError = tls.checkServerIdentity("127.0.0.1", cert);
      if (identityError) return fail(new DesktopIdentityError("The host certificate is not valid for this Mac."));
      const pem = `-----BEGIN CERTIFICATE-----\n${cert.raw.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
      socket.destroy();
      resolve(pem);
    });
  });
}

class HostResponseError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request(port: number, ca: string, endpoint: string, body: unknown, token?: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({ hostname: "127.0.0.1", port, path: endpoint, method: "POST", ca, rejectUnauthorized: true, signal,
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
          let value: Record<string, unknown>;
          try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
          catch (error) {
            if (res.statusCode === 401 || res.statusCode === 409) throw new HostResponseError("The host rejected this desktop connection.", res.statusCode);
            throw error;
          }
          if (res.statusCode !== 200) throw new HostResponseError(typeof value?.error === "string" ? value.error : "The host could not complete this action.", res.statusCode ?? 500);
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
  private authorization?: AbortController;
  private state: DesktopConnectionStatus = { state: "unpaired", detail: "Connect to your Modex host to open the workspace." };

  constructor(private readonly save: (credentials: DesktopCredentials | undefined) => void) { super(); }
  status(): DesktopConnectionStatus { return { ...this.state }; }
  private update(state: DesktopConnectionStatus): void { this.state = state; this.emit("status", this.status()); }

  async connectLocal(host: { port: number; fingerprint: string }, clientId: string): Promise<void> {
    if (!hex.test(clientId)) throw new Error("Invalid desktop installation identity.");
    this.dispose();
    const generation = this.generation;
    const authorization = new AbortController();
    this.authorization = authorization;
    const confirmationCode = crypto.randomInt(100000, 1000000).toString();
    this.update({ state: "authorizing", detail: "Confirm this code in the Modex host to use its workspace and existing CLI sign-ins.", confirmationCode });
    try {
      const ca = await pinnedDesktopCertificate(host.port, host.fingerprint);
      if (generation !== this.generation) throw new Error("Connection cancelled.");
      const result = await request(host.port, ca, "/connect", { clientId, confirmationCode, protocol: DESKTOP_PROTOCOL }, undefined, authorization.signal);
      if (generation !== this.generation) throw new Error("Connection cancelled.");
      if (result.protocol !== DESKTOP_PROTOCOL || typeof result.token !== "string" || !hex.test(result.token)) throw new Error("The host returned invalid desktop access.");
      const credentials = { port: host.port, fingerprint: host.fingerprint, token: result.token, clientId };
      this.save(credentials);
      this.start(credentials);
    } catch (error) {
      if (generation === this.generation) this.update({ state: "unpaired", detail: error instanceof Error ? error.message : "The host could not connect." });
      throw error;
    } finally { if (this.authorization === authorization) this.authorization = undefined; }
  }

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

  /** Revalidate the saved pin and reopen events. Never resubmit a workspace action. */
  retry(): void {
    if (this.state.state !== "recovery" || !this.credentials) throw new Error("There is no saved connection waiting for recovery.");
    this.start(this.credentials);
  }

  private recover(reason: "identity" | "protocol", detail?: string): void {
    this.dispose();
    this.update({ state: "recovery", reason, detail: reason === "identity"
      ? `${detail ?? "The host certificate no longer matches your saved access."} Your saved access and draft are kept.`
      : "The host desktop protocol is incompatible. Update the host and Store app, then retry. Your saved access and draft are kept." });
  }

  disconnect(): void {
    this.save(undefined);
    this.dispose();
    this.credentials = undefined;
    this.update({ state: "unpaired", detail: "Connect again with a new link from your Modex host." });
  }

  dispose(): void {
    ++this.generation;
    this.authorization?.abort();
    this.authorization = undefined;
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
      if (generation === this.generation) {
        if (error instanceof HostResponseError && error.status === 401) this.revoked();
        else if (error instanceof HostResponseError && error.status === 409) this.recover("protocol");
        else if (identityFailure(error)) this.recover("identity");
      }
      throw error;
    }
  }

  private async connect(generation: number): Promise<void> {
    const credentials = this.credentials;
    if (generation !== this.generation || !credentials) return;
    let ended = false;
    const retry = () => {
      if (generation !== this.generation || ended) return;
      ended = true;
      this.stream?.destroy();
      this.streamRequest?.destroy();
      this.ca = undefined;
      this.update({ state: "offline", detail: "Waiting for your Mac host. Your pairing and draft are kept." });
      this.timer = setTimeout(() => { this.timer = undefined; void this.connect(generation); }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 5000);
    };
    const failed = (error: unknown) => {
      if (generation !== this.generation || ended) return;
      if (identityFailure(error)) this.recover("identity", error instanceof DesktopIdentityError ? error.message : undefined);
      else retry();
    };
    try {
      const ca = await pinnedDesktopCertificate(credentials.port, credentials.fingerprint);
      if (generation !== this.generation) return;
      const req = https.get({ hostname: "127.0.0.1", port: credentials.port, path: "/events", ca, rejectUnauthorized: true, headers: { Authorization: `Bearer ${credentials.token}` } }, (res) => {
        if (generation !== this.generation) { res.destroy(); return; }
        if (res.statusCode === 401) { res.destroy(); this.revoked(); return; }
        if (res.statusCode === 409) { res.destroy(); this.recover("protocol"); return; }
        if (res.statusCode !== 200 || !res.headers["content-type"]?.startsWith("text/event-stream")) { res.destroy(); retry(); return; }
        this.stream = res;
        req.setTimeout(0);
        res.setTimeout(45_000, () => res.destroy());
        res.setEncoding("utf8");
        let buffer = "";
        res.on("data", (chunk: string) => {
          if (generation !== this.generation || ended) return;
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
                if (value?.protocol !== DESKTOP_PROTOCOL) { this.recover("protocol"); return; }
                this.ca = ca;
                this.retryDelay = 500;
                this.update({ state: "connected", detail: "Connected to your Mac host" });
                if (generation !== this.generation) return;
                this.emit("connected");
              } else if (this.state.state === "connected" && (kind === "thread" || kind === "terminal")) this.emit(kind, value);
            } catch { res.destroy(); }
          }
        });
        res.once("error", failed);
        res.once("close", retry);
      });
      this.streamRequest = req;
      req.setTimeout(10_000, () => req.destroy(new Error("Host connection timed out.")));
      req.once("error", failed);
    } catch (error) { failed(error); }
  }
}
