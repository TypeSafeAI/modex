import fs from "node:fs";
import path from "node:path";
import { newId } from "./store.js";
import { kindFor, mimeFor, rejectReason, safeName, type Attachment, type StagedFile } from "../../shared/attachments.js";

/**
 * Owns `<home>/attachments`: `staging/` for files attached but not yet sent, one folder per thread
 * for the rest. Everything the renderer sees is a `rel` under this root; `resolve` is the only way
 * back to an absolute path and refuses anything that would leave the root.
 */
export class AttachmentStore {
  readonly staging: string;

  constructor(readonly root: string) {
    this.staging = path.join(root, "staging");
    fs.mkdirSync(this.staging, { recursive: true });
  }

  /** Copies (or writes) each file into staging. Files over the limit are reported and skipped; the rest attach. */
  stage(files: StagedFile[]): { staged: Attachment[]; errors: string[] } {
    const staged: Attachment[] = [];
    const errors: string[] = [];
    for (const f of files) {
      try {
        const name = safeName(f.name);
        const mime = mimeFor(name, f.mime);
        const kind = kindFor(mime);
        const bytes = f.data !== undefined ? Buffer.from(f.data, "base64") : null;
        const src = f.path ?? "";
        const stat = bytes ? null : fs.statSync(src);
        if (stat && !stat.isFile()) { errors.push(`${name} is not a file.`); continue; }
        const reason = rejectReason(name, bytes ? bytes.length : stat!.size, kind);
        if (reason) { errors.push(reason); continue; }
        const id = newId();
        const rel = `staging/${id}-${name}`;
        const dest = path.join(this.root, rel);
        if (bytes) fs.writeFileSync(dest, bytes);
        else fs.copyFileSync(src, dest);
        staged.push({ id, name, mime, size: bytes ? bytes.length : stat!.size, kind, rel });
      } catch (err) {
        errors.push(`${f.name || "file"}: ${(err as NodeJS.ErrnoException).code === "ENOENT" ? "not found" : (err as Error).message}`);
      }
    }
    return { staged, errors };
  }

  /** Drops staged files the user removed from the composer. */
  discard(ids: string[]): void {
    for (const id of ids) {
      if (!/^[\w-]+$/.test(id)) continue;
      for (const entry of this.list(this.staging)) if (entry.startsWith(`${id}-`)) fs.rmSync(path.join(this.staging, entry), { force: true });
    }
  }

  /** On send: moves staged files into the thread's folder. Already-sent ones (a Retry) pass through. */
  claim(threadId: string, attachments: Attachment[]): Attachment[] {
    if (!/^[\w-]+$/.test(threadId)) throw new Error(`bad thread id ${threadId}`);
    const dir = path.join(this.root, threadId);
    return attachments.map((a) => {
      const from = this.resolve(a.rel);
      if (!a.rel.startsWith("staging/")) {
        if (!from) throw new Error(`attachment ${a.name} is missing`);
        return a;
      }
      if (!from) throw new Error(`attachment ${a.name} is no longer staged`);
      fs.mkdirSync(dir, { recursive: true });
      const rel = `${threadId}/${path.basename(a.rel)}`;
      fs.renameSync(from, path.join(this.root, rel));
      return { ...a, rel };
    });
  }

  /** Absolute path for a `rel` inside the root, or null when it would escape the root or does not exist. */
  resolve(rel: string): string | null {
    if (!rel || rel.includes("\u0000") || path.isAbsolute(rel)) return null;
    const abs = path.resolve(this.root, rel);
    const root = path.resolve(this.root);
    if (abs !== root && !abs.startsWith(root + path.sep)) return null;
    try {
      return fs.statSync(abs).isFile() ? abs : null;
    } catch {
      return null;
    }
  }

  removeThread(threadId: string): void {
    if (!/^[\w-]+$/.test(threadId)) return;
    fs.rmSync(path.join(this.root, threadId), { recursive: true, force: true });
  }

  /** Staged files older than `maxAgeMs` belong to composers that were never sent. */
  sweepStaging(maxAgeMs = 24 * 60 * 60 * 1000, now = Date.now()): number {
    let removed = 0;
    for (const entry of this.list(this.staging)) {
      const file = path.join(this.staging, entry);
      try {
        if (now - fs.statSync(file).mtimeMs > maxAgeMs) { fs.rmSync(file, { force: true }); removed++; }
      } catch { /* raced with a discard */ }
    }
    return removed;
  }

  private list(dir: string): string[] {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  }
}
