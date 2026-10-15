import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { IMAGE_LIMITS } from "../../../shared/images.js";
export function atomicJSON(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
export function readJSON<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw new Error(
      `Cannot read saved image data; original file preserved: ${path.basename(file)}`,
    );
  }
}
export function boundedRead(file: string, root?: string): Buffer {
  if (root) {
    if (fs.lstatSync(root).isSymbolicLink())
      throw new Error("Image root cannot be a symlink.");
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    const relative = path.relative(realRoot, real);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error("Image is outside its output directory.");
    // Reject symlink ancestors as well as the leaf.
    let current = root;
    for (const part of path.relative(root, file).split(path.sep)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error("Image symlinks are not supported.");
    }
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > IMAGE_LIMITS.bytes
    )
      throw new Error("Images must be regular files up to 25 MiB.");
    const buffer = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < buffer.length) {
      const n = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!n) throw new Error("Image changed while reading.");
      offset += n;
    }
    const after = fs.fstatSync(fd);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      throw new Error("Image changed while reading.");
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}
/** Read bounded container dimensions before asking the native decoder to allocate pixels. */
export function imageHeader(b: Buffer): {
  mime: string;
  width: number;
  height: number;
} {
  let mime = "";
  let width = 0;
  let height = 0;
  if (
    b.length >= 24 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    b.toString("ascii", 12, 16) === "IHDR"
  ) {
    mime = "image/png";
    width = b.readUInt32BE(16);
    height = b.readUInt32BE(20);
  } else if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString("ascii", 0, 6))) {
    mime = "image/gif";
    width = b.readUInt16LE(6);
    height = b.readUInt16LE(8);
  } else if (
    b.length >= 30 &&
    b.toString("ascii", 0, 4) === "RIFF" &&
    b.toString("ascii", 8, 12) === "WEBP"
  ) {
    mime = "image/webp";
    const type = b.toString("ascii", 12, 16);
    if (type === "VP8X") {
      width = b.readUIntLE(24, 3) + 1;
      height = b.readUIntLE(27, 3) + 1;
    } else if (
      type === "VP8 " &&
      b.subarray(23, 26).equals(Buffer.from([157, 1, 42]))
    ) {
      width = b.readUInt16LE(26) & 16383;
      height = b.readUInt16LE(28) & 16383;
    } else if (type === "VP8L" && b[20] === 47) {
      const bits = b.readUInt32LE(21);
      width = (bits & 16383) + 1;
      height = ((bits >>> 14) & 16383) + 1;
    }
  } else if (b.length >= 4 && b[0] === 255 && b[1] === 216) {
    mime = "image/jpeg";
    for (let i = 2; i + 4 <= b.length; ) {
      if (b[i++] !== 255) break;
      while (b[i] === 255) i++;
      const marker = b[i++];
      if (marker === undefined || marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (i + 2 > b.length) break;
      const length = b.readUInt16BE(i);
      if (length < 2 || i + length > b.length) break;
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker) &&
        length >= 8
      ) {
        height = b.readUInt16BE(i + 3);
        width = b.readUInt16BE(i + 5);
        break;
      }
      i += length;
    }
  }
  if (!width || !height || width * height > IMAGE_LIMITS.pixels)
    throw new Error(
      "Use a valid PNG, JPEG, WebP or GIF image up to 40 megapixels.",
    );
  return { mime, width, height };
}
