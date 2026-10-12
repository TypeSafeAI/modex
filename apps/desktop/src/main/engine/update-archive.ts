import fs from "node:fs/promises";
import { constants, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openPromise, type Entry } from "yauzl";

interface Limits { archiveBytes: number; expandedBytes: number; fileBytes: number; entries: number }
const DEFAULT_LIMITS: Limits = { archiveBytes: 512 * 1024 * 1024, expandedBytes: 2 * 1024 * 1024 * 1024, fileBytes: 512 * 1024 * 1024, entries: 20_000 };
interface ArchiveOptions { parent: string; sha512: string; size: number; limits?: Partial<Limits> }
interface StagedUpdate { archive: string; bundle: string; dispose(): Promise<void> }
type Kind = "file" | "directory" | "link";
type Member = { entry: Entry; name: string; kind: Kind; mode: number };

/** Integrity and containment only. The staged bundle still requires publisher verification. */
export async function stageUpdateArchive(source: string, options: ArchiveOptions): Promise<StagedUpdate> {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(options.sha512)) throw new Error("Invalid update checksum.");
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n <= 0)
    || !Number.isSafeInteger(options.size) || options.size <= 0 || options.size > limits.archiveBytes) throw new Error("Update archive exceeds the size limit.");
  const directory = await fs.realpath(await fs.mkdtemp(path.join(options.parent, "verify-")));
  await fs.chmod(directory, 0o700);
  const archive = path.join(directory, "candidate.zip");
  const bundle = path.join(directory, "Modex.app");
  const dispose = () => fs.rm(directory, { recursive: true, force: true });
  try {
    // Copy and hash the same opened regular file. All later reads use our private snapshot.
    const file = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== options.size) throw new Error("Update archive size changed.");
      const hash = createHash("sha512");
      let size = 0;
      await pipeline(file.createReadStream({ autoClose: false }), new Transform({ transform(chunk: Buffer, _encoding, done) {
        size += chunk.length;
        if (size > options.size) return done(new Error("Update archive exceeds its size limit."));
        hash.update(chunk); done(null, chunk);
      } }), createWriteStream(archive, { flags: "wx", mode: 0o600 }));
      if (size !== options.size || hash.digest("base64") !== options.sha512) throw new Error("Update archive checksum mismatch.");
    } finally { await file.close(); }

    const zip = await openPromise(archive, { autoClose: false, strictFileNames: true, validateEntrySizes: true });
    try {
      const members: Member[] = [];
      const names = new Map<string, { name: string; kind: Kind; explicit: boolean }>();
      let expanded = 0;
      let pathMetadata = 0;
      for await (const entry of zip.eachEntry()) {
        if (members.length >= limits.entries) throw new Error("Update archive entry limit exceeded.");
        const directoryEntry = entry.fileName.endsWith("/");
        const name = directoryEntry ? entry.fileName.slice(0, -1) : entry.fileName;
        if (Buffer.byteLength(name) > 1024) throw new Error("Update archive path limit exceeded.");
        const parts = name.split("/");
        if (parts.length > 32) throw new Error("Update archive path limit exceeded.");
        if (parts[0] !== "Modex.app" || parts.some(p => !p || p === "." || p === ".." || /[\\:\x00-\x1f\x7f]/.test(p) || /[. ]$/.test(p))) throw new Error("Unsafe update archive path.");
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const type = mode & 0o170000;
        if (entry.isEncrypted() || (mode & 0o7000) || ![0, 0o100000, 0o040000, 0o120000].includes(type)) throw new Error("Unsupported update archive entry.");
        const kind: Kind = type === 0o120000 ? "link" : directoryEntry ? "directory" : "file";
        if ((directoryEntry && type !== 0 && type !== 0o040000) || (!directoryEntry && type === 0o040000)) throw new Error("Inconsistent update archive entry.");
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > limits.fileBytes
          || (expanded += entry.uncompressedSize) > limits.expandedBytes
          || (kind === "link" && entry.uncompressedSize > 4096)) throw new Error("Update archive expanded size limit exceeded.");
        if (kind === "directory" && entry.uncompressedSize !== 0) throw new Error("Invalid update directory.");
        for (let i = 1; i <= parts.length; i++) {
          const segment = parts.slice(0, i).join("/");
          const key = segment.normalize("NFC").toLowerCase();
          const last = i === parts.length;
          const expectedKind = last ? kind : "directory";
          const previous = names.get(key);
          if (previous && (previous.name !== segment || previous.kind !== expectedKind || (last && previous.explicit))) throw new Error("Update archive path collision.");
          if (!previous && (names.size >= limits.entries || (pathMetadata += segment.length + key.length) > 8 * 1024 * 1024)) throw new Error("Update archive path limit exceeded.");
          names.set(key, { name: segment, kind: expectedKind, explicit: Boolean(previous?.explicit || last) });
        }
        members.push({ entry, name, kind, mode });
      }
      if (!members.some(m => m.name === "Modex.app/Contents/MacOS/Modex" && m.kind === "file" && (m.mode & 0o111))) throw new Error("Update archive has no app executable.");
      const links: { name: string; target: string }[] = [];
      // No symlink exists during file extraction. The complete topology was checked above,
      // so no file or directory can be written beneath a link, even if ZIP entries reorder it.
      for (const member of members) {
        const destination = path.join(directory, member.name);
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
        if (member.kind === "directory") { await fs.mkdir(destination, { recursive: true, mode: 0o755 }); continue; }
        const stream = await zip.openReadStreamPromise(member.entry);
        if (member.kind === "file") {
          await pipeline(stream, createWriteStream(destination, { flags: "wx", mode: member.mode & 0o777 || 0o644 }));
        } else {
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(Buffer.from(chunk));
          const bytes = Buffer.concat(chunks);
          const target = bytes.toString("utf8");
          const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(member.name), target));
          if (!bytes.equals(Buffer.from(target)) || !target || /[\\:\x00-\x1f\x7f]/.test(target) || path.posix.isAbsolute(target)
            || (resolved !== "Modex.app" && !resolved.startsWith("Modex.app/"))) throw new Error("Unsafe update archive symlink.");
          links.push({ name: destination, target });
        }
      }
      for (const link of links) await fs.symlink(link.target, link.name);
      for (const link of links) {
        const real = await fs.realpath(link.name);
        const relative = path.relative(bundle, real);
        if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("Update symlink escapes the app.");
      }
    } finally { zip.close(); }
    return { archive, bundle, dispose };
  } catch (error) { await dispose(); throw error; }
}
