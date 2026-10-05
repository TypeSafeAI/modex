import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes, randomUUID, createHash, createPublicKey, verify, timingSafeEqual } from "node:crypto";
import type { Cipher } from "./secrets.js";
import type { ChatGPTStatus } from "../../shared/types.js";

const ISSUER = "https://auth.openai.com";
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const RESOURCE = "https://api.openai.com/v1";
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
interface Registration {
  id: string; subject: string; email: string; clientId: string;
  accessToken: string; refreshToken: string; idToken: string; expiresAt: number; scopes: string[];
}
interface Data { version: 1; hostId: string; active: string | null; registrations: Registration[] }
interface Tokens { access_token?: unknown; refresh_token?: unknown; id_token?: unknown; token_type?: unknown; expires_in?: unknown; scope?: unknown }
interface Metadata { issuer: string; jwks_uri: string; revocation_endpoint: string }
export interface AuthOptions {
  home: string; cipher: Cipher; openBrowser: (url: string) => Promise<unknown>;
  fetch?: typeof fetch; now?: () => number; timeoutMs?: number;
}

/** App-owned public-client OAuth. Secrets and raw provider errors never cross IPC. */
export class ChatGPTAuth {
  private readonly file: string;
  private readonly lock: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private locked = false;
  private attempt: AbortController | null = null;
  private signingOut = false;
  private disposed = false;
  private readonly refreshes = new Map<string, Promise<Registration>>();
  constructor(private readonly options: AuthOptions) {
    this.file = path.join(options.home, "app", "chatgpt.enc");
    this.lock = `${this.file}.lock`;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private read(): Data {
    if (!this.options.cipher.available()) throw new Error("Protected OS credential storage is unavailable.");
    if (!fs.existsSync(this.file)) return { version: 1, hostId: `urn:uuid:${randomUUID()}`, active: null, registrations: [] };
    try {
      const data = JSON.parse(this.options.cipher.decrypt(fs.readFileSync(this.file))) as Data;
      if (data.version !== 1 || typeof data.hostId !== "string" || !Array.isArray(data.registrations) ||
        (data.active !== null && (typeof data.active !== "string" || !data.registrations.some((r) => r.id === data.active)))) throw new Error();
      return data;
    } catch { throw new Error("ChatGPT credential storage could not be opened. Restore the OS keychain; credentials were preserved."); }
  }

  private own(): void {
    if (this.disposed) throw new Error("Modex is shutting down.");
    if (this.locked) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(this.lock, "wx", 0o600);
      try { fs.writeFileSync(fd, String(process.pid)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      this.locked = true;
    } catch { throw new Error("Another Modex instance may own ChatGPT credentials. Close it before signing in or refreshing; preserve the lock until its owner is verified stopped."); }
  }

  private write(data: Data): void {
    this.own();
    const blob = this.options.cipher.encrypt(JSON.stringify(data));
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, "wx", 0o600);
    try { fs.writeFileSync(fd, blob); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      fs.renameSync(temporary, this.file);
      if (process.platform !== "win32") {
        const directory = fs.openSync(path.dirname(this.file), "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }

  status(): ChatGPTStatus {
    try {
      const data = this.read();
      return {
        available: true, active: data.active, signingIn: this.attempt !== null,
        accounts: data.registrations.map((r) => ({ id: r.id, label: r.email || "ChatGPT account", registration: r.clientId, signedIn: Boolean(r.refreshToken), planEnabled: r.scopes.includes("chatgpt.tokens.use.direct") && r.scopes.includes("resource.invoke") && Boolean(r.refreshToken) })),
        detail: "Model access is unverified until a Codex turn completes.",
      };
    } catch { return { available: false, active: null, signingIn: false, accounts: [], detail: "Protected credential storage unavailable. Existing credentials were preserved." }; }
  }

  identity(): string { return fs.existsSync(this.file) ? this.read().active ?? "cli" : "cli"; }
  select(id: string | null): void {
    if (this.attempt || this.refreshes.size || this.signingOut) throw new Error("Wait for the account operation to finish.");
    const data = this.read();
    if (id !== null && !data.registrations.some((r) => r.id === id)) throw new Error("Unknown ChatGPT registration.");
    data.active = id; this.write(data);
  }
  cancel(): void { this.attempt?.abort(); }
  dispose(): void {
    this.disposed = true;
    this.cancel();
    if (this.locked && fs.readFileSync(this.lock, "utf8") === String(process.pid)) fs.unlinkSync(this.lock);
    this.locked = false;
  }

  private async json(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.any([AbortSignal.timeout(15000), ...(init.signal ? [init.signal] : [])]) });
    if (!response.ok) throw new Error("ChatGPT authorization request failed. Sign in again or retry when the service is available.");
    // Limit streamed responses, rather than trusting Content-Length.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty authorization response.");
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 262144) throw new Error("Authorization response too large."); chunks.push(value); }
    } finally { await reader.cancel(); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
    catch { throw new Error("Invalid authorization response."); }
  }

  private async metadata(): Promise<Metadata> {
    const metadata = await this.json(`${ISSUER}/.well-known/openid-configuration`) as unknown as Metadata;
    if (metadata.issuer !== ISSUER) throw new Error("Unexpected OpenID issuer.");
    for (const endpoint of [metadata.jwks_uri, metadata.revocation_endpoint]) {
      if (typeof endpoint !== "string" || new URL(endpoint).origin !== ISSUER) throw new Error("Unexpected OpenID endpoint.");
    }
    return metadata;
  }

  private async validate(token: string, clientId: string, nonce?: string): Promise<{ sub: string; email: string }> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid ID token.");
    const header = jwtPart(parts[0]!) as { alg?: string; kid?: string };
    if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported ID-token signature.");
    const metadata = await this.metadata();
    const jwks = await this.json(metadata.jwks_uri) as { keys?: import("node:crypto").JsonWebKey[] };
    const key = jwks.keys?.find((key) => (key as { kid?: string }).kid === header.kid && key.kty === "RSA" && (!key.use || key.use === "sig") && (!key.alg || key.alg === "RS256"));
    if (!key || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2]!, "base64url"))) throw new Error("Invalid ID-token signature.");
    const claims = jwtPart(parts[1]!) as { iss?: unknown; aud?: unknown; azp?: unknown; exp?: unknown; nbf?: unknown; nonce?: unknown; sub?: unknown; email?: unknown };
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER || !audiences.includes(clientId) || (audiences.length > 1 && claims.azp !== clientId) || typeof claims.exp !== "number" || claims.exp * 1000 <= this.now() || (typeof claims.nbf === "number" && claims.nbf * 1000 > this.now()) || typeof claims.sub !== "string" || !claims.sub) throw new Error("Invalid ID-token identity or expiry.");
    if (nonce !== undefined && (typeof claims.nonce !== "string" || !equal(claims.nonce, nonce))) throw new Error("Invalid ID-token nonce.");
    return { sub: claims.sub, email: typeof claims.email === "string" ? claims.email : "" };
  }

  private async token(form: Record<string, string>, signal?: AbortSignal): Promise<Tokens> {
    return await this.json(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), signal }) as Tokens;
  }
  private credentials(tokens: Tokens, previous?: Registration): Pick<Registration, "accessToken" | "refreshToken" | "idToken" | "expiresAt" | "scopes"> {
    if (tokens.token_type !== "Bearer" || typeof tokens.access_token !== "string" || !tokens.access_token || typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.expires_in > 604800) throw new Error("Invalid authorization credentials.");
    const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
    const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : previous?.refreshToken;
    if (!refreshToken) throw new Error("Renewable session was not granted.");
    return { accessToken: tokens.access_token, refreshToken, idToken: typeof tokens.id_token === "string" ? tokens.id_token : previous?.idToken ?? "", expiresAt: this.now() + tokens.expires_in * 1000, scopes };
  }

  async signIn(selectedId?: string): Promise<void> {
    if (this.attempt || this.refreshes.size || this.signingOut) throw new Error("A ChatGPT account operation is already running.");
    this.own();
    const data = this.read();
    const returning = selectedId ? data.registrations.find((r) => r.id === selectedId) : undefined;
    if (selectedId && !returning) throw new Error("Unknown ChatGPT registration.");
    this.write(data); // Persist stable host identity before opening the browser.
    const controller = new AbortController(); this.attempt = controller;
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 300000);
    let server: http.Server | undefined;
    try {
      const callback = await new Promise<{ code: string; clientId: string; redirect: string }>((resolve, reject) => {
        let consumed = false;
        server = http.createServer((request, response) => {
          const url = new URL(request.url ?? "/", "http://127.0.0.1");
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Security-Policy", "default-src 'none'");
          if (consumed || request.method !== "GET" || url.pathname !== "/auth/callback" || request.socket.remoteAddress !== "127.0.0.1") { response.writeHead(404).end("Not found"); return; }
          if (["state", "code", "client_id", "error"].some((key) => url.searchParams.getAll(key).length > 1) || !equal(url.searchParams.get("state") ?? "", state)) { response.writeHead(400).end("Invalid callback"); return; }
          consumed = true;
          const clientId = url.searchParams.get("client_id") ?? returning?.clientId;
          const code = url.searchParams.get("code");
          if (url.searchParams.has("error") || !code || !clientId || clientId === "dynamic_agent_client" || (returning && clientId !== returning.clientId)) { response.writeHead(400).end("Authorization incomplete. Return to Modex."); reject(new Error("ChatGPT authorization was denied or incomplete.")); return; }
          response.writeHead(200).end("Authorization received. Return to Modex to confirm sign-in.");
          const address = server!.address() as { port: number };
          resolve({ code, clientId, redirect: `http://127.0.0.1:${address.port}/auth/callback` });
        });
        const abort = () => reject(new Error("ChatGPT sign-in cancelled or timed out."));
        controller.signal.addEventListener("abort", abort, { once: true });
        server.on("error", () => reject(new Error("Could not start the ChatGPT callback listener.")));
        server.listen(0, "127.0.0.1", () => {
          const address = server!.address() as { port: number };
          const params = new URLSearchParams({ client_id: returning?.clientId ?? "dynamic_agent_client", ext_agent_host_id: data.hostId, response_type: "code", redirect_uri: `http://127.0.0.1:${address.port}/auth/callback`, scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
          if (!returning) params.set("agent_name_hint", "modex");
          else if (returning.idToken) params.set("id_token_hint", returning.idToken);
          if (controller.signal.aborted) { abort(); return; }
          void this.options.openBrowser(`${ISSUER}/api/accounts/authorize?${params}`).catch(() => reject(new Error("Could not open the system browser.")));
        });
      });
      server?.close();
      const tokens = await this.token({ grant_type: "authorization_code", client_id: callback.clientId, code: callback.code, code_verifier: verifier, redirect_uri: callback.redirect, resource: RESOURCE }, controller.signal);
      if (typeof tokens.id_token !== "string") throw new Error("ID token was not provided.");
      const identity = await this.validate(tokens.id_token, callback.clientId, nonce);
      if (returning && identity.sub !== returning.subject) throw new Error("Returning account identity does not match its registration.");
      const credentials = this.credentials(tokens);
      if (controller.signal.aborted) throw new Error("ChatGPT sign-in cancelled.");
      const id = createHash("sha256").update(`${identity.sub}\0${callback.clientId}`).digest("hex");
      const latest = this.read();
      latest.registrations = latest.registrations.filter((r) => r.id !== id);
      latest.registrations.push({ id, subject: identity.sub, email: identity.email, clientId: callback.clientId, ...credentials });
      latest.active = id; this.write(latest);
    } finally { clearTimeout(timeout); server?.close(); this.attempt = null; }
  }

  async grant(id: string): Promise<{ token: string; expiresAt: number }> {
    if (this.attempt || this.signingOut) throw new Error("Wait for the ChatGPT account operation to finish before starting another turn.");
    this.own();
    const record = this.read().registrations.find((r) => r.id === id);
    if (!record?.refreshToken) throw new Error("Sign in to this ChatGPT registration again.");
    if (!record.scopes.includes("chatgpt.tokens.use.direct") || !record.scopes.includes("resource.invoke")) throw new Error("ChatGPT plan usage was not authorized. Reauthorize this account.");
    let renewed = record;
    if (record.expiresAt <= this.now() + 60000) {
      let refresh = this.refreshes.get(id);
      if (!refresh) {
        refresh = this.refresh(record); this.refreshes.set(id, refresh);
        void refresh.finally(() => { if (this.refreshes.get(id) === refresh) this.refreshes.delete(id); }).catch(() => {});
      }
      renewed = await refresh;
    }
    return { token: renewed.accessToken, expiresAt: renewed.expiresAt };
  }

  private async refresh(record: Registration): Promise<Registration> {
    const tokens = await this.token({ grant_type: "refresh_token", client_id: record.clientId, refresh_token: record.refreshToken, resource: RESOURCE });
    if (typeof tokens.id_token === "string") {
      const identity = await this.validate(tokens.id_token, record.clientId);
      if (identity.sub !== record.subject) throw new Error("Refreshed account identity changed.");
    }
    const next = { ...record, ...this.credentials(tokens, record) };
    const data = this.read();
    const current = data.registrations.find((r) => r.id === record.id);
    if (!current || current.refreshToken !== record.refreshToken) throw new Error("Account changed during refresh. Retry after the current account operation finishes.");
    data.registrations = data.registrations.map((r) => r.id === record.id ? next : r);
    // A valid renewal can reduce permissions while rotating the refresh token. Persist
    // that rotation before refusing execution so reauthorization/revocation use the live token.
    this.write(data);
    if (!next.scopes.includes("chatgpt.tokens.use.direct") || !next.scopes.includes("resource.invoke")) throw new Error("ChatGPT plan usage permission is missing. Reauthorize this account.");
    return next;
  }

  async signOut(id: string): Promise<string> {
    this.own();
    if (this.attempt || this.refreshes.size || this.signingOut) throw new Error("Wait for the account operation to finish before signing out.");
    const data = this.read(); const record = data.registrations.find((r) => r.id === id);
    if (!record) throw new Error("Unknown ChatGPT registration.");
    this.signingOut = true;
    try {
      let revoked = !record.refreshToken;
      if (record.refreshToken) {
        for (let attempt = 0; attempt < 2 && !revoked; attempt++) {
          try {
            const metadata = await this.metadata();
            const response = await this.fetchImpl(metadata.revocation_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: record.refreshToken, token_type_hint: "refresh_token", client_id: record.clientId }), redirect: "error", signal: AbortSignal.timeout(10000) });
            revoked = response.status === 200; await response.body?.cancel();
          } catch { /* Local sign-out still clears credentials and reports unconfirmed revocation. */ }
          if (!revoked && attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      Object.assign(record, { accessToken: "", refreshToken: "", idToken: "", expiresAt: 0, scopes: [] });
      if (data.active === id) data.active = null;
      this.write(data);
      return revoked ? "Signed out; renewable session revoked." : "Signed out locally. Remote revocation was not confirmed; disconnect Modex in ChatGPT Settings.";
      } finally { this.signingOut = false; }
  }
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function jwtPart(part: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString());
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Error("Invalid ID token."); }
}
