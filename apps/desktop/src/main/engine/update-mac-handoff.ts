import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AutoUpdater } from "electron";

type NativeUpdater = Pick<AutoUpdater, "setFeedURL" | "checkForUpdates"> & {
  on(event: "error", listener: () => void): unknown;
  on(event: "update-not-available", listener: () => void): unknown;
  on(event: "update-downloaded", listener: (event: unknown, notes: string, name: string, date: Date, url: string) => void): unknown;
};
export type MacHandoffState = "idle" | "preparing" | "staging" | "staged" | "uncertain";
type Outcome = "staged" | "uncertain";
interface Snapshot { archive: string; version: string; size: number; sha512: string }
export interface HandoffReceipt { version: string; sha512: string; startedAt: string }

/** Last, irreversible boundary after publisher verification and restart preflight.
 * Squirrel can arm next-quit installation before emitting success or error. This adapter
 * never quits, never claims post-handoff cancellation, and permits only one native attempt.
 * Main must own one instance; its observers live as long as Electron's native updater.
 */
export class MacUpdateHandoff {
  private currentState: MacHandoffState = "idle";
  get state(): MacHandoffState { return this.currentState; }
  private pending?: Promise<Outcome>;
  private committed = false;
  private settingFeed = false;
  private feedRejected = false;
  private descriptor?: FileHandle;
  private server?: Server;
  private artifactURL?: string;
  private version?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private finish?: (outcome: Outcome) => void;

  constructor(private readonly native: NativeUpdater, private readonly changed: (state: MacHandoffState) => void, private readonly timeoutMs = 120_000) {
    native.on("error", () => {
      if (this.settingFeed) this.feedRejected = true;
      if (this.committed) this.settle("uncertain");
    });
    native.on("update-not-available", () => { if (this.committed) this.settle("uncertain"); });
    native.on("update-downloaded", (_event, _notes, name, _date, url) => {
      if (this.committed && url === this.artifactURL && name === this.version) this.settle("staged");
    });
  }

  stage(snapshot: Snapshot, recordAttempt: (receipt: HandoffReceipt) => Promise<void>): Promise<Outcome> {
    if (this.committed) return Promise.reject(new Error("A native update handoff has already started. Restart recovery is required."));
    if (this.pending) return this.pending;
    this.pending = Promise.resolve().then(() => this.prepare(snapshot, recordAttempt)).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private setState(state: MacHandoffState): void {
    if (this.state === state) return;
    this.currentState = state;
    // A renderer notification failure must not interrupt native-state tracking or cleanup.
    try { this.changed(state); } catch { console.error("[modex] update state observer failed"); }
  }

  private async prepare(snapshot: Snapshot, recordAttempt: (receipt: HandoffReceipt) => Promise<void>): Promise<Outcome> {
    this.setState("preparing");
    try {
      if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 1 || snapshot.size > 512 * 1024 * 1024
        || !/^[A-Za-z0-9+/]{86}==$/.test(snapshot.sha512)
        || snapshot.version.length > 50 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(snapshot.version)) {
        throw new Error("Invalid verified update snapshot.");
      }
      const descriptor = this.descriptor = await open(snapshot.archive, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await descriptor.stat();
      if (!stat.isFile() || stat.size !== snapshot.size) throw new Error("Update snapshot integrity check failed.");
      const hash = createHash("sha512");
      for await (const chunk of descriptor.createReadStream({ start: 0, end: snapshot.size - 1, autoClose: false })) hash.update(chunk);
      if (hash.digest("base64") !== snapshot.sha512 || (await descriptor.stat()).size !== snapshot.size) throw new Error("Update snapshot integrity check failed.");

      const feedPath = `/${randomBytes(32).toString("hex")}/feed`;
      const artifactPath = `/${randomBytes(32).toString("hex")}/update.zip`;
      const server = this.server = createServer((request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Content-Type-Options", "nosniff");
        if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405); response.end(); return; }
        if (request.url === feedPath) {
          const body = JSON.stringify({ url: this.artifactURL, name: snapshot.version, notes: "", pub_date: new Date().toISOString() });
          response.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
          response.end(request.method === "HEAD" ? undefined : body);
        } else if (request.url === artifactPath) {
          response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": snapshot.size });
          if (request.method === "HEAD") { response.end(); return; }
          const stream = descriptor.createReadStream({ start: 0, end: snapshot.size - 1, autoClose: false });
          stream.on("error", () => response.destroy());
          response.on("close", () => stream.destroy());
          stream.pipe(response);
        } else { response.writeHead(404); response.end(); }
      });
      server.maxConnections = 4;
      server.requestTimeout = 30_000;
      server.headersTimeout = 10_000;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
      });
      server.on("error", () => { if (this.committed) this.settle("uncertain"); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Could not open the private update feed.");
      const origin = `http://127.0.0.1:${address.port}`;
      this.artifactURL = origin + artifactPath;
      this.version = snapshot.version;
      // Failure here is still reversible. Once checkForUpdates is invoked, only native
      // success can resolve uncertainty; closing this server cannot unstage Squirrel.
      await recordAttempt({ version: snapshot.version, sha512: snapshot.sha512, startedAt: new Date().toISOString() });
      this.feedRejected = false;
      this.settingFeed = true;
      try { this.native.setFeedURL({ url: origin + feedPath }); }
      finally { this.settingFeed = false; }
      if (this.feedRejected) throw new Error("The native update feed could not be initialized.");
      const completed = new Promise<Outcome>(resolve => { this.finish = resolve; });
      this.committed = true;
      this.setState("staging");
      this.timer = setTimeout(() => this.settle("uncertain"), this.timeoutMs);
      try { this.native.checkForUpdates(); } catch { this.settle("uncertain"); }
      return await completed;
    } catch (error) {
      await this.closeFeed();
      this.setState("idle");
      throw error;
    }
  }

  private settle(outcome: Outcome): void {
    if (this.state === "staged") return;
    this.setState(outcome);
    clearTimeout(this.timer);
    const finish = this.finish;
    this.finish = undefined;
    void this.closeFeed().then(() => finish?.(outcome), () => {
      console.error("[modex] private update feed cleanup failed");
      finish?.(outcome);
    });
  }

  private async closeFeed(): Promise<void> {
    const server = this.server;
    const descriptor = this.descriptor;
    this.server = undefined;
    this.descriptor = undefined;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    await descriptor?.close();
  }
}
