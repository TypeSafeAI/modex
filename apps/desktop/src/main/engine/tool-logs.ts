import fs from "node:fs";
import path from "node:path";
import { OUTPUT_PREVIEW_BYTES, TOOL_LOG_MAX_BYTES, TOOL_LOG_PAGE_BYTES, type ToolLogPage } from "../../shared/evidence.js";

export { TOOL_LOG_MAX_BYTES, TOOL_LOG_PAGE_BYTES, type ToolLogPage };

/**
 * A tool's raw output, kept in main (docs/conversation-evidence.md). The transcript keeps a tool's last
 * 256 KiB. When the output grows past that, this keeps it from its first byte, up to 10 MiB, in one
 * file per item under the app folder, and reads it back a page at a time. Output that fits in the
 * preview is never written. Nothing here runs, opens or sends anything; ids never become paths.
 */

interface Writing { pending: Buffer[]; bytes: number; kept: number; full: boolean; fd: number | null }

export class ToolLogStore {
  private writing = new Map<string, Writing>();

  constructor(readonly root: string, private readonly limits = { keepAfter: OUTPUT_PREVIEW_BYTES, max: TOOL_LOG_MAX_BYTES }) {}

  /** Adds raw output for an item. Held in memory until it passes the preview, then written as it comes. */
  append(threadId: string, itemId: string, chunk: string): void {
    const file = this.file(threadId, itemId);
    let w = this.writing.get(file);
    if (!w) this.writing.set(file, (w = { pending: [], bytes: 0, kept: 0, full: false, fd: null }));
    const data = Buffer.from(chunk, "utf8");
    w.bytes += data.length;
    if (w.fd !== null) return this.write(w, data);
    w.pending.push(data);
    if (w.bytes <= this.limits.keepAfter) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    w.fd = fs.openSync(file, "w");
    const held = Buffer.concat(w.pending);
    w.pending = [];
    this.write(w, held);
  }

  /** The tool finished: close its log and record how much output there was. */
  end(threadId: string, itemId: string): void {
    const file = this.file(threadId, itemId);
    const w = this.writing.get(file);
    if (!w) return;
    this.writing.delete(file);
    if (w.fd === null) return;
    fs.closeSync(w.fd);
    fs.writeFileSync(meta(file), JSON.stringify({ total: w.bytes, kept: w.kept }));
  }

  /** The turn ended: close what is still open, without claiming a total for tools that never finished. */
  endThread(threadId: string): void {
    const dir = this.dir(threadId);
    for (const [file, w] of this.writing) {
      if (path.dirname(file) !== dir) continue;
      if (w.fd !== null) fs.closeSync(w.fd);
      this.writing.delete(file);
    }
  }

  /** A page of an item's kept log from `offset` (a byte position a previous page returned), or null when none was kept. */
  read(threadId: string, itemId: string, offset: number): ToolLogPage | null {
    const file = this.file(threadId, itemId);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("A log offset is a whole, non-negative number.");
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.min(offset, size);
      // One byte more than a page, to see whether the page would end inside a character.
      const buf = Buffer.alloc(Math.min(TOOL_LOG_PAGE_BYTES + 1, size - start));
      const read = buf.length ? fs.readSync(fd, buf, 0, buf.length, start) : 0;
      let end = Math.min(read, TOOL_LOG_PAGE_BYTES);
      if (start + end < size) while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
      const recorded = readMeta(file);
      return {
        text: buf.subarray(0, end).toString("utf8"),
        offset: start,
        next: start + end < size ? start + end : null,
        kept: size,
        ...(recorded ? { total: recorded.total, cut: recorded.total > size } : {}),
      };
    } finally { fs.closeSync(fd); }
  }

  /** Deletes a thread's logs, closing any still being written. */
  removeThread(threadId: string): void {
    this.endThread(threadId);
    fs.rmSync(this.dir(threadId), { recursive: true, force: true });
  }

  private write(w: Writing, data: Buffer): void {
    if (w.full) return;
    const room = this.limits.max - w.kept;
    let part = data;
    if (data.length >= room) {
      // The cap: stop before a character it would split, and write nothing after it.
      let cut = room;
      while (cut > 0 && cut < data.length && (data[cut]! & 0xc0) === 0x80) cut--;
      part = data.subarray(0, cut);
      w.full = true;
    }
    if (part.length) fs.writeSync(w.fd!, part);
    w.kept += part.length;
  }

  private dir(threadId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(threadId)) throw new Error("Not a thread id.");
    return path.join(this.root, threadId);
  }

  private file(threadId: string, itemId: string): string {
    if (typeof itemId !== "string" || !itemId) throw new Error("Not an item id.");
    return path.join(this.dir(threadId), `${Buffer.from(itemId, "utf8").toString("hex")}.log`);
  }
}

function meta(file: string): string {
  return file.replace(/\.log$/, ".json");
}

function readMeta(file: string): { total: number; kept: number } | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(meta(file), "utf8")) as { total?: unknown; kept?: unknown };
    return Number.isSafeInteger(value.total) && Number.isSafeInteger(value.kept) ? { total: value.total as number, kept: value.kept as number } : undefined;
  } catch { return undefined; }
}
