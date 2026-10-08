import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CreateSpacePage, SpacePage } from "../../shared/space.js";

/** Read before every mutation, validate before writing, and atomically replace the local document file. */
export class SpaceStore {
  private readonly file: string;
  constructor(private readonly dir: string) { this.file = path.join(dir, "space.json"); }

  list(): SpacePage[] {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.pages)) throw new Error("Unsupported document format");
      for (const page of data.pages) validate(page);
      return data.pages;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`Space could not read saved pages. Your file has been preserved. ${(error as Error).message}`);
    }
  }

  create(input: CreateSpacePage): SpacePage {
    const pages = this.list();
    const now = new Date().toISOString();
    const page: SpacePage = { id: randomUUID(), parentId: input.parentId ?? null, title: input.title ?? "", markdown: input.markdown ?? "", favorite: false, createdAt: now, updatedAt: now, trashedAt: null, revision: 1 };
    validate(page);
    this.validateParent(page, pages);
    this.write([...pages, page]);
    return page;
  }

  save(input: SpacePage): SpacePage {
    validate(input);
    const pages = this.list();
    const current = pages.find(p => p.id === input.id);
    if (!current) throw new Error("This Space page no longer exists.");
    if (current.revision !== input.revision) throw new Error("This page changed in another window. Copy your edits, then reopen Space to load the saved version.");
    if (current.trashedAt) throw new Error("Restore this page before editing it.");
    this.validateParent(input, pages);
    const page: SpacePage = { ...current, title: input.title, markdown: input.markdown, favorite: input.favorite, parentId: input.parentId, updatedAt: new Date().toISOString(), revision: current.revision + 1 };
    this.write(pages.map(p => p.id === page.id ? page : p));
    return page;
  }

  trash(id: string, trash: boolean): SpacePage[] {
    const pages = this.list();
    if (!pages.some(p => p.id === id)) throw new Error("This Space page no longer exists.");
    const affected = new Set([id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of pages) if (p.parentId && affected.has(p.parentId) && !affected.has(p.id)) { affected.add(p.id); changed = true; }
    }
    // Reachable ancestors do not broaden a restore into unrelated sibling subtrees.
    if (!trash) {
      let parent = pages.find(p => p.id === id)?.parentId;
      const visited = new Set<string>();
      while (parent && !visited.has(parent)) { visited.add(parent); affected.add(parent); parent = pages.find(p => p.id === parent)?.parentId; }
    }
    const now = new Date().toISOString();
    const next = pages.map(p => affected.has(p.id) ? { ...p, trashedAt: trash ? now : null, updatedAt: now, revision: p.revision + 1 } : p);
    this.write(next);
    return next;
  }

  private validateParent(page: SpacePage, pages: SpacePage[]): void {
    let id = page.parentId;
    const visited = new Set([page.id]);
    while (id) {
      if (visited.has(id)) throw new Error("A page cannot be placed inside itself.");
      visited.add(id);
      const parent = pages.find(p => p.id === id);
      if (!parent || parent.trashedAt) throw new Error("Choose an existing page as the parent.");
      id = parent.parentId;
    }
  }

  private write(pages: SpacePage[]): void {
    fs.mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ version: 1, pages })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}

function validate(page: SpacePage): void {
  if (!page || typeof page !== "object" || typeof page.id !== "string" || !/^[a-z0-9-]{1,64}$/i.test(page.id)) throw new Error("Invalid Space page id.");
  if (typeof page.title !== "string" || page.title.length > 200) throw new Error("Page title must be at most 200 characters.");
  if (typeof page.markdown !== "string" || page.markdown.length > 1_000_000) throw new Error("A Space page can contain up to 1 MB of text.");
  if (page.parentId !== null && typeof page.parentId !== "string") throw new Error("Invalid parent page.");
  if (typeof page.favorite !== "boolean" || !Number.isSafeInteger(page.revision) || page.revision < 1 ||
      typeof page.createdAt !== "string" || typeof page.updatedAt !== "string" || (page.trashedAt !== null && typeof page.trashedAt !== "string")) throw new Error("Invalid Space page metadata.");
}
