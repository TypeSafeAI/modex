import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Flushes a directory's entries (a rename or a new file) to disk. A no-op on Windows, which cannot open directories. */
export function fsyncDir(dir: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Replaces `file` with `data` atomically: a hidden temporary file beside it (exclusive, never through
 * a link, mode 0600) is flushed, renamed over the target, and the directory is flushed. A crash leaves
 * either the old file or the new one, never a mix.
 */
export function writeFileDurably(file: string, data: string | Uint8Array): void {
  const dir = path.dirname(file);
  const temporary = path.join(dir, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    fsyncDir(dir);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

/** Moves a file or folder to `target`, failing with EEXIST rather than replacing anything already there. */
export function moveNoClobber(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stat = fs.lstatSync(source);
  if (stat.isDirectory()) {
    if (fs.existsSync(target)) throw Object.assign(new Error(`${target} already exists`), { code: "EEXIST" });
    fs.renameSync(source, target);
  } else {
    // A hard link refuses an existing target atomically; the source then goes.
    fs.linkSync(source, target);
    fs.unlinkSync(source);
  }
  fsyncDir(path.dirname(target));
  if (path.dirname(source) !== path.dirname(target)) fsyncDir(path.dirname(source));
}
