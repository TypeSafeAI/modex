import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { contextRefId, type ContextCapture, type ContextSource, type ContextTarget } from "../../shared/task-context-evidence.js";

export interface CaptureClock { now(): number; setTimeout(callback: () => void, delay: number): unknown; clearTimeout(id: unknown): void }
export type CaptureReader = (cwd: string, relative: string, options: { signal: AbortSignal; charge(bytes: number): boolean; remainingBytes(): number }) => Promise<ContextCapture["revision"]>;
type Revision = ContextCapture["revision"];
export interface CapturedNoteInput { target: Exclude<ContextTarget, { kind: "file" }>; text: string; source: ContextSource; version?: NonNullable<ContextCapture["noteVersion"]> }
interface CaptureJob { target: ContextTarget; source: ContextSource; read: (options: Parameters<CaptureReader>[2]) => Promise<Revision>; version?: NonNullable<ContextCapture["noteVersion"]> }
const unavailable = (reason: Extract<Revision, { state: "unavailable" }>["reason"]): Revision => ({ state: "unavailable", reason });
const FILE_BYTES = 25 * 1024 * 1024, BATCH_BYTES = 100 * 1024 * 1024;
const clock: CaptureClock = { now: () => Date.now(), setTimeout: (callback, delay) => setTimeout(callback, delay), clearTimeout: id => clearTimeout(id as ReturnType<typeof setTimeout>) };

/** Non-atomic observations: canonical/descriptor checks reject detected replacement, not all OS races. */
const readFile: CaptureReader = async (cwd, relative, options) => {
  if (!relative || /[\u0000-\u001f\u007f\\]/.test(relative) || /^(?:\/|[A-Za-z]:)/.test(relative) || relative.split("/").some(p => !p || p === "." || p === "..")) return unavailable("outside");
  let file: import("node:fs/promises").FileHandle | undefined;
  try {
    options.signal.throwIfAborted();
    const root = await fs.realpath(cwd), abs = path.join(root, relative), real = await fs.realpath(abs);
    const inside = path.relative(root, real);
    if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside)) return unavailable("outside");
    // Retain every ancestor's identity, including root, and refuse changed/symlinked ancestry.
    const dirs = [root];
    for (const part of inside.split(path.sep).slice(0, -1)) dirs.push(path.join(dirs.at(-1)!, part));
    const ancestors = await Promise.all(dirs.map(async name => ({ name, stat: await fs.lstat(name, { bigint: true }) })));
    if (ancestors.some(a => !a.stat.isDirectory() || a.stat.isSymbolicLink())) return unavailable("outside");
    options.signal.throwIfAborted();
    file = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) return unavailable("not-regular");
    if (before.size > BigInt(FILE_BYTES)) return unavailable("too-large");
    if (!options.charge(Number(before.size))) return unavailable("budget");
    const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let bytes = 0;
    while (bytes < Number(before.size)) {
      options.signal.throwIfAborted();
      const length = Math.min(buffer.length, Number(before.size) - bytes);
      const read = await file.read(buffer, 0, length, bytes);
      if (read.bytesRead === 0) return unavailable("changed-during-read");
      bytes += read.bytesRead; hash.update(buffer.subarray(0, read.bytesRead));
    }
    options.signal.throwIfAborted();
    const after = await file.stat({ bigint: true });
    const current = await fs.lstat(real, { bigint: true });
    if (!current.isFile() || [after, current].some(s => s.dev !== before.dev || s.ino !== before.ino || s.size !== before.size || s.mtimeNs !== before.mtimeNs || s.ctimeNs !== before.ctimeNs)) return unavailable("changed-during-read");
    if (await fs.realpath(cwd) !== root || await fs.realpath(abs) !== real) return unavailable("changed-during-read");
    for (const ancestor of ancestors) {
      const current = await fs.lstat(ancestor.name, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== ancestor.stat.dev || current.ino !== ancestor.stat.ino) return unavailable("changed-during-read");
    }
    options.signal.throwIfAborted();
    return { state: "available", algorithm: "sha256", digest: hash.digest("hex"), bytes };
  } catch (error) {
    if (options.signal.aborted) return unavailable("budget");
    const code = (error as NodeJS.ErrnoException).code;
    return unavailable(code === "ENOENT" ? "missing" : code === "ELOOP" || code === "ENOTDIR" ? "outside" : "unreadable");
  } finally { await file?.close().catch(() => {}); }
};

function readHead(cwd: string, signal: AbortSignal): Promise<ContextCapture["repository"]> {
  if (signal.aborted) return Promise.resolve({ state: "unavailable", reason: "budget" });
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[name];
  return new Promise(resolve => execFile("git", ["-c", "core.fsmonitor=false", "rev-parse", "--verify", "HEAD"], { cwd, env, timeout: 1000, maxBuffer: 4096, signal }, (error, stdout) => {
    const head = String(stdout).trim();
    if (!error && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head)) resolve({ state: "available", head });
    else resolve({ state: "unavailable", reason: signal.aborted || error?.killed ? "budget" : error?.code === 128 ? "not-repository" : "unreadable" });
  }));
}

function abortable<T>(work: Promise<T>, signal: AbortSignal, fallback: T): Promise<T> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: T) => { if (settled) return; settled = true; signal.removeEventListener("abort", stop); resolve(result); };
    const stop = () => finish(fallback);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    void work.then(finish, () => finish(fallback));
  });
}
interface Job { signal: AbortSignal; run(): Promise<Revision>; finish(result: Revision): void }

/** One instance is shared by main: two live descriptor jobs and 64 queued jobs across every turn. */
export class TaskContextCapture {
  private active = 0;
  private readonly queue: Job[] = [];
  private readonly reader: CaptureReader;
  private readonly head: (cwd: string, signal: AbortSignal) => Promise<ContextCapture["repository"]>;
  private readonly clock: CaptureClock;
  constructor(options: { reader?: CaptureReader; head?: (cwd: string, signal: AbortSignal) => Promise<ContextCapture["repository"]>; clock?: CaptureClock } = {}) {
    this.reader = options.reader ?? readFile; this.head = options.head ?? readHead; this.clock = options.clock ?? clock;
  }
  private pump(): void {
    while (this.active < 2 && this.queue.length) {
      const job = this.queue.shift()!;
      if (job.signal.aborted) { job.finish(unavailable("budget")); continue; }
      this.active++;
      // A cancelled caller settles immediately; the real slot stays occupied until OS cleanup finishes.
      void Promise.resolve().then(() => job.run()).then(value => job.finish(value), () => job.finish(unavailable("unreadable"))).finally(() => { this.active--; this.pump(); });
    }
  }
  private schedule(run: () => Promise<Revision>, signal: AbortSignal): Promise<Revision> {
    if (signal.aborted || (this.active >= 2 && this.queue.length >= 64)) return Promise.resolve(unavailable("budget"));
    return new Promise(resolve => {
      let settled = false;
      const job: Job = { signal, run, finish: value => { if (settled) return; settled = true; signal.removeEventListener("abort", stop); resolve(value); } };
      const stop = () => { const index = this.queue.indexOf(job); if (index >= 0) this.queue.splice(index, 1); job.finish(unavailable("budget")); };
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) { stop(); return; }
      this.queue.push(job); this.pump();
    });
  }
  async capture(cwd: string, targets: readonly ContextTarget[], source: ContextSource, phase: ContextCapture["phase"], signal: AbortSignal): Promise<ContextCapture[]> {
    const requested = structuredClone(targets);
    return this.captureJobs(cwd, requested.map(target => ({ target, source, read: options => target.kind === "file" ? this.reader(cwd, target.path, options) : Promise.resolve(unavailable("not-captured")) })), phase, signal);
  }
  /** Hash exact bodies already returned by the scoped Notes reader; never reread a later revision. */
  async captureNotes(cwd: string, notes: readonly CapturedNoteInput[], phase: ContextCapture["phase"], signal: AbortSignal): Promise<ContextCapture[]> {
    return this.captureJobs(cwd, notes.map(note => this.noteJob(note)), phase, signal);
  }
  /** A human selection is one budget/boundary, including its mixed file and Note references. */
  async captureSelection(cwd: string, targets: readonly ContextTarget[], source: ContextSource, notes: readonly CapturedNoteInput[], phase: ContextCapture["phase"], signal: AbortSignal): Promise<ContextCapture[]> {
    const prepared = new Map(notes.map(note => [contextRefId(note.target), this.noteJob(note)]));
    const jobs = structuredClone(targets).map(target => target.kind === "file"
      ? { target, source, read: (options: Parameters<CaptureReader>[2]) => this.reader(cwd, target.path, options) }
      : prepared.get(contextRefId(target)) ?? { target, source, read: async () => unavailable("not-captured") });
    return this.captureJobs(cwd, jobs, phase, signal);
  }
  private noteJob(input: CapturedNoteInput): CaptureJob {
    const note = { ...input, target: structuredClone(input.target), source: structuredClone(input.source), ...(input.version ? { version: { ...input.version } } : {}) };
    return { target: note.target, source: note.source, version: note.version, read: async options => {
      try {
        options.signal.throwIfAborted();
        const length = Buffer.byteLength(note.text);
        if (length > FILE_BYTES) return unavailable("too-large");
        if (!options.charge(length)) return unavailable("budget");
        const body = Buffer.from(note.text), hash = createHash("sha256");
        for (let offset = 0; offset < body.length; offset += 64 * 1024) {
          options.signal.throwIfAborted();
          const chunk = body.subarray(offset, offset + 64 * 1024);
          hash.update(chunk);
          await new Promise<void>(resolve => setImmediate(resolve));
        }
        options.signal.throwIfAborted();
        return { state: "available", algorithm: "sha256", digest: hash.digest("hex"), bytes: body.length, ...(note.version ? { noteRevision: note.version.revision } : {}) };
      } catch { return unavailable(options.signal.aborted ? "budget" : "unreadable"); }
    } };
  }
  private async captureJobs(cwd: string, requested: readonly CaptureJob[], phase: ContextCapture["phase"], signal: AbortSignal): Promise<ContextCapture[]> {
    if (!requested.length) return [];
    const sources = requested.map(job => structuredClone(job.source)), startedAt = new Date(this.clock.now()).toISOString();
    const controller = new AbortController(), stop = () => controller.abort();
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    const timer = this.clock.setTimeout(stop, 2000), repositoryFallback = { state: "unavailable", reason: "budget" } as const;
    const repository = controller.signal.aborted ? Promise.resolve(repositoryFallback) : abortable(Promise.resolve().then(() => this.head(cwd, controller.signal)), controller.signal, repositoryFallback);
    const rows: ContextCapture[] = new Array(requested.length); let cursor = 0, reserved = 0;
    const options = { signal: controller.signal, remainingBytes: () => BATCH_BYTES - reserved, charge: (bytes: number) => {
      if (!Number.isSafeInteger(bytes) || reserved + bytes < 0 || reserved + bytes > BATCH_BYTES) return false;
      reserved += bytes; return true;
    } };
    const worker = async () => {
      while (cursor < requested.length) {
        const index = cursor++, job = requested[index]!;
        const revision = controller.signal.aborted ? unavailable("budget") : await this.schedule(() => job.read(options), controller.signal);
        rows[index] = { id: randomUUID(), target: structuredClone(job.target), source: sources[index]!, phase, startedAt, finishedAt: new Date(this.clock.now()).toISOString(), repository: repositoryFallback, revision, ...(job.version ? { noteVersion: { ...job.version } } : {}) };
      }
    };
    try {
      await Promise.all([worker(), worker()]); const head = await repository;
      return rows.map(row => ({ ...row, source: structuredClone(row.source), repository: { ...head } }));
    } finally { this.clock.clearTimeout(timer); signal.removeEventListener("abort", stop); }
  }
}
