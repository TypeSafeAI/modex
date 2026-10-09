import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { CreateSpacePage, SpacePage, SpaceChangeContext, SpacePageVersion } from "../../shared/space.js";

interface SpaceDocument { version: 2; pages: SpacePage[]; history: SpacePageVersion[]; }

/** Read before every mutation, validate before writing, and atomically replace the local document file. */
export class SpaceStore {
  private readonly file: string;
  constructor(private readonly dir: string) { this.file = path.join(dir, "space.json"); }

  list(): SpacePage[] { return this.read().pages; }

  /** Versions are returned oldest first; legacy pages expose their preserved baseline. */
  history(id: string): SpacePageVersion[] {
    const data = this.read();
    this.find(data.pages, id);
    return data.history.filter(version => version.page.id === id);
  }

  private read(): SpaceDocument {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!data || (data.version !== 1 && data.version !== 2) || !Array.isArray(data.pages)) throw new Error("Unsupported document format");
      for (const page of data.pages) validate(page);
      if (new Set(data.pages.map((page: SpacePage) => page.id)).size !== data.pages.length) throw new Error("Duplicate Space page id.");
      if (data.version === 1) {
        if ("history" in data) throw new Error("Unexpected version history in legacy document.");
        return { version: 2, pages: data.pages, history: data.pages.map((page: SpacePage) => ({ page, actor: "unknown", summary: "Existing page before version history" })) };
      }
      validateHistory(data);
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, pages: [], history: [] };
      throw new Error(`Space could not read saved pages. Your file has been preserved. ${(error as Error).message}`);
    }
  }

  create(input: CreateSpacePage, change?: SpaceChangeContext): SpacePage {
    const data = this.read();
    const { pages } = data;
    const now = new Date().toISOString();
    const page: SpacePage = { id: randomUUID(), parentId: input.parentId ?? null, title: input.title ?? "", markdown: input.markdown ?? "", favorite: false, createdAt: now, updatedAt: now, trashedAt: null, revision: 1 };
    validate(page);
    this.validateParent(page, pages);
    this.write({ ...data, pages: [...pages, page], history: [...data.history, this.version(page, change, "Created page")] });
    return page;
  }

  save(input: SpacePage, change?: SpaceChangeContext): SpacePage {
    validate(input);
    const data = this.read();
    const { pages } = data;
    const current = this.find(pages, input.id);
    this.checkRevision(current, input.revision);
    if (current.trashedAt) throw new Error("Restore this page before editing it.");
    this.validateParent(input, pages);
    const page: SpacePage = { ...current, title: input.title, markdown: input.markdown, favorite: input.favorite, parentId: input.parentId, updatedAt: new Date().toISOString(), revision: current.revision + 1 };
    const version = this.version(page, change, "Updated page");
    let history = [...data.history, version];
    if (!change) {
      // Autosave runs for every keystroke. Keep periodic human checkpoints without
      // discarding the original page or any explicit agent/recovery operation.
      version.checkpointAt = page.updatedAt;
      let latestIndex = data.history.length - 1;
      while (latestIndex >= 0 && data.history[latestIndex]!.page.id !== page.id) latestIndex--;
      const latest = data.history[latestIndex];
      const elapsed = Date.parse(page.updatedAt) - Date.parse(latest?.checkpointAt ?? "");
      if (latest?.actor === "human" && latest.checkpointAt && elapsed >= 0 && elapsed < 30_000) {
        version.checkpointAt = latest.checkpointAt;
        history = data.history.map((v, index) => index === latestIndex ? version : v);
      }
    }
    this.write({ ...data, pages: pages.map(p => p.id === page.id ? page : p), history });
    return page;
  }

  trash(id: string, trash: boolean, revision?: number, change?: SpaceChangeContext): SpacePage[] {
    const data = this.read();
    const { pages } = data;
    const current = this.find(pages, id);
    if (revision !== undefined) this.checkRevision(current, revision);
    if (typeof trash !== "boolean") throw new Error("Invalid trash action.");
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
    this.write({ ...data, pages: next, history: [...data.history, ...next.filter(p => affected.has(p.id)).map(p => this.version(p, change, trash ? "Moved page to Trash" : "Restored page"))] });
    return next;
  }

  revert(id: string, expectedRevision: number, versionRevision: number, change?: SpaceChangeContext): SpacePage {
    const data = this.read();
    const current = this.find(data.pages, id);
    this.checkRevision(current, expectedRevision);
    if (current.trashedAt) throw new Error("Restore this page before editing it.");
    const version = data.history.find(v => v.page.id === id && v.page.revision === versionRevision);
    if (!version) throw new Error("This Space page version does not exist.");
    return this.save({ ...version.page, revision: current.revision }, change ?? { actor: "human", summary: `Reverted to revision ${versionRevision}` });
  }

  private find(pages: SpacePage[], id: string): SpacePage {
    const page = pages.find(p => p.id === id);
    if (!page) throw new Error("This Space page no longer exists.");
    return page;
  }

  private checkRevision(page: SpacePage, revision: number): void {
    if (page.revision !== revision) throw new Error("This page changed in another window. Copy your edits, then reopen Space to load the saved version.");
  }

  private version(page: SpacePage, change: SpaceChangeContext | undefined, summary: string): SpacePageVersion {
    const attribution = change ?? { actor: "human", summary };
    validateChange(attribution);
    return { page, actor: attribution.actor, summary: attribution.summary };
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

  private write(data: SpaceDocument): void {
    for (const page of data.pages) validate(page);
    validateHistory(data);
    fs.mkdirSync(this.dir, { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temporary, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify(data)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
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

function validateChange(change: SpaceChangeContext): void {
  if (!change || typeof change.actor !== "string" || !change.actor.trim() || change.actor.length > 200) throw new Error("Invalid Space change actor.");
  if (typeof change.summary !== "string" || !change.summary.trim() || change.summary.length > 2_000) throw new Error("Invalid Space change summary.");
}

function validateHistory(data: SpaceDocument): void {
  if (!Array.isArray(data.history)) throw new Error("Invalid Space version history.");
  const pages = new Map(data.pages.map(page => [page.id, page]));
  const latest = new Map<string, SpacePage>();
  for (const version of data.history) {
    validateChange(version);
    validate(version.page);
    if (version.checkpointAt !== undefined && (version.actor !== "human" || typeof version.checkpointAt !== "string" || !Number.isFinite(Date.parse(version.checkpointAt)))) throw new Error("Invalid Space typing checkpoint.");
    const page = version.page;
    const previous = latest.get(page.id);
    if (!pages.has(page.id) || (previous && (page.revision <= previous.revision || page.createdAt !== previous.createdAt))) throw new Error("Invalid Space version sequence.");
    latest.set(page.id, page);
  }
  for (const page of data.pages) {
    if (!isDeepStrictEqual(latest.get(page.id), page)) throw new Error("Space version history does not match saved pages.");
  }
}
