import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  IMAGE_LIMITS,
  imageUrl,
  type ImageAsset,
  type ImageQuery,
} from "../../../shared/images.js";
import type { StagedFile } from "../../../shared/attachments.js";
import { safeName } from "../../../shared/attachments.js";
import { atomicJSON, boundedRead, imageHeader, readJSON } from "./files.js";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
interface Document {
  version: 1;
  assets: ImageAsset[];
}
export class ImageStore {
  readonly root: string;
  private file: string;
  constructor(
    home: string,
    private readonly options: {
      thumbnail(
        bytes: Buffer,
        dimensions: { width: number; height: number },
      ): Buffer;
      referenced?(id: string): boolean;
      changed?(): void;
    },
  ) {
    this.root = path.join(fs.realpathSync(home), "images");
    this.file = path.join(this.root, "library.json");
    fs.mkdirSync(path.join(this.root, "assets"), {
      recursive: true,
      mode: 0o700,
    });
    this.read();
  }
  private read(): Document {
    if (fs.realpathSync(this.root) !== this.root)
      throw new Error("Image library directory changed.");
    const data = readJSON<Document>(this.file, { version: 1, assets: [] });
    if (
      data.version !== 1 ||
      !Array.isArray(data.assets) ||
      new Set(data.assets.map((a) => a.id)).size !== data.assets.length ||
      data.assets.some(
        (a) =>
          !uuid.test(a.id) ||
          typeof a.name !== "string" ||
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
            a.mime,
          ) ||
          !Number.isSafeInteger(a.size) ||
          a.size <= 0 ||
          a.size > IMAGE_LIMITS.bytes ||
          !Number.isSafeInteger(a.width) ||
          !Number.isSafeInteger(a.height) ||
          a.width <= 0 ||
          a.height <= 0 ||
          a.width * a.height > IMAGE_LIMITS.pixels ||
          !Array.isArray(a.parentIds) ||
          a.parentIds.some((id) => !uuid.test(id)) ||
          !["imported", "generated", "attachment"].includes(a.source) ||
          typeof a.createdAt !== "string" ||
          typeof a.updatedAt !== "string" ||
          typeof a.favorite !== "boolean" ||
          (a.trashedAt !== null && typeof a.trashedAt !== "string"),
      )
    )
      throw new Error(
        "Image library is unreadable. Saved files have been preserved.",
      );
    return data;
  }
  private write(data: Document) {
    atomicJSON(this.file, data);
    this.options.changed?.();
  }
  get(id: string): ImageAsset {
    const asset = this.read().assets.find((a) => a.id === id);
    if (!asset) throw new Error("Image no longer exists.");
    return asset;
  }
  list(query: ImageQuery = {}) {
    const offset = query.offset ?? 0;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (query.query?.length ?? 0) > 2000
    )
      throw new Error("Invalid image query.");
    const assets = this.read()
      .assets.filter((a) =>
        query.view === "trash" ? !!a.trashedAt : !a.trashedAt,
      )
      .filter((a) => !query.projectId || a.projectId === query.projectId)
      .filter((a) => query.view !== "favorites" || a.favorite)
      .filter((a) => query.view !== "generated" || a.source === "generated")
      .filter((a) => query.view !== "imported" || a.source !== "generated")
      .filter((a) =>
        `${a.name}\n${a.prompt ?? ""}`
          .toLowerCase()
          .includes((query.query ?? "").toLowerCase()),
      )
      .sort((a, b) =>
        query.sort === "name"
          ? a.name.localeCompare(b.name)
          : b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      );
    return {
      assets: assets.slice(offset, offset + 60),
      total: assets.length,
      nextOffset: offset + 60 < assets.length ? offset + 60 : null,
    };
  }
  import(
    files: StagedFile[],
    metadata: Partial<
      Pick<
        ImageAsset,
        "projectId" | "source" | "jobId" | "parentIds" | "prompt"
      >
    > = {},
  ) {
    if (!Array.isArray(files) || files.length > IMAGE_LIMITS.batch)
      throw new Error("Import up to 20 images at once.");
    const assets: ImageAsset[] = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        if (!file || typeof file.name !== "string")
          throw new Error("Invalid image input.");
        let bytes: Buffer;
        if (typeof file.path === "string" && file.data === undefined)
          bytes = boundedRead(file.path);
        else if (
          typeof file.data === "string" &&
          file.path === undefined &&
          file.data.length <= Math.ceil(IMAGE_LIMITS.bytes / 3) * 4 &&
          /^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
        )
          bytes = Buffer.from(file.data, "base64");
        else throw new Error("Invalid image input or image exceeds 25 MiB.");
        assets.push(this.add(bytes, file.name, metadata));
      } catch (error) {
        errors.push(
          `${safeName(typeof file?.name === "string" ? file.name : "Image")}: ${(error as Error).message}`,
        );
      }
    }
    return { assets, errors };
  }
  add(
    bytes: Buffer,
    name: string,
    metadata: Partial<
      Pick<
        ImageAsset,
        "projectId" | "source" | "jobId" | "parentIds" | "prompt"
      >
    > = {},
  ): ImageAsset {
    if (!bytes.length || bytes.length > IMAGE_LIMITS.bytes)
      throw new Error("Image exceeds 25 MiB.");
    const dimensions = imageHeader(bytes);
    const thumbnail = this.options.thumbnail(bytes, dimensions); // Decoder validates actual contents before publishing.
    if (!thumbnail.length || thumbnail.length > IMAGE_LIMITS.bytes)
      throw new Error("Cannot decode this image.");
    const id = randomUUID();
    const now = new Date().toISOString();
    const dir = path.join(this.root, "assets", id);
    const asset: ImageAsset = {
      id,
      name: safeName(name),
      ...dimensions,
      size: bytes.length,
      createdAt: now,
      updatedAt: now,
      favorite: false,
      trashedAt: null,
      source: "imported",
      parentIds: [],
      ...metadata,
    };
    fs.mkdirSync(dir, { mode: 0o700 });
    try {
      fs.writeFileSync(path.join(dir, "original"), bytes, {
        mode: 0o600,
        flag: "wx",
      });
      fs.writeFileSync(path.join(dir, "thumbnail.png"), thumbnail, {
        mode: 0o600,
        flag: "wx",
      });
      const document = this.read();
      this.write({ ...document, assets: [...document.assets, asset] });
    } catch (error) {
      // Only remove files created by this import; never sweep unknown artifacts on startup.
      for (const file of ["original", "thumbnail.png"]) {
        try {
          fs.unlinkSync(path.join(dir, file));
        } catch {}
      }
      try {
        fs.rmdirSync(dir);
      } catch {}
      throw error;
    }
    return asset;
  }
  filePath(id: string) {
    this.get(id);
    return path.join(this.root, "assets", id, "original");
  }
  bytes(id: string, thumbnail = false) {
    this.get(id);
    const dir = path.join(this.root, "assets", id);
    if (thumbnail && !fs.existsSync(path.join(dir, "thumbnail.png"))) {
      const bytes = boundedRead(path.join(dir, "original"), this.root);
      fs.writeFileSync(
        path.join(dir, "thumbnail.png"),
        this.options.thumbnail(bytes, imageHeader(bytes)),
        { mode: 0o600, flag: "wx" },
      );
    }
    return boundedRead(
      path.join(dir, thumbnail ? "thumbnail.png" : "original"),
      this.root,
    );
  }
  update(input: {
    id: string;
    name?: string;
    favorite?: boolean;
    trash?: boolean;
    projectId?: string | null;
  }) {
    const current = this.get(input.id);
    if (
      (input.name !== undefined &&
        (typeof input.name !== "string" ||
          !input.name.trim() ||
          input.name.length > 120)) ||
      (input.favorite !== undefined && typeof input.favorite !== "boolean") ||
      (input.trash !== undefined && typeof input.trash !== "boolean")
    )
      throw new Error("Invalid image update.");
    const next: ImageAsset = {
      ...current,
      ...(input.name !== undefined ? { name: safeName(input.name) } : {}),
      ...(input.favorite !== undefined ? { favorite: input.favorite } : {}),
      ...(input.projectId !== undefined
        ? { projectId: input.projectId ?? undefined }
        : {}),
      ...(input.trash !== undefined
        ? { trashedAt: input.trash ? new Date().toISOString() : null }
        : {}),
      updatedAt: new Date().toISOString(),
    };
    const data = this.read();
    this.write({
      ...data,
      assets: data.assets.map((a) => (a.id === next.id ? next : a)),
    });
    return next;
  }
  delete(id: string) {
    const asset = this.get(id);
    if (!asset.trashedAt) throw new Error("Move this image to Trash first.");
    if (this.options.referenced?.(id))
      throw new Error(
        "This image is still referenced by a page, page history or active job.",
      );
    const data = this.read();
    this.write({ ...data, assets: data.assets.filter((a) => a.id !== id) });
    // A failed unlink leaves an unreferenced owned blob; it cannot invalidate the rest of the library.
    for (const name of ["original", "thumbnail.png"]) {
      try {
        fs.unlinkSync(path.join(this.root, "assets", id, name));
      } catch {}
    }
    try {
      fs.rmdirSync(path.join(this.root, "assets", id));
    } catch {}
  }
  markdown(id: string) {
    const asset = this.get(id);
    return `![${asset.name.replace(/[\[\]\\\r\n]/g, " ")}](${imageUrl(id)})`;
  }
}
