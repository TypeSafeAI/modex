import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import type { Cipher } from "./secrets.js";
import type { ModexAccountStatus } from "../../shared/types.js";

const API = "https://api.workos.com";
const CALLBACK = "/auth/workos/callback";
export interface WorkOSConfig { environment: "production" | "staging"; clientId: string }
/** Public client IDs, never WorkOS API keys or GitHub OAuth client secrets. */
export function workosConfig(environment?: string): WorkOSConfig {
  if (environment !== undefined && environment !== "production" && environment !== "staging") throw new Error("Invalid Modex account environment.");
  return environment === "staging"
    ? { environment, clientId: "client_01M4B32N0CQBCPPMZ5WA4NM5P4" }
    : { environment: "production", clientId: "client_01M4DWGC09T282ZJHMZCX395ZP" };
}
interface Session { user: { id: string; email: string }; refreshToken: string; expiresAt: number; sessionId: string }
interface Stored { version: 1; clientId: string; session: Session | null }
interface Options { home: string; cipher: Cipher; config: WorkOSConfig; openBrowser: (url: string) => Promise<unknown>; fetch?: typeof fetch; now?: () => number; timeoutMs?: number }

/** Identity-only public client. CLI credentials and GitHub repository access are independent. */
export class WorkOSAuth {
  private readonly file: string;
  private readonly lock: string;
  private readonly now: () => number;
  private readonly lifetime = new AbortController();
  private attempt: AbortController | null = null;
  private renewal: Promise<ModexAccountStatus> | null = null;
  private claim: string | null = null;
  private signingOut = false;
  constructor(private readonly options: Options) {
    this.file = path.join(options.home, "app", `workos-${options.config.environment}.enc`);
    this.lock = `${this.file}.lock`;
    this.now = options.now ?? Date.now;
  }
  private read(): Stored {
    if (!this.options.cipher.available()) throw new Error("Protected OS credential storage is unavailable.");
    if (!fs.existsSync(this.file)) return { version: 1, clientId: this.options.config.clientId, session: null };
    try {
      const value = JSON.parse(this.options.cipher.decrypt(fs.readFileSync(this.file))) as Stored;
      if (value.version !== 1 || value.clientId !== this.options.config.clientId || (value.session !== null && !validSession(value.session))) throw new Error();
      return value;
    } catch { throw new Error("Modex account storage could not be opened. Restore the OS keychain; credentials were preserved."); }
  }
  private own(): void {
    if (this.lifetime.signal.aborted) throw new Error("Modex is shutting down.");
    if (!this.options.cipher.available()) throw new Error("Protected OS credential storage is unavailable.");
    if (this.claim) return;
    let claim: string | undefined;
    try {
      fs.mkdirSync(this.lock, { recursive: true, mode: 0o700 });
      claim = path.join(this.lock, `${process.pid}-${randomUUID()}.owner`);
      const fd = fs.openSync(claim, "wx", 0o600);
      try { fs.writeFileSync(fd, "Modex account credential owner\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      // Publish our unique claim before inspecting peers. A later contender sees us;
      // simultaneous contenders may both refuse, but cannot both obtain ownership.
      // Never unlink a reusable lock path: dead claims have unique names, so stale
      // recovery cannot accidentally delete a replacement owner's claim.
      for (const name of fs.readdirSync(this.lock)) {
        const peer = path.join(this.lock, name);
        if (peer === claim) continue;
        const match = /^(\d+)-[0-9a-f-]{36}\.owner$/.exec(name);
        if (!match) throw new Error();
        const pid = Number(match[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error();
        let dead = false;
        try { process.kill(pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
        if (!dead) {
          if (!fs.existsSync(peer)) continue; // A failed contender or graceful owner left.
          throw new Error();
        }
        try { fs.unlinkSync(peer); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      this.claim = claim;
    } catch {
      if (claim) { try { fs.unlinkSync(claim); } catch { /* Only our unique claim. */ } }
      throw new Error("Another Modex instance may own this account. Close it before retrying; preserve uncertain credential owners until they are verified stopped.");
    }
  }

  private write(session: Session | null): void {
    this.own();
    const data: Stored = { version: 1, clientId: this.options.config.clientId, session };
    const encrypted = this.options.cipher.encrypt(JSON.stringify(data));
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, encrypted); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      if (process.platform !== "win32") {
        const directory = fs.openSync(path.dirname(this.file), "r");
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  status(): ModexAccountStatus {
    const base = { environment: this.options.config.environment, signingIn: this.attempt !== null };
    try {
      const session = this.read().session;
      return { ...base, available: true, user: session ? { id: session.user.id, email: session.user.email } : null, expiresAt: session?.expiresAt ?? null,
        detail: session ? (session.expiresAt <= this.now() ? "Session expired. Refresh your session or sign in again." : "Signed in to Modex. Coding tools use their own accounts.") : "Sign in to Modex with your GitHub identity." };
    } catch { return { ...base, available: false, user: null, expiresAt: null, detail: "Protected account storage is unavailable. Existing credentials were preserved." }; }
  }
  cancel(): void { this.attempt?.abort(); }
  dispose(): void {
    this.lifetime.abort(); this.cancel();
    if (this.claim) {
      try { fs.unlinkSync(this.claim); } catch { /* Only our unique claim; never a peer's. */ }
      this.claim = null;
    }
  }

  private async authenticate(body: Record<string, string>, signal?: AbortSignal): Promise<Session> {
    try {
      const response = await (this.options.fetch ?? fetch)(`${API}/user_management/authenticate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: this.options.config.clientId, ...body }), redirect: "error",
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(); }
      const reader = response.body?.getReader(); if (!reader) throw new Error();
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 262144) throw new Error(); chunks.push(value); }
      } finally { await reader.cancel(); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      // Identity comes exclusively from this fixed HTTPS token endpoint, not a callback
      // JWT or renderer input. Decode the freshly received access token only for session
      // metadata; it is never used as independent identity proof or persisted.
      if (typeof data.access_token !== "string" || data.access_token.split(".").length !== 3) throw new Error();
      const claims = JSON.parse(Buffer.from(data.access_token.split(".")[1], "base64url").toString("utf8"));
      if (claims.sub !== data.user?.id || typeof claims.exp !== "number" || claims.exp * 1000 <= this.now()) throw new Error();
      const session: Session = { user: { id: data.user.id, email: data.user.email }, refreshToken: data.refresh_token, expiresAt: claims.exp * 1000, sessionId: claims.sid };
      if (!validSession(session)) throw new Error();
      return session; // Drop all provider OAuth tokens, profile metadata and access tokens.
    } catch { throw new Error("Modex authorization could not be completed. Retry sign-in or check the service connection."); }
  }
  async signIn(): Promise<ModexAccountStatus> {
    if (this.attempt || this.renewal || this.signingOut) throw new Error("A Modex account operation is already running.");
    this.own(); this.read();
    const controller = new AbortController(); this.attempt = controller;
    const verifier = randomBytes(32).toString("base64url"); const state = randomBytes(32).toString("base64url");
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 300000);
    let server: http.Server | undefined;
    try {
      const code = await new Promise<string>((resolve, reject) => {
        let consumed = false;
        server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
          response.setHeader("Cache-Control", "no-store"); response.setHeader("Content-Security-Policy", "default-src 'none'");
          const address = server!.address() as { port: number };
          const host = `127.0.0.1:${address.port}`;
          let url: URL;
          try { url = new URL(request.url ?? "/", `http://${host}`); } catch { response.writeHead(400).end("Invalid callback"); return; }
          if (consumed || request.method !== "GET" || url.origin !== `http://${host}` || request.headers.host !== host || url.pathname !== CALLBACK || request.socket.remoteAddress !== "127.0.0.1") { response.writeHead(404).end("Not found"); return; }
          if (["state", "code", "error"].some((key) => url.searchParams.getAll(key).length > 1) || !equal(url.searchParams.get("state") ?? "", state)) { response.writeHead(400).end("Invalid callback"); return; }
          consumed = true;
          const code = url.searchParams.get("code");
          if (url.searchParams.has("error") || !code || code.length > 4096) { response.writeHead(400).end("Sign-in incomplete. Return to Modex."); reject(new Error("Modex sign-in was denied or incomplete.")); return; }
          response.writeHead(200).end("Authorization received. Return to Modex to confirm sign-in."); resolve(code);
        });
        const aborted = () => reject(new Error("Modex sign-in cancelled or timed out."));
        controller.signal.addEventListener("abort", aborted, { once: true });
        server.on("error", () => reject(new Error("Could not start the Modex callback listener.")));
        server.listen(0, "127.0.0.1", () => {
          if (controller.signal.aborted) { aborted(); return; }
          const port = (server!.address() as { port: number }).port;
          const query = new URLSearchParams({ client_id: this.options.config.clientId, provider: "GitHubOAuth", response_type: "code", redirect_uri: `http://127.0.0.1:${port}${CALLBACK}`, state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
          void this.options.openBrowser(`${API}/user_management/authorize?${query}`).catch(() => reject(new Error("Could not open the system browser.")));
        });
      });
      server?.close();
      const session = await this.authenticate({ grant_type: "authorization_code", code, code_verifier: verifier }, controller.signal);
      if (controller.signal.aborted || this.lifetime.signal.aborted) throw new Error("Modex sign-in cancelled.");
      this.write(session);
      return { ...this.status(), signingIn: false };
    } finally { clearTimeout(timeout); server?.close(); server?.closeAllConnections(); this.attempt = null; }
  }
  async refresh(): Promise<ModexAccountStatus> {
    if (this.renewal) return this.renewal;
    if (this.attempt || this.signingOut) throw new Error("Wait for the Modex account operation to finish.");
    this.own(); const previous = this.read().session;
    if (!previous || previous.expiresAt > this.now() + 60000) return this.status();
    const operation = (async () => {
      const next = await this.authenticate({ grant_type: "refresh_token", refresh_token: previous.refreshToken });
      if (next.user.id !== previous.user.id || next.sessionId !== previous.sessionId) throw new Error("Refreshed Modex account identity changed. Sign in again.");
      if (this.read().session?.refreshToken !== previous.refreshToken) throw new Error("Modex account changed during refresh.");
      this.write(next); return this.status();
    })();
    this.renewal = operation;
    try { return await operation; } finally { if (this.renewal === operation) this.renewal = null; }
  }
  async signOut(): Promise<string> {
    if (this.attempt || this.renewal || this.signingOut) throw new Error("Wait for the Modex account operation to finish.");
    this.own(); const previous = this.read().session; this.signingOut = true;
    try {
      this.write(null); // Local sign-out must succeed independently of browser/network health.
      if (!previous) return "Signed out locally.";
      try {
        await this.options.openBrowser(`${API}/user_management/sessions/logout?${new URLSearchParams({ session_id: previous.sessionId })}`);
        return "Signed out locally. Complete sign-out in your browser to end the remote session.";
      } catch { return "Signed out locally. Remote sign-out could not be opened; the remote session may remain active."; }
    } finally { this.signingOut = false; }
  }
}
function equal(a: string, b: string): boolean { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
function validSession(session: Session): boolean {
  return !!session && typeof session.user?.id === "string" && /^user_[A-Za-z0-9]+$/.test(session.user.id) && typeof session.user.email === "string" && session.user.email.length <= 320 && typeof session.refreshToken === "string" && session.refreshToken.length > 0 && typeof session.sessionId === "string" && /^session_[A-Za-z0-9]+$/.test(session.sessionId) && typeof session.expiresAt === "number" && Number.isFinite(session.expiresAt) && session.expiresAt > 0;
}
