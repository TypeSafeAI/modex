import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

type Identity = Pick<fs.Stats, "dev" | "ino">;
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
declare const snapshotBrand: unique symbol;
export type RecoveryFileSnapshot<T> = Readonly<{ value: Immutable<T> | null; sha256: string | null; [snapshotBrand]: true }>;
interface Observed { body: string; identity: Identity }
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const invalid = () => new Error("Attachment recovery data is invalid or changed; existing evidence was preserved.");
const freeze = <T>(value: T): Immutable<T> => {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value as Immutable<T>;
};

/** Same data-only and duplicate-member boundaries as UpdateRecovery, with an
 * explicit per-record bound for the separately stored pending intent/journal. */
export function recoveryJSON(value: unknown, limit: number): string {
  let bytes = 0, nodes = 0;
  const ancestors = new Set<object>();
  const add = (n: number) => { bytes += n; if (bytes > limit) throw invalid(); };
  const text = (s: string) => {
    if (s.length > limit) throw invalid();
    add(2);
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const low = s.charCodeAt(++i); if (!(low >= 0xdc00 && low <= 0xdfff)) throw invalid(); add(4);
      } else if (c >= 0xdc00 && c <= 0xdfff) throw invalid();
      else if (c === 34 || c === 92 || [8, 9, 10, 12, 13].includes(c)) add(2);
      else add(c < 32 ? 6 : c < 128 ? 1 : c < 2048 ? 2 : 3);
    }
  };
  const visit = (v: unknown, depth: number): unknown => {
    if (++nodes > 20000 || depth > 12) throw invalid();
    if (v === null) { add(4); return null; }
    if (typeof v === "string") { text(v); return v; }
    if (typeof v === "boolean") { add(v ? 4 : 5); return v; }
    if (typeof v === "number" && Number.isFinite(v)) { add(String(v).length); return v; }
    if (!v || typeof v !== "object" || ancestors.has(v)) throw invalid();
    const array = Array.isArray(v), keys = Object.keys(v);
    if (array ? keys.length !== v.length || Reflect.ownKeys(v).length !== keys.length + 1
      : ![Object.prototype, null].includes(Object.getPrototypeOf(v)) || keys.length > 16 || Reflect.ownKeys(v).length !== keys.length) throw invalid();
    ancestors.add(v); add(2);
    const output: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    for (const [i, key] of keys.entries()) {
      if (array && key !== String(i)) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw invalid();
      if (i) add(1);
      if (!array) { text(key); add(1); }
      const copied = visit(descriptor.value, depth + 1);
      if (Array.isArray(output)) output.push(copied); else output[key] = copied;
    }
    ancestors.delete(v);
    return output;
  };
  const body = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(body) > limit) throw invalid();
  return body;
}

export function parseRecoveryJSON(body: string, limit: number): unknown {
  if (Buffer.byteLength(body) > limit) throw invalid();
  const stack: ({ keys: Set<string>; expectingKey: boolean } | null)[] = [];
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (char === '"') {
      const start = i;
      for (i++; i < body.length; i++) { if (body[i] === "\\") i++; else if (body[i] === '"') break; }
      if (i >= body.length) throw invalid();
      const object = stack.at(-1);
      if (object?.expectingKey) {
        const key: string = JSON.parse(body.slice(start, i + 1));
        if (object.keys.has(key) || object.keys.size >= 16) throw invalid();
        object.keys.add(key); object.expectingKey = false;
      }
    } else if (char === "{" || char === "[") {
      if (stack.length >= 12) throw invalid();
      stack.push(char === "{" ? { keys: new Set(), expectingKey: true } : null);
    } else if (char === "}" || char === "]") stack.pop();
    else if (char === ",") { const object = stack.at(-1); if (object) object.expectingKey = true; }
  }
  const value: unknown = JSON.parse(body);
  recoveryJSON(value, limit);
  return value;
}

export class RecoveryFileWriteError extends Error {
  constructor(readonly unchanged: boolean, cause: unknown) {
    super(unchanged ? "Attachment recovery write was refused before changing any file."
      : "Attachment recovery storage is uncertain; existing evidence was preserved.", { cause });
  }
}

/** A fixed main-owned file with instance-local compare-and-replace proofs. No
 * filenames, handles, codecs or durability receipts are supplied through IPC. */
export class AttachmentRecoveryFile<T> {
  readonly file: string;
  private readonly directory: string;
  private readonly owner: Identity;
  private readonly proofs = new WeakMap<RecoveryFileSnapshot<T>, Observed | null>();
  private busy = false;
  private reentered = false;
  private uncertain = false;
  constructor(directory: string, filename: string, private readonly limit: number, private readonly validate: (value: unknown) => void) {
    if (!/^[A-Za-z0-9_-]{1,128}\.json$/.test(filename) || !Number.isSafeInteger(limit) || limit < 1 || limit > 4 * 1024 * 1024) throw invalid();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    this.directory = fs.realpathSync(directory); this.owner = { dev: stat.dev, ino: stat.ino };
    this.file = path.join(this.directory, filename);
  }
  private assertDirectory(): void {
    const stat = fs.lstatSync(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, this.owner)) throw invalid();
  }
  private operation<R>(run: () => R): R {
    if (this.busy) { this.reentered = true; throw invalid(); }
    this.busy = true; this.reentered = false;
    try { const result = run(); if (this.reentered) throw invalid(); return result; }
    finally { this.busy = false; }
  }
  private observed(): Observed | null {
    this.assertDirectory();
    let fd: number;
    try { fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.assertDirectory(); return null; } throw error; }
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.size > this.limit) throw invalid();
      const buffer = Buffer.alloc(this.limit + 1); let length = 0;
      while (length < buffer.length) {
        const count = fs.readSync(fd, buffer, length, buffer.length - length, null); if (!count) break; length += count;
      }
      const after = fs.fstatSync(fd), named = fs.lstatSync(this.file);
      this.assertDirectory();
      if (length !== before.size || length > this.limit || !same(before, after) || !named.isFile() || named.isSymbolicLink()
        || !same(after, named) || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || named.size !== after.size || named.mtimeMs !== after.mtimeMs || named.ctimeMs !== after.ctimeMs) throw invalid();
      // Preserve a leading BOM as a character so strict JSON parsing refuses it.
      // Decoder normalization would otherwise make distinct bytes share a CAS proof.
      return { body: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length)), identity: { dev: after.dev, ino: after.ino } };
    } finally { fs.closeSync(fd); }
  }
  private snapshot(observed: Observed | null): RecoveryFileSnapshot<T> {
    let value: unknown = null;
    if (observed) { value = parseRecoveryJSON(observed.body, this.limit); this.validate(value); if (this.reentered) throw invalid(); }
    const snapshot = Object.freeze({ value: freeze(value as T | null), sha256: observed ? digest(observed.body) : null }) as RecoveryFileSnapshot<T>;
    this.proofs.set(snapshot, observed); return snapshot;
  }
  read(): RecoveryFileSnapshot<T> { return this.operation(() => this.snapshot(this.observed())); }
  private matches(left: Observed | null, right: Observed | null): boolean {
    return left === null ? right === null : right !== null && left.body === right.body && same(left.identity, right.identity);
  }
  private expected(snapshot: RecoveryFileSnapshot<T>): Observed | null {
    if (!this.proofs.has(snapshot)) throw invalid();
    const observed = this.proofs.get(snapshot)!;
    if (!this.matches(observed, this.observed())) throw invalid();
    return observed;
  }
  private syncAncestors(): void {
    if (process.platform === "win32") throw new Error("Strong attachment recovery durability is unavailable on Windows.");
    let directory = this.directory;
    while (true) {
      const before = fs.lstatSync(directory);
      if (!before.isDirectory() || before.isSymbolicLink()) throw invalid();
      const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try { if (!same(before, fs.fstatSync(fd))) throw invalid(); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      const parent = path.dirname(directory); if (parent === directory) break; directory = parent;
    }
    this.assertDirectory();
  }
  /** Re-establish durability after restart without replacing bytes or inode. */
  checkpoint(expected: RecoveryFileSnapshot<T>): void {
    this.operation(() => {
      if (this.uncertain) throw new RecoveryFileWriteError(false, invalid());
      if (process.platform === "win32") throw new RecoveryFileWriteError(true, invalid());
      const before = this.expected(expected); if (!before) throw invalid();
      let fd: number | undefined;
      try {
        fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || !same(stat, before.identity) || !this.matches(before, this.observed())) throw invalid();
        fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        this.syncAncestors();
        if (!this.matches(before, this.observed())) throw invalid();
      } catch (cause) { this.uncertain = true; throw new RecoveryFileWriteError(false, cause); }
      finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch (cause) { this.uncertain = true; throw new RecoveryFileWriteError(false, cause); }
        }
      }
    });
  }
  write(expected: RecoveryFileSnapshot<T>, input: unknown): RecoveryFileSnapshot<T> {
    return this.operation(() => {
      if (this.uncertain) throw new RecoveryFileWriteError(false, invalid());
      if (process.platform === "win32") throw new RecoveryFileWriteError(true, invalid());
      const before = this.expected(expected);
      const body = recoveryJSON(input, this.limit), checked = parseRecoveryJSON(body, this.limit);
      this.validate(checked); if (this.reentered) throw invalid();
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      let fd: number | undefined, created = false;
      try {
        fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600); created = true;
        const identity = fs.fstatSync(fd);
        fs.writeFileSync(fd, body); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
        this.assertDirectory();
        const staged = fs.lstatSync(temporary);
        if (!staged.isFile() || staged.isSymbolicLink() || !same(identity, staged) || !this.matches(before, this.observed())) throw invalid();
        fs.renameSync(temporary, this.file);
        this.syncAncestors();
        const after = this.observed();
        if (!after || after.body !== body || !same(identity, after.identity)) throw invalid();
        return this.snapshot(after);
      } catch (cause) {
        let unchanged = !created;
        try {
          unchanged = unchanged && this.matches(before, this.observed());
          try { fs.lstatSync(temporary); unchanged = false; } catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ENOENT") unchanged = false; }
        } catch { unchanged = false; }
        if (!unchanged) this.uncertain = true;
        throw new RecoveryFileWriteError(unchanged, cause);
      } finally {
        if (fd !== undefined) {
          try { fs.closeSync(fd); } catch (cause) { this.uncertain = true; throw new RecoveryFileWriteError(false, cause); }
        }
      }
    });
  }
  remove(expected: RecoveryFileSnapshot<T>): void {
    this.operation(() => {
      if (this.uncertain) throw new RecoveryFileWriteError(false, invalid());
      if (process.platform === "win32") throw new RecoveryFileWriteError(true, invalid());
      const before = this.expected(expected); if (!before) return;
      try { this.assertDirectory(); fs.unlinkSync(this.file); this.syncAncestors(); }
      catch (cause) { this.uncertain = true; throw new RecoveryFileWriteError(false, cause); }
    });
  }
}
