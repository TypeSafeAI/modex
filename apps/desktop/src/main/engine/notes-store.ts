import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CreateSpacePage, SpaceChangeContext, SpaceComment, SpacePage, SpacePageVersion } from "../../shared/space.js";
import { canContain, type NotesFile, type NotesFolder, type NotesNode, type NotesNodeKind, type NotesProject, type NotesTree, type NotesWorkspace } from "../../shared/notes.js";
import { nameKey, noteStem, uniqueName } from "../../shared/notes-names.js";
import { formatNote, parseNote, type ParsedNote } from "./notes-frontmatter.js";
import { fsyncDir, moveNoClobber, writeFileDurably } from "./durable-file.js";
import { planMigration } from "./notes-migration.js";
import { readSpaceDocument, validate, validateChange, validateComment, type SpaceDocument, type SpacePagesStore } from "./space-store.js";

const ID = /^[a-z0-9-]{1,64}$/i;
/** A note file larger than this is listed as a plain file, not a page. */
const MAX_NOTE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 30;
const CHECKPOINT_MS = 30_000;
/** A file must be missing on two scans this far apart before it counts as deleted outside Modex. */
const MISSING_MS = 1_000;
export const DEFAULT_WORKSPACE = "Personal";
export const DEFAULT_PROJECT = "Notes";
const utf8 = new TextDecoder("utf-8", { fatal: true });

interface IndexEntry {
  /** Where the note file was last seen, or null when it is in the trash or gone. */
  rel: string | null;
  /** sha256 of the file as Modex last wrote or confirmed it. */
  hash: string | null;
  ino?: number;
  trash?: { batch: string; rel: string; original: string };
  /** Where a note deleted outside Modex lived, so a restore writes it back there. */
  original?: string;
}
interface Placed { rel: string; ino?: number; /** A folder's name as typed, when its folder name could not carry it. */ title?: string }
interface NotesIndex {
  version: 1; defaultProject: string; notes: Record<string, IndexEntry>;
  /** Folders without a marker of their own, and plain files: where each id was last seen. */
  containers?: Record<string, Placed>; files?: Record<string, Placed>;
}
interface Marker {
  version: 1; id: string; title: string; order: number; default?: boolean;
  /** The Modex project these notes belong to; null once it is removed (the notes stay). */
  modexProjectId?: string | null;
  /** That project's folder, so adding it again finds these notes. */
  codePath?: string;
  detachedAt?: string;
}
/** A Modex project, as much of it as its notes need. */
export interface LinkedProject { id: string; name: string; path: string }
export interface NotesWorkspaceSummary { id: string; name: string; order: number; isDefault: boolean; modexProjectIds: string[] }
interface HistoryFile { version: 1; versions: SpacePageVersion[] }
interface TrashManifest { version: 1; id: string; trashedAt: string; items: { id: string; original: string; rel: string }[] }
export interface MigrationReceipt {
  version: 1;
  /** `app/space.json` when pages were migrated from it; null for a fresh folder. */
  source: string | null;
  sha256: string | null;
  migratedAt: string;
  revisions: Record<string, number>;
  mapping: Record<string, string>;
  warnings: string[];
}
interface LiveNote { rel: string; ino: number; size: number; mtimeMs: number; hash: string; parsed: ParsedNote }
interface State { pages: Map<string, SpacePage>; index: NotesIndex; live: Map<string, LiveNote> }

export interface NotesStoreOptions {
  /** This home's `app/space.json`: migrated into the folder once, then left as it is. */
  legacySpaceFile?: string;
  /** Milliseconds since the epoch; tests move it. */
  now?: () => number;
  /** Modex's projects: each gets its own notes project when the folder opens. */
  projects?: () => LinkedProject[];
}

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const preserved = (error: unknown) => new Error(`Space could not read saved pages. Your file has been preserved. ${(error as Error).message}`);
const byCreation = (a: SpacePage, b: SpacePage) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
const stemOf = (rel: string) => path.posix.basename(rel).replace(/\.md$/i, "");
const depth = (dirRel: string) => (dirRel ? dirRel.split("/").length : 0);

/**
 * Space pages as Markdown files under `MODEX_HOME/notes/`, laid out Workspace › Project › folders.
 *
 * Each note carries its id in `modex_id` frontmatter, so a move or a crash never loses which page a
 * file is. A page with children is a folder holding a folder note of the same name. Modex keeps the
 * rest in `.modex/` (hidden from Open Knowledge and Finder's listing): one version history per page
 * (the newest version is the page, as in SpaceStore), comments, trash batches, and an index of where
 * each file was last seen. Writes go history, then note, then index; reading reconciles whatever a
 * crash left half-done, and records edits made outside Modex as versions of their own.
 */
export class NotesStore implements SpacePagesStore {
  readonly root: string;
  private readonly meta: string;
  private readonly now: () => number;
  private opened = false;
  private readonly missing = new Map<string, number>();
  private readonly fileCache = new Map<string, LiveNote>();
  private readonly historyCache = new Map<string, { key: string; versions: SpacePageVersion[] }>();

  constructor(root: string, private readonly options: NotesStoreOptions = {}) {
    this.root = path.resolve(root);
    this.meta = path.join(this.root, ".modex");
    this.now = options.now ?? Date.now;
  }

  list(): SpacePage[] { return [...this.load().pages.values()].sort(byCreation); }

  comments(pageId: string): SpaceComment[] {
    this.find(this.load(), pageId);
    return this.readComments(pageId);
  }

  addComment(pageId: string, text: string, quote: string): SpaceComment {
    const state = this.load();
    if (this.find(state, pageId).trashedAt) throw new Error("Restore this page before commenting on it.");
    const comment: SpaceComment = { id: randomUUID(), pageId, text: typeof text === "string" ? text.trim() : text, quote, createdAt: this.iso() };
    validateComment(comment);
    this.writeJson(this.commentsFile(pageId), [...this.readComments(pageId), comment]);
    return comment;
  }

  deleteComment(pageId: string, id: string): void {
    this.find(this.load(), pageId);
    this.writeJson(this.commentsFile(pageId), this.readComments(pageId).filter(comment => comment.id !== id));
  }

  /** Versions oldest first. */
  history(id: string): SpacePageVersion[] {
    this.find(this.load(), id);
    return [...(this.readHistory(id) ?? [])];
  }

  create(input: CreateSpacePage, change?: SpaceChangeContext): SpacePage {
    const state = this.load();
    const now = this.iso();
    let dir: string | null = null;
    let parentId = input.parentId ?? null;
    if (input.containerId !== undefined) {
      const container = this.layout(state).byId.get(input.containerId);
      if (!container || (container.kind !== "project" && container.kind !== "folder")) throw new Error("Choose a project or folder for the new page.");
      dir = container.rel;
      parentId = container.kind === "folder" ? container.noteId : null;
    }
    const page: SpacePage = { id: randomUUID(), parentId, title: input.title ?? "", markdown: input.markdown ?? "", favorite: false, createdAt: now, updatedAt: now, trashedAt: null, revision: 1 };
    validate(page);
    this.validateParent(page, state.pages);
    const version = this.version(page, change, "Created page");
    dir ??= this.dirFor(state, page.parentId, state.index.defaultProject);
    const rel = `${dir}/${uniqueName(noteStem(page.title), ".md", this.names(dir))}`;
    this.writeHistory(page.id, [version]);
    this.writeNoteAt(state, page, rel);
    this.writeIndex(state.index);
    return page;
  }

  save(input: SpacePage, change?: SpaceChangeContext): SpacePage {
    validate(input);
    const state = this.load();
    const current = this.find(state, input.id);
    this.checkRevision(current, input.revision);
    if (current.trashedAt) throw new Error("Restore this page before editing it.");
    this.validateParent(input, state.pages);
    const page: SpacePage = { ...current, title: input.title, markdown: input.markdown, favorite: input.favorite, parentId: input.parentId, updatedAt: this.iso(), revision: current.revision + 1 };
    const version = this.version(page, change, "Updated page");
    this.writeHistory(page.id, this.appendVersion(this.readHistory(page.id) ?? [], version, change ? null : "human"));
    state.pages.set(page.id, page);
    let rel = this.liveRel(state, page.id);
    if (page.parentId !== current.parentId) rel = this.move(state, page.id, page.parentId);
    this.writeNoteAt(state, page, rel);
    this.writeIndex(state.index);
    return page;
  }

  trash(id: string, trash: boolean, revision?: number, change?: SpaceChangeContext): SpacePage[] {
    const state = this.load();
    const current = this.find(state, id);
    if (revision !== undefined) this.checkRevision(current, revision);
    if (typeof trash !== "boolean") throw new Error("Invalid trash action.");
    const pages = [...state.pages.values()];
    const affected = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const p of pages) if (p.parentId && affected.has(p.parentId) && !affected.has(p.id)) { affected.add(p.id); grew = true; }
    }
    // Reachable ancestors do not broaden a restore into unrelated sibling subtrees.
    if (!trash) {
      let parent = current.parentId;
      const visited = new Set<string>();
      while (parent && !visited.has(parent)) { visited.add(parent); affected.add(parent); parent = state.pages.get(parent)?.parentId ?? null; }
    }
    const now = this.iso();
    const next = pages.filter(p => affected.has(p.id)).map(p => ({ ...p, trashedAt: trash ? now : null, updatedAt: now, revision: p.revision + 1 }));
    const versions = next.map(p => ({ page: p, ...this.attribution(change, trash ? "Moved page to Trash" : "Restored page") }));
    if (trash) {
      const batch = randomUUID();
      const items = next.filter(p => state.live.has(p.id)).map(p => ({ id: p.id, original: state.live.get(p.id)!.rel, rel: state.live.get(p.id)!.rel }));
      if (items.length) this.writeJson(this.manifestFile(batch), { version: 1, id: batch, trashedAt: now, items } satisfies TrashManifest);
      for (const v of versions) this.writeHistory(v.page.id, [...(this.readHistory(v.page.id) ?? []), v]);
      // Deepest first, so a folder note leaves its folder after its children.
      for (const item of [...items].sort((a, b) => b.original.split("/").length - a.original.split("/").length)) {
        moveNoClobber(this.abs(item.original), this.trashAbs(batch, item.rel));
        state.index.notes[item.id] = { rel: null, hash: state.index.notes[item.id]?.hash ?? null, trash: { batch, rel: item.rel, original: item.original } };
        state.live.delete(item.id);
        this.removeEmptyDirs(path.posix.dirname(item.original));
      }
    } else {
      for (const v of versions) this.writeHistory(v.page.id, [...(this.readHistory(v.page.id) ?? []), v]);
      for (const p of next) state.pages.set(p.id, p);
      // Parents first, so each folder exists before its notes return to it.
      const order = next.map(p => ({ page: p, original: state.index.notes[p.id]?.trash?.original ?? state.index.notes[p.id]?.rel ?? "" }))
        .sort((a, b) => a.original.split("/").length - b.original.split("/").length);
      for (const { page } of order) if (!state.live.has(page.id)) this.restoreFile(state, page);
    }
    for (const p of next) state.pages.set(p.id, p);
    this.writeIndex(state.index);
    return [...state.pages.values()].sort(byCreation);
  }

  revert(id: string, expectedRevision: number, versionRevision: number, change?: SpaceChangeContext): SpacePage {
    const state = this.load();
    const current = this.find(state, id);
    this.checkRevision(current, expectedRevision);
    if (current.trashedAt) throw new Error("Restore this page before editing it.");
    const version = (this.readHistory(id) ?? []).find(v => v.page.revision === versionRevision);
    if (!version) throw new Error("This Space page version does not exist.");
    return this.save({ ...version.page, revision: current.revision }, change ?? { actor: "human", summary: `Reverted to revision ${versionRevision}` });
  }

  /**
   * Renames a page's file (and its folder, for a folder note) to match its title. Typing never renames
   * a file, which would churn Open Knowledge's file tree; the renderer settles a page when its title
   * loses focus or another page opens.
   */
  settle(id: string): SpacePage {
    const state = this.load();
    const page = this.find(state, id);
    const live = state.live.get(id);
    if (page.trashedAt || !live) return page;
    const stem = noteStem(page.title);
    if (stemOf(live.rel) === stem) return page;
    const dir = path.posix.dirname(live.rel);
    if (this.isFolderNote(live.rel)) {
      const parent = path.posix.dirname(dir);
      const name = nameKey(path.posix.basename(dir)) === nameKey(stem) ? stem : uniqueName(stem, "", this.names(parent).filter(n => nameKey(n) !== nameKey(path.posix.basename(dir))));
      const target = `${parent}/${name}`;
      if (target !== dir) fs.renameSync(this.abs(dir), this.abs(target));
      this.rebase(state, dir, target);
      const from = `${target}/${path.posix.basename(live.rel)}`;
      this.renameNote(state, page, from, `${target}/${name}.md`);
    } else {
      const name = uniqueName(stem, ".md", this.names(dir).filter(n => nameKey(n) !== nameKey(path.posix.basename(live.rel))));
      this.renameNote(state, page, live.rel, `${dir}/${name}`);
    }
    this.writeIndex(state.index);
    return page;
  }

  // ── The tree: workspaces, projects, folders and files ────────────────────────────────────

  /** Everything in the folder, for the sidebar. */
  tree(): NotesTree {
    const state = this.load();
    const { nodes, truncated } = this.layout(state);
    const version = sha256(JSON.stringify([nodes.map(n => [n.id, n.rel, n.name]), [...state.pages.values()].map(p => [p.id, p.revision, p.trashedAt])])).slice(0, 16);
    return { version, nodes, truncated };
  }

  createWorkspace(name: string): NotesWorkspace {
    const state = this.load();
    const stem = this.containerName(name);
    const dir = uniqueName(stem, "", this.names(""));
    const order = Math.max(-1, ...this.layout(state).nodes.filter(n => n.kind === "workspace").map(n => (n as NotesWorkspace).order)) + 1;
    fs.mkdirSync(this.abs(dir));
    this.writeMarker(dir, "workspace", { version: 1, id: randomUUID(), title: name.trim(), order });
    return this.layout(this.load()).byId.get(this.readMarker(dir, "workspace")!.id) as NotesWorkspace;
  }

  createProject(workspaceId: string, name: string, modexProjectId: string | null = null): NotesProject {
    const state = this.load();
    const workspace = this.layout(state).byId.get(workspaceId);
    if (!workspace || workspace.kind !== "workspace") throw new Error("Choose a workspace for the project.");
    const dir = `${workspace.rel}/${uniqueName(this.containerName(name), "", this.names(workspace.rel))}`;
    const order = Math.max(-1, ...this.layout(state).nodes.filter(n => n.kind === "project" && n.parentId === workspaceId).map(n => (n as NotesProject).order)) + 1;
    fs.mkdirSync(this.abs(dir));
    this.writeMarker(dir, "project", { version: 1, id: randomUUID(), title: name.trim(), order, modexProjectId });
    return this.layout(this.load()).byId.get(this.readMarker(dir, "project")!.id) as NotesProject;
  }

  createFolder(parentId: string, name: string): NotesFolder {
    const state = this.load();
    const layout = this.layout(state);
    const parent = layout.byId.get(parentId);
    if (!parent || !canContain(parent.kind, "folder")) throw new Error("Choose a project or folder for the new folder.");
    const dir = `${parent.rel}/${uniqueName(this.containerName(name), "", this.names(parent.rel))}`;
    fs.mkdirSync(this.abs(dir));
    const id = randomUUID();
    state.index.containers = { ...state.index.containers, [id]: { rel: dir, ino: fs.statSync(this.abs(dir)).ino, title: name.trim() } };
    this.writeIndex(state.index);
    return this.layout(this.load()).byId.get(id) as NotesFolder;
  }

  /**
   * Renames a workspace, project, folder or file. A folder with a folder note is renamed through its
   * page, so the two stay one name; a page itself is renamed by its title.
   */
  rename(id: string, name: string): NotesNode {
    const state = this.load();
    const node = this.layout(state).byId.get(id);
    if (state.pages.has(id) || node?.kind === "note") throw new Error("Rename a page by editing its title.");
    if (!node) throw new Error("This item is no longer in your notes.");
    if (typeof name !== "string" || !name.trim() || name.length > 200) throw new Error("A name needs 1 to 200 characters.");
    if (node.kind === "folder" && node.noteId) {
      const page = this.find(state, node.noteId);
      this.settle(this.save({ ...page, title: name.trim() }, { actor: "human", summary: "Renamed folder" }).id);
      return this.layout(this.load()).byId.get(id)!;
    }
    const parent = path.posix.dirname(node.rel) === "." ? "" : path.posix.dirname(node.rel);
    const ext = node.kind === "file" ? path.posix.extname(node.rel) : "";
    const stem = node.kind === "file" ? noteStem(name.trim().replace(new RegExp(`${ext.replace(".", "\\.")}$`, "i"), "")) : this.containerName(name);
    const own = path.posix.basename(node.rel);
    const next = `${parent ? `${parent}/` : ""}${uniqueName(stem, ext, this.names(parent).filter(n => nameKey(n) !== nameKey(own)))}`;
    if (next !== node.rel) {
      if (nameKey(next) === nameKey(node.rel)) fs.renameSync(this.abs(node.rel), this.abs(next));
      else moveNoClobber(this.abs(node.rel), this.abs(next));
    }
    if (node.kind === "workspace" || node.kind === "project") {
      const marker = this.readMarker(next, node.kind);
      if (marker) this.writeMarker(next, node.kind, { ...marker, title: name.trim() });
    }
    this.place(state.index, node, next);
    if (node.kind === "folder") state.index.containers = { ...state.index.containers, [id]: { ...state.index.containers![id]!, title: name.trim() } };
    this.writeIndex(state.index);
    return this.layout(this.load()).byId.get(id)!;
  }

  /**
   * Moves notes, folders and files into a project or folder, or projects into a workspace. A page
   * that moves gets a version first, so the next read never mistakes it for a move made outside Modex.
   */
  moveNodes(ids: string[], targetId: string): void {
    const state = this.load();
    const layout = this.layout(state);
    const target = layout.byId.get(targetId);
    if (!target) throw new Error("Choose where to move these.");
    for (const id of ids) {
      const node = layout.byId.get(id);
      if (!node) throw new Error("This item is no longer in your notes.");
      if (!canContain(target.kind, node.kind)) throw new Error(`A ${node.kind} cannot go into a ${target.kind}.`);
      if (target.rel === node.rel || target.rel.startsWith(`${node.rel}/`)) throw new Error("A folder cannot be moved inside itself.");
    }
    for (const id of ids) {
      const now = this.layout(this.load());
      const node = now.byId.get(id)!;
      const into = now.byId.get(targetId)!;
      const fresh = this.load();
      if (node.kind === "note") {
        const page = this.find(fresh, node.id);
        if (page.trashedAt) throw new Error("Restore this page before moving it.");
        const parentId = into.kind === "folder" ? into.noteId : null;
        const rel = `${into.rel}/${uniqueName(stemOf(node.rel), ".md", this.names(into.rel))}`;
        const moved: SpacePage = { ...page, parentId, updatedAt: this.iso(), revision: page.revision + 1 };
        this.writeHistory(page.id, [...(this.readHistory(page.id) ?? []), { page: moved, actor: "human", summary: "Moved page" }]);
        this.renameNote(fresh, moved, node.rel, rel);
        this.writeIndex(fresh.index);
        continue;
      }
      const ext = node.kind === "file" ? path.posix.extname(node.rel) : "";
      const base = path.posix.basename(node.rel);
      const name = node.kind === "file" ? uniqueName(base.slice(0, base.length - ext.length), ext, this.names(into.rel)) : uniqueName(base, "", this.names(into.rel));
      const rel = `${into.rel}/${name}`;
      if (node.kind === "folder" && node.noteId) {
        // The folder note goes with its folder; its parent becomes whatever the new place's folder note is.
        const page = this.find(fresh, node.noteId);
        const moved: SpacePage = { ...page, parentId: into.kind === "folder" ? into.noteId : null, updatedAt: this.iso(), revision: page.revision + 1 };
        this.writeHistory(page.id, [...(this.readHistory(page.id) ?? []), { page: moved, actor: "human", summary: "Moved folder" }]);
        moveNoClobber(this.abs(node.rel), this.abs(rel));
        this.rebase(fresh, node.rel, rel);
        if (name !== base) this.renameNote(fresh, moved, `${rel}/${base}.md`, `${rel}/${name}.md`);
        else fresh.index.notes[page.id] = { ...fresh.index.notes[page.id]!, rel: `${rel}/${base}.md` };
      } else {
        moveNoClobber(this.abs(node.rel), this.abs(rel));
        this.rebase(fresh, node.rel, rel);
      }
      this.place(fresh.index, node, rel);
      this.writeIndex(fresh.index);
    }
  }

  // ── Modex projects ───────────────────────────────────────────────────────────────────────

  /**
   * The notes project of a Modex project. The first time, it is made in the default workspace,
   * unless notes left by an earlier copy of the same project folder are there to link again.
   */
  linkProject(project: LinkedProject): NotesProject {
    const nodes = this.layout(this.load()).nodes;
    const projects = nodes.filter((n): n is NotesProject => n.kind === "project");
    const linked = projects.find(p => p.modexProjectId === project.id);
    if (linked) return linked;
    for (const candidate of projects) {
      const marker = this.readMarker(candidate.rel, "project");
      if (marker && !marker.modexProjectId && marker.codePath === project.path) {
        const { detachedAt: _gone, ...rest } = marker;
        this.writeMarker(candidate.rel, "project", { ...rest, modexProjectId: project.id });
        return this.layout(this.load()).byId.get(candidate.id) as NotesProject;
      }
    }
    const workspace = nodes.find((n): n is NotesWorkspace => n.kind === "workspace" && n.isDefault) ?? nodes.find((n): n is NotesWorkspace => n.kind === "workspace");
    if (!workspace) throw new Error("The notes folder has no workspace.");
    const created = this.createProject(workspace.id, project.name, project.id);
    const marker = this.readMarker(created.rel, "project")!;
    this.writeMarker(created.rel, "project", { ...marker, codePath: project.path });
    return created;
  }

  /** A removed Modex project leaves its notes where they are, ready to link again. */
  detachProject(modexProjectId: string): void {
    const node = this.projectFor(modexProjectId);
    if (!node) return;
    const marker = this.readMarker(node.rel, "project");
    if (marker) this.writeMarker(node.rel, "project", { ...marker, modexProjectId: null, detachedAt: this.iso() });
  }

  projectFor(modexProjectId: string): NotesProject | undefined {
    return this.layout(this.load()).nodes.find((n): n is NotesProject => n.kind === "project" && n.modexProjectId === modexProjectId);
  }

  /** Each workspace, and the Modex projects whose notes are in it, for grouping the chat sidebar. */
  workspaces(): NotesWorkspaceSummary[] {
    const nodes = this.layout(this.load()).nodes;
    return nodes.filter((n): n is NotesWorkspace => n.kind === "workspace").map(w => ({
      id: w.id, name: w.name, order: w.order, isDefault: w.isDefault,
      modexProjectIds: nodes.filter((n): n is NotesProject => n.kind === "project" && n.parentId === w.id && n.modexProjectId !== null).map(p => p.modexProjectId!),
    }));
  }

  /** A page's place in the folder (where a trashed page came from), for scoping a project's agents. */
  pageRel(id: string): string | undefined {
    const state = this.load();
    const entry = state.index.notes[id];
    return state.live.get(id)?.rel ?? entry?.trash?.original ?? entry?.original ?? undefined;
  }

  /** A text file's contents: UTF-8, at most 1 MB. */
  readFile(id: string): string {
    const node = this.layout(this.load()).byId.get(id);
    if (!node || node.kind !== "file") throw new Error("This file is no longer in your notes.");
    if (node.preview !== "text") throw new Error("Only text files up to 1 MB can be read.");
    try { return utf8.decode(fs.readFileSync(this.abs(node.rel))); } catch { throw new Error("This file is not UTF-8 text."); }
  }

  /** Where a node is on disk, for Reveal in Finder and Open. */
  pathOf(id: string): string {
    const state = this.load();
    const node = this.layout(state).byId.get(id);
    const live = state.live.get(id);
    if (node) return this.abs(node.rel);
    if (live) return this.abs(live.rel);
    throw new Error("This item is no longer in your notes.");
  }

  /** A workspace's or project's own folder, never anything above it. */
  deleteEmpty(id: string): void {
    const node = this.layout(this.load()).byId.get(id);
    if (!node || (node.kind !== "workspace" && node.kind !== "project" && node.kind !== "folder")) throw new Error("Only an empty workspace, project or folder can be deleted.");
    if (node.kind === "workspace" && (node as NotesWorkspace).isDefault) throw new Error("The default workspace stays; rename it instead.");
    const entries = fs.readdirSync(this.abs(node.rel)).filter(n => !n.startsWith(".modex-") && n !== ".DS_Store");
    if (entries.length) throw new Error("Move or trash what is inside first.");
    fs.rmSync(this.abs(node.rel), { recursive: true });
  }

  /** The nodes in the folder, and each by id. Ids for folders and files without one are recorded as they are found. */
  private layout(state: State): { nodes: NotesNode[]; byId: Map<string, NotesNode>; truncated: boolean } {
    const index = state.index;
    const containers = { ...index.containers };
    const files = { ...index.files };
    let changed = false;
    const nodes: NotesNode[] = [];
    const dirIds = new Map<string, string>();
    const noteRels = new Map<string, string>();
    for (const [id, file] of state.live) noteRels.set(file.rel, id);
    const folderNotes = new Map<string, string>();
    for (const [id, file] of state.live) if (this.isFolderNote(file.rel)) folderNotes.set(path.posix.dirname(file.rel), id);
    const seen = new Set<string>();
    let truncated = false;
    const claim = (map: Record<string, Placed>, rel: string, ino: number): string => {
      const known = Object.entries(map).find(([, p]) => p.rel === rel)?.[0]
        ?? Object.entries(map).find(([oid, p]) => p.ino === ino && !seen.has(oid) && !fs.existsSync(this.abs(p.rel)))?.[0];
      const id = known ?? randomUUID();
      if (!known || map[id]!.rel !== rel || map[id]!.ino !== ino) { map[id] = { ...map[id], rel, ino }; changed = true; }
      seen.add(id);
      return id;
    };
    const walk = (dirRel: string, level: number, parentId: string | null) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dirRel ? this.abs(dirRel) : this.root, { withFileTypes: true }); } catch { return; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (nodes.length >= 10_000) { truncated = true; return; }
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          const ino = fs.statSync(this.abs(rel)).ino;
          const kind: NotesNodeKind = level === 0 ? "workspace" : level === 1 ? "project" : "folder";
          if (kind === "workspace" || kind === "project") {
            const marker = this.readMarker(rel, kind);
            const id = marker?.id ?? claim(containers, rel, ino);
            const order = marker?.order ?? Number.MAX_SAFE_INTEGER;
            const name = marker?.title || entry.name;
            nodes.push(kind === "workspace"
              ? { id, kind, parentId: null, name, rel, order, isDefault: Boolean(marker?.default) }
              : { id, kind, parentId: parentId!, name, rel, order, isDefault: Boolean(marker?.default), modexProjectId: marker?.modexProjectId ?? null });
            dirIds.set(rel, id);
            walk(rel, level + 1, id);
          } else {
            const id = claim(containers, rel, ino);
            const noteId = folderNotes.get(rel) ?? null;
            const page = noteId ? state.pages.get(noteId) : undefined;
            const typed = containers[id]?.title;
            // A typed name stands while the folder still has the name made from it; a rename in Finder wins.
            const name = page?.title.trim() || (typed && noteStem(typed) === entry.name ? typed : entry.name);
            nodes.push({ id, kind: "folder", parentId: parentId!, name, rel, noteId });
            dirIds.set(rel, id);
            walk(rel, level + 1, id);
          }
          continue;
        }
        if (!entry.isFile()) continue;
        const noteId = noteRels.get(rel);
        if (noteId) {
          if (folderNotes.get(dirRel) === noteId) continue;
          nodes.push({ id: noteId, kind: "note", parentId, name: state.pages.get(noteId)?.title.trim() || stemOf(rel), rel });
          continue;
        }
        const stat = fs.statSync(this.abs(rel));
        const id = claim(files, rel, stat.ino);
        const ext = path.posix.extname(entry.name).toLowerCase();
        const preview = /^\.(png|jpe?g|gif|webp|svg|avif)$/.test(ext) ? "image" : /^\.(txt|md|json|csv|ya?ml|log|ts|js|tsx|jsx|css|html)$/.test(ext) && stat.size <= 1_048_576 ? "text" : null;
        nodes.push({ id, kind: "file", parentId, name: entry.name, rel, size: stat.size, preview } satisfies NotesFile);
      }
    };
    walk("", 0, null);
    // Ids for folders and files that are gone stay out of the index.
    for (const id of Object.keys(containers)) if (!seen.has(id)) { delete containers[id]; changed = true; }
    for (const id of Object.keys(files)) if (!seen.has(id)) { delete files[id]; changed = true; }
    if (changed) { index.containers = containers; index.files = files; this.writeIndex(index); }
    // Siblings in order: workspaces and projects by their saved order, then name; the rest as the folder lists them.
    const groups = new Map<string | null, NotesNode[]>();
    for (const node of nodes) groups.set(node.parentId, [...(groups.get(node.parentId) ?? []), node]);
    const ordered = [...groups.values()].flatMap(group => {
      const ranked = group.filter((n): n is NotesWorkspace | NotesProject => n.kind === "workspace" || n.kind === "project").sort((a, b) => (a.order - b.order) || a.name.localeCompare(b.name));
      return [...ranked, ...group.filter(n => n.kind !== "workspace" && n.kind !== "project")];
    });
    return { nodes: ordered, byId: new Map(ordered.map(n => [n.id, n])), truncated };
  }

  /** A folder name for a workspace, project or folder title. */
  private containerName(name: string): string {
    if (typeof name !== "string" || !name.trim() || name.length > 200) throw new Error("A name needs 1 to 200 characters.");
    return noteStem(name);
  }

  private readMarker(dirRel: string, kind: "workspace" | "project"): Marker | null {
    try {
      const marker = JSON.parse(fs.readFileSync(this.abs(`${dirRel}/.modex-${kind}.json`), "utf8")) as Marker;
      return marker?.version === 1 && typeof marker.id === "string" && ID.test(marker.id) ? marker : null;
    } catch { return null; }
  }

  private writeMarker(dirRel: string, kind: "workspace" | "project", marker: Marker): void {
    writeFileDurably(this.abs(`${dirRel}/.modex-${kind}.json`), JSON.stringify(marker));
  }

  /** Records where a moved or renamed folder or file now is. */
  private place(index: NotesIndex, node: NotesNode, rel: string): void {
    if (node.kind === "file") index.files = { ...index.files, [node.id]: { rel, ino: fs.statSync(this.abs(rel)).ino } };
    else if (node.kind === "folder" || !this.readMarker(rel, node.kind as "workspace" | "project")) index.containers = { ...index.containers, [node.id]: { ...index.containers?.[node.id], rel, ino: fs.statSync(this.abs(rel)).ino } };
    // Notes inside a moved folder are found by their ids on the next read.
    for (const [id, entry] of Object.entries(index.notes)) if (entry.rel?.startsWith(`${node.rel}/`)) index.notes[id] = { ...entry, rel: `${rel}${entry.rel.slice(node.rel.length)}` };
  }

  // ── Reading and reconciling ──────────────────────────────────────────────────────────────

  private load(): State {
    this.open();
    let state = this.refresh();
    // Completing a move a crash interrupted changes the tree; read it once more.
    if (state === null) state = this.refresh();
    if (state === null) throw preserved(new Error("Notes kept changing while Modex read them."));
    return state;
  }

  /** The current pages, after recording what changed on disk. Null when it moved files and must read again. */
  private refresh(): State | null {
    const index = this.readIndex();
    const manifests = this.readManifests();
    const scanned = this.scan();
    const live = this.identify(scanned, index);
    const ids = new Set([...live.keys(), ...Object.keys(index.notes)]);
    const histories = new Map<string, SpacePageVersion[] | null>();
    for (const id of ids) histories.set(id, this.readHistory(id));

    // Finish trash moves and restores a crash interrupted.
    let moved = false;
    for (const [id, file] of live) {
      const latest = histories.get(id)?.at(-1)?.page;
      const entry = index.notes[id];
      if (latest?.trashedAt && entry && !entry.trash && entry.hash === file.hash) {
        const item = manifests.flatMap(m => m.items.map(i => ({ batch: m.id, ...i }))).find(i => i.id === id && i.original === file.rel);
        const batch = item?.batch ?? randomUUID();
        if (!item) this.writeJson(this.manifestFile(batch), { version: 1, id: batch, trashedAt: latest.trashedAt, items: [{ id, original: file.rel, rel: file.rel }] } satisfies TrashManifest);
        moveNoClobber(this.abs(file.rel), this.trashAbs(batch, file.rel));
        index.notes[id] = { rel: null, hash: file.hash, trash: { batch, rel: file.rel, original: file.rel } };
        moved = true;
      }
    }
    for (const [id, entry] of Object.entries(index.notes)) {
      const latest = histories.get(id)?.at(-1)?.page;
      if (entry.trash?.batch && latest && latest.trashedAt === null && !live.has(id) && fs.existsSync(this.trashAbs(entry.trash.batch, entry.trash.rel))) {
        const original = entry.trash.original;
        const dir = path.posix.dirname(original);
        const target = `${dir}/${uniqueName(stemOf(original), ".md", this.names(dir))}`;
        moveNoClobber(this.trashAbs(entry.trash.batch, entry.trash.rel), this.abs(target));
        this.dropFromManifest(entry.trash.batch, id);
        index.notes[id] = { rel: target, hash: entry.hash };
        moved = true;
      }
    }
    if (moved) { this.writeIndex(index); return null; }

    const pages = new Map<string, SpacePage>();
    let indexChanged = false;
    const folderNotes = new Map<string, string>();
    for (const [id, file] of live) if (this.isFolderNote(file.rel)) folderNotes.set(nameKey(path.posix.dirname(file.rel)), id);
    const parentOf = (rel: string): string | null => {
      let dir = path.posix.dirname(rel);
      if (this.isFolderNote(rel)) dir = path.posix.dirname(dir);
      return depth(dir) >= 3 ? folderNotes.get(nameKey(dir)) ?? null : null;
    };
    const now = this.now();

    for (const [id, file] of live) {
      this.missing.delete(id);
      const versions = histories.get(id) ?? null;
      const title = file.parsed.title ?? stemOf(file.rel);
      const body = file.parsed.body;
      const parentId = parentOf(file.rel);
      const entry = index.notes[id];
      const confirm = () => {
        if (entry?.rel !== file.rel || entry.hash !== file.hash || entry.ino !== file.ino || entry.trash) { index.notes[id] = { rel: file.rel, hash: file.hash, ino: file.ino }; indexChanged = true; }
      };
      if (!versions) {
        const at = new Date(file.mtimeMs).toISOString();
        const page: SpacePage = { id, parentId, title, markdown: body, favorite: false, createdAt: at, updatedAt: at, trashedAt: null, revision: 1 };
        try { validate(page); } catch { continue; }
        this.writeHistory(id, [{ page, actor: "external", summary: "Found in notes folder" }]);
        pages.set(id, page);
        confirm();
        continue;
      }
      const latest = versions.at(-1)!.page;
      if (latest.title === title && latest.markdown === body && latest.parentId === parentId && latest.trashedAt === null) {
        pages.set(id, latest);
        confirm();
        continue;
      }
      if (latest.trashedAt === null && entry && !entry.trash && entry.hash === file.hash && entry.rel === file.rel) {
        // The file is as Modex last confirmed it and the history is ahead: a crash fell between the two writes.
        pages.set(id, latest);
        if (latest.parentId === parentId) {
          const text = formatNote({ id, title: latest.title, stem: stemOf(file.rel), body: latest.markdown }, this.readText(file.rel));
          writeFileDurably(this.abs(file.rel), text);
          index.notes[id] = { rel: file.rel, hash: sha256(text), ino: fs.statSync(this.abs(file.rel)).ino };
          indexChanged = true;
          continue;
        }
      }
      const candidate: SpacePage = { ...latest, title, markdown: body, parentId, trashedAt: null, updatedAt: new Date(now).toISOString(), revision: latest.revision + 1 };
      try { validate(candidate); } catch { pages.set(id, latest); continue; }
      const summary = latest.trashedAt !== null ? "Restored outside Modex" : latest.title !== title || latest.markdown !== body ? "Edited outside Modex" : "Moved outside Modex";
      this.writeHistory(id, this.appendVersion(versions, { page: candidate, actor: "external", summary }, "external"));
      pages.set(id, candidate);
      confirm();
    }

    for (const [id, entry] of Object.entries(index.notes)) {
      if (live.has(id)) continue;
      const versions = histories.get(id);
      const latest = versions?.at(-1)?.page;
      if (!versions || !latest) continue;
      if (latest.trashedAt !== null) {
        if (entry.rel && !entry.trash) {
          const item = manifests.flatMap(m => m.items.map(i => ({ batch: m.id, ...i }))).find(i => i.id === id);
          index.notes[id] = item ? { rel: null, hash: entry.hash, trash: { batch: item.batch, rel: item.rel, original: item.original } } : { rel: null, hash: null };
          indexChanged = true;
        }
        pages.set(id, latest);
        continue;
      }
      // Live in history, absent on disk: wait one more look before calling it deleted (git checkout, a save that renames).
      const first = this.missing.get(id);
      if (first === undefined || now - first < MISSING_MS) {
        if (first === undefined) this.missing.set(id, now);
        pages.set(id, latest);
        continue;
      }
      this.missing.delete(id);
      const at = new Date(now).toISOString();
      const gone: SpacePage = { ...latest, trashedAt: at, updatedAt: at, revision: latest.revision + 1 };
      this.writeHistory(id, [...versions, { page: gone, actor: "external", summary: "Deleted outside Modex" }]);
      index.notes[id] = { rel: null, hash: null, ...(entry.rel ? { original: entry.rel } : {}) };
      indexChanged = true;
      pages.set(id, gone);
    }
    if (indexChanged) this.writeIndex(index);
    return { pages, index, live };
  }

  /** Every Markdown note under the root, skipping dot entries (`.modex`, `.ok`, `.git`), links, and files too large or not UTF-8. */
  private scan(): LiveNote[] {
    const out: LiveNote[] = [];
    const seen = new Set<string>();
    const walk = (dirRel: string, level: number) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dirRel ? this.abs(dirRel) : this.root, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const rel = dirRel ? `${dirRel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { if (level < MAX_DEPTH) walk(rel, level + 1); continue; }
        if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
        const note = this.readLive(rel);
        if (note) { out.push(note); seen.add(rel); }
      }
    };
    walk("", 0);
    for (const rel of this.fileCache.keys()) if (!seen.has(rel)) this.fileCache.delete(rel);
    return out;
  }

  private readLive(rel: string): LiveNote | null {
    let stat: fs.Stats;
    try { stat = fs.lstatSync(this.abs(rel)); } catch { return null; }
    if (!stat.isFile() || stat.size > MAX_NOTE_BYTES) return null;
    const cached = this.fileCache.get(rel);
    if (cached && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
    let bytes: Buffer;
    let text: string;
    try { bytes = fs.readFileSync(this.abs(rel)); text = utf8.decode(bytes); } catch { return null; }
    const note: LiveNote = { rel, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(bytes), parsed: parseNote(text) };
    this.fileCache.set(rel, note);
    return note;
  }

  /**
   * Which page each file is: its `modex_id`, else the index entry for its path, else the entry for its
   * inode (a file moved in Finder), else a new id. A copy that duplicates an id gets a new one; the file
   * at the indexed path keeps it.
   */
  private identify(files: LiveNote[], index: NotesIndex): Map<string, LiveNote> {
    const live = new Map<string, LiveNote>();
    const later: LiveNote[] = [];
    for (const file of files) {
      const id = file.parsed.id;
      if (!id || !ID.test(id)) { later.push(file); continue; }
      const prior = live.get(id);
      if (!prior) live.set(id, file);
      else if (index.notes[id]?.rel === file.rel) { later.push(prior); live.set(id, file); }
      else later.push(file);
    }
    const rels = new Set(files.map(file => file.rel));
    for (const file of later) {
      const entries = Object.entries(index.notes).filter(([id]) => !live.has(id));
      const id = entries.find(([, e]) => e.rel === file.rel)?.[0]
        ?? entries.find(([, e]) => e.ino === file.ino && e.rel !== null && !rels.has(e.rel))?.[0]
        ?? randomUUID();
      live.set(id, file);
    }
    return live;
  }

  // ── Opening, layout and migration ────────────────────────────────────────────────────────

  private open(): void {
    if (this.opened) return;
    let stat: fs.Stats | null = null;
    try { stat = fs.lstatSync(this.root); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw preserved(error); }
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) throw preserved(new Error("The notes folder must be a real folder, not a link or a file."));
    const receipt = stat ? this.readReceipt() : null;
    if (!receipt) this.migrate(stat !== null);
    this.opened = true;
    if (receipt) this.importChangesSince(receipt);
    for (const project of this.options.projects?.() ?? []) {
      try { this.linkProject(project); } catch (error) { console.error("[modex] notes for project", project.name, "unavailable:", error); }
    }
  }

  private readReceipt(): MigrationReceipt | null {
    try { return JSON.parse(fs.readFileSync(path.join(this.meta, "migration.json"), "utf8")) as MigrationReceipt; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw preserved(error);
    }
  }

  /**
   * Sets up the folder, with this home's `space.json` pages in Personal › Notes. A new folder is built
   * beside the root and published with one rename, so a crash leaves either nothing or all of it.
   * `space.json` is never written; a copy is kept beside it.
   */
  private migrate(rootExists: boolean): void {
    const legacy = this.options.legacySpaceFile;
    let doc: SpaceDocument = { version: 2, pages: [], history: [] };
    let digest: string | null = null;
    if (legacy && fs.existsSync(legacy)) {
      doc = readSpaceDocument(legacy);
      const bytes = fs.readFileSync(legacy);
      digest = sha256(bytes);
      try { fs.copyFileSync(legacy, `${legacy}.pre-notes-${digest.slice(0, 8)}.bak`, fs.constants.COPYFILE_EXCL); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const parent = path.dirname(this.root);
    for (const name of fs.existsSync(parent) ? fs.readdirSync(parent) : []) {
      if (name.startsWith(`${path.basename(this.root)}.migrating-`)) fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    }
    if (!rootExists) {
      const staging = `${this.root}.migrating-${randomUUID()}`;
      this.build(staging, doc, digest, () => []);
      fs.renameSync(staging, this.root);
      fsyncDir(parent);
      return;
    }
    // A folder that exists without a receipt (made by hand, or by a crashed setup): add the pages next to what is there.
    const existing = new Set(this.scan().map(file => file.parsed.id).filter((id): id is string => Boolean(id)));
    this.build(this.root, { ...doc, pages: doc.pages.filter(page => !existing.has(page.id)) }, digest, dir => this.names(dir));
  }

  private build(target: string, doc: SpaceDocument, digest: string | null, taken: (dirRel: string) => string[]): void {
    const at = (rel: string) => path.join(target, ...rel.split("/"));
    const meta = path.join(target, ".modex");
    for (const dir of ["history", "comments", "trash"]) fs.mkdirSync(path.join(meta, dir), { recursive: true, mode: 0o700 });
    const projectRel = `${DEFAULT_WORKSPACE}/${DEFAULT_PROJECT}`;
    fs.mkdirSync(at(projectRel), { recursive: true });
    const workspaceMarker = at(`${DEFAULT_WORKSPACE}/.modex-workspace.json`);
    if (!fs.existsSync(workspaceMarker)) writeFileDurably(workspaceMarker, JSON.stringify({ version: 1, id: randomUUID(), title: DEFAULT_WORKSPACE, order: 0, default: true }));
    const projectMarker = at(`${projectRel}/.modex-project.json`);
    if (!fs.existsSync(projectMarker)) writeFileDurably(projectMarker, JSON.stringify({ version: 1, id: randomUUID(), title: DEFAULT_PROJECT, order: 0, modexProjectId: null, default: true }));
    const plan = planMigration(doc.pages, projectRel, taken);
    const pages = new Map(doc.pages.map(page => [page.id, page]));
    let index: NotesIndex = { version: 1, defaultProject: projectRel, notes: {} };
    try { index = { ...index, ...JSON.parse(fs.readFileSync(path.join(meta, "index.json"), "utf8")) as NotesIndex }; } catch { /* A new folder starts empty. */ }
    const trashed = plan.notes.filter(note => note.trashed);
    const batch = "migrated";
    for (const note of plan.notes) {
      const page = pages.get(note.id)!;
      writeFileDurably(path.join(meta, "history", `${note.id}.json`), JSON.stringify({ version: 1, versions: doc.history.filter(v => v.page.id === note.id) } satisfies HistoryFile));
      const comments = (doc.comments ?? []).filter(c => c.pageId === note.id);
      if (comments.length) writeFileDurably(path.join(meta, "comments", `${note.id}.json`), JSON.stringify(comments));
      const file = note.trashed ? path.join(meta, "trash", batch, ...note.rel.split("/")) : at(note.rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = formatNote({ id: note.id, title: page.title, stem: stemOf(note.rel), body: page.markdown });
      writeFileDurably(file, text);
      const updated = new Date(page.updatedAt);
      if (Number.isFinite(updated.getTime())) fs.utimesSync(file, updated, updated);
      index.notes[note.id] = note.trashed
        ? { rel: null, hash: sha256(text), trash: { batch, rel: note.rel, original: note.rel } }
        : { rel: note.rel, hash: sha256(text), ino: fs.statSync(file).ino };
    }
    if (trashed.length) {
      writeFileDurably(path.join(meta, "trash", `${batch}.json`), JSON.stringify({ version: 1, id: batch, trashedAt: new Date(this.now()).toISOString(), items: trashed.map(note => ({ id: note.id, original: note.rel, rel: note.rel })) } satisfies TrashManifest));
    }
    writeFileDurably(path.join(meta, "index.json"), JSON.stringify(index));
    const receipt: MigrationReceipt = {
      version: 1, source: digest ? "app/space.json" : null, sha256: digest, migratedAt: new Date(this.now()).toISOString(),
      revisions: Object.fromEntries(doc.pages.map(page => [page.id, page.revision])), mapping: Object.fromEntries(plan.notes.map(note => [note.id, note.rel])), warnings: plan.warnings,
    };
    writeFileDurably(path.join(meta, "migration.json"), JSON.stringify(receipt));
  }

  /**
   * An older Modex reads and writes `space.json`, which migration left as it was. Pages it created or
   * changed since are brought in as new notes under "Recovered from earlier Modex", never over newer ones.
   */
  private importChangesSince(receipt: MigrationReceipt): void {
    const legacy = this.options.legacySpaceFile;
    if (!legacy || !receipt.sha256 || !fs.existsSync(legacy)) return;
    const digest = sha256(fs.readFileSync(legacy));
    if (digest === receipt.sha256) return;
    const doc = readSpaceDocument(legacy);
    const changed = doc.pages.filter(page => page.trashedAt === null && (receipt.revisions[page.id] === undefined || page.revision > receipt.revisions[page.id]!));
    if (changed.length) {
      const day = new Date(this.now()).toISOString().slice(0, 10);
      const folder = this.create({ title: `Recovered from earlier Modex ${day}` }, { actor: "unknown", summary: "Recovered from an earlier Modex" });
      for (const page of changed) this.create({ title: page.title, markdown: page.markdown, parentId: folder.id }, { actor: "unknown", summary: "Recovered from an earlier Modex" });
    }
    writeFileDurably(path.join(this.meta, "migration.json"), JSON.stringify({ ...receipt, sha256: digest, revisions: { ...receipt.revisions, ...Object.fromEntries(doc.pages.map(page => [page.id, page.revision])) } } satisfies MigrationReceipt));
  }

  // ── Placement ────────────────────────────────────────────────────────────────────────────

  /** The folder a child of `parentId` lives in, turning a leaf parent into a folder note first. */
  private dirFor(state: State, parentId: string | null, project: string): string {
    if (parentId === null) return project;
    const parent = state.live.get(parentId);
    if (!parent) throw new Error("Choose an existing page as the parent.");
    if (this.isFolderNote(parent.rel)) return path.posix.dirname(parent.rel);
    const dir = path.posix.dirname(parent.rel);
    const name = uniqueName(stemOf(parent.rel), "", this.names(dir).filter(n => n !== path.posix.basename(parent.rel)));
    fs.mkdirSync(this.abs(`${dir}/${name}`));
    this.renameNote(state, state.pages.get(parentId)!, parent.rel, `${dir}/${name}/${name}.md`);
    return `${dir}/${name}`;
  }

  /** Moves a page under `parentId` (its whole folder, for a folder note) and returns the note file's new path. */
  private move(state: State, id: string, parentId: string | null): string {
    const live = state.live.get(id);
    if (!live) throw new Error("This Space page no longer exists.");
    const project = live.rel.split("/").slice(0, 2).join("/");
    const target = this.dirFor(state, parentId, depth(project) === 2 ? project : state.index.defaultProject);
    const current = state.live.get(id)!;
    if (this.isFolderNote(current.rel)) {
      const dir = path.posix.dirname(current.rel);
      const name = uniqueName(path.posix.basename(dir), "", this.names(target));
      const moved = `${target}/${name}`;
      moveNoClobber(this.abs(dir), this.abs(moved));
      this.rebase(state, dir, moved);
      const rel = `${moved}/${path.posix.basename(current.rel)}`;
      if (name !== path.posix.basename(dir)) { this.renameNote(state, state.pages.get(id)!, rel, `${moved}/${name}.md`); return `${moved}/${name}.md`; }
      return rel;
    }
    const rel = `${target}/${uniqueName(stemOf(current.rel), ".md", this.names(target))}`;
    this.renameNote(state, state.pages.get(id)!, current.rel, rel);
    return rel;
  }

  /** Puts a restored page's file back where it was, or rewrites it from history if it is gone. */
  private restoreFile(state: State, page: SpacePage): void {
    const entry = state.index.notes[page.id];
    const original = entry?.trash?.original || entry?.original || entry?.rel || `${state.index.defaultProject}/${noteStem(page.title)}.md`;
    let dir = path.posix.dirname(original);
    // The parent folder may have been restored under another name, or not at all.
    if (page.parentId !== null) {
      const parent = state.live.get(page.parentId);
      if (parent) dir = this.isFolderNote(parent.rel) ? path.posix.dirname(parent.rel) : this.dirFor(state, page.parentId, state.index.defaultProject);
      if (this.isFolderNote(original) && parent) dir = `${dir}/${path.posix.basename(path.posix.dirname(original))}`;
    }
    fs.mkdirSync(this.abs(dir), { recursive: true });
    const target = `${dir}/${uniqueName(stemOf(original), ".md", this.names(dir))}`;
    const source = entry?.trash?.batch ? this.trashAbs(entry.trash.batch, entry.trash.rel) : null;
    if (source && fs.existsSync(source)) {
      moveNoClobber(source, this.abs(target));
      this.dropFromManifest(entry!.trash!.batch, page.id);
      const text = this.readText(target);
      state.live.set(page.id, { rel: target, ino: fs.statSync(this.abs(target)).ino, size: 0, mtimeMs: 0, hash: sha256(text), parsed: parseNote(text) });
      state.index.notes[page.id] = { rel: target, hash: sha256(text), ino: fs.statSync(this.abs(target)).ino };
    } else {
      this.writeNoteAt(state, page, target);
    }
  }

  /** Rewrites a page's file at `to` (frontmatter title follows the new name) and removes `from`. */
  private renameNote(state: State, page: SpacePage, from: string, to: string): void {
    const previous = this.readText(from);
    const text = formatNote({ id: page.id, title: page.title, stem: stemOf(to), body: page.markdown }, previous);
    if (nameKey(from) === nameKey(to)) {
      // A case-only rename: rename first, so a case-sensitive file system cannot keep both.
      if (from !== to) fs.renameSync(this.abs(from), this.abs(to));
      writeFileDurably(this.abs(to), text);
    } else {
      this.createNote(to, text);
      fs.unlinkSync(this.abs(from));
      fsyncDir(path.dirname(this.abs(from)));
    }
    const ino = fs.statSync(this.abs(to)).ino;
    state.live.set(page.id, { rel: to, ino, size: 0, mtimeMs: 0, hash: sha256(text), parsed: parseNote(text) });
    state.index.notes[page.id] = { rel: to, hash: sha256(text), ino };
  }

  /** After a folder moved from `from` to `to`, every note inside it is at a new path. */
  private rebase(state: State, from: string, to: string): void {
    for (const [id, file] of state.live) {
      if (!file.rel.startsWith(`${from}/`)) continue;
      const rel = `${to}${file.rel.slice(from.length)}`;
      state.live.set(id, { ...file, rel });
      const entry = state.index.notes[id];
      if (entry) state.index.notes[id] = { ...entry, rel };
    }
  }

  private writeNoteAt(state: State, page: SpacePage, rel: string): void {
    const exists = fs.existsSync(this.abs(rel));
    const text = formatNote({ id: page.id, title: page.title, stem: stemOf(rel), body: page.markdown }, exists ? this.readText(rel) : undefined);
    if (exists) writeFileDurably(this.abs(rel), text);
    else this.createNote(rel, text);
    const ino = fs.statSync(this.abs(rel)).ino;
    state.live.set(page.id, { rel, ino, size: 0, mtimeMs: 0, hash: sha256(text), parsed: parseNote(text) });
    state.index.notes[page.id] = { rel, hash: sha256(text), ino };
  }

  /** A new note file, never replacing one: written beside its target, then linked into place. */
  private createNote(rel: string, text: string): void {
    const file = this.abs(rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    writeFileDurably(temporary, text);
    try { moveNoClobber(temporary, file); } finally { fs.rmSync(temporary, { force: true }); }
  }

  private isFolderNote(rel: string): boolean {
    const dir = path.posix.dirname(rel);
    return depth(dir) >= 3 && nameKey(path.posix.basename(dir)) === nameKey(stemOf(rel));
  }

  /** Names in a folder, dot entries excluded; empty when it does not exist. */
  private names(dirRel: string): string[] {
    try { return fs.readdirSync(this.abs(dirRel)).filter(name => !name.startsWith(".")); } catch { return []; }
  }

  private removeEmptyDirs(dirRel: string): void {
    // Never the workspace or the project itself.
    while (depth(dirRel) >= 3) {
      try { fs.rmdirSync(this.abs(dirRel)); } catch { return; }
      dirRel = path.posix.dirname(dirRel);
    }
  }

  // ── Metadata files ───────────────────────────────────────────────────────────────────────

  private abs(rel: string): string { return path.join(this.root, ...rel.split("/")); }
  private historyFile(id: string): string { return path.join(this.meta, "history", `${id}.json`); }
  private commentsFile(id: string): string { return path.join(this.meta, "comments", `${id}.json`); }
  private manifestFile(batch: string): string { return path.join(this.meta, "trash", `${batch}.json`); }
  private trashAbs(batch: string, rel: string): string { return path.join(this.meta, "trash", batch, ...rel.split("/")); }
  private readText(rel: string): string { return fs.readFileSync(this.abs(rel), "utf8"); }

  private readIndex(): NotesIndex {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(this.meta, "index.json"), "utf8")) as NotesIndex;
      if (data?.version !== 1 || typeof data.defaultProject !== "string" || !data.notes || typeof data.notes !== "object") throw new Error("Invalid notes index.");
      for (const [id, entry] of Object.entries(data.notes)) {
        if (!ID.test(id) || !entry || (entry.rel !== null && typeof entry.rel !== "string") || (entry.hash !== null && typeof entry.hash !== "string")) throw new Error("Invalid notes index entry.");
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, defaultProject: `${DEFAULT_WORKSPACE}/${DEFAULT_PROJECT}`, notes: {} };
      throw preserved(error);
    }
  }

  private writeIndex(index: NotesIndex): void { this.writeJson(path.join(this.meta, "index.json"), index); }

  private readManifests(): TrashManifest[] {
    const dir = path.join(this.meta, "trash");
    let names: string[];
    try { names = fs.readdirSync(dir).filter(name => name.endsWith(".json")); } catch { return []; }
    return names.map(name => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as TrashManifest; } catch (error) { throw preserved(error); }
    });
  }

  private dropFromManifest(batch: string, id: string): void {
    if (!batch) return;
    const file = this.manifestFile(batch);
    let manifest: TrashManifest;
    try { manifest = JSON.parse(fs.readFileSync(file, "utf8")) as TrashManifest; } catch { return; }
    const items = manifest.items.filter(item => item.id !== id);
    if (items.length) { this.writeJson(file, { ...manifest, items }); return; }
    fs.rmSync(file, { force: true });
    fs.rmSync(path.join(this.meta, "trash", batch), { recursive: true, force: true });
  }

  private readHistory(id: string): SpacePageVersion[] | null {
    const file = this.historyFile(id);
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw preserved(error);
    }
    const key = `${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const cached = this.historyCache.get(id);
    if (cached?.key === key) return cached.versions;
    let data: HistoryFile;
    try { data = JSON.parse(fs.readFileSync(file, "utf8")) as HistoryFile; validateHistory(id, data); } catch (error) { throw preserved(error); }
    this.historyCache.set(id, { key, versions: data.versions });
    return data.versions;
  }

  private writeHistory(id: string, versions: SpacePageVersion[]): void {
    const data: HistoryFile = { version: 1, versions };
    validateHistory(id, data);
    this.writeJson(this.historyFile(id), data);
    this.historyCache.delete(id);
  }

  private readComments(pageId: string): SpaceComment[] {
    let data: unknown;
    try { data = JSON.parse(fs.readFileSync(this.commentsFile(pageId), "utf8")); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw preserved(error);
    }
    if (!Array.isArray(data)) throw preserved(new Error("Invalid saved comments."));
    for (const comment of data as SpaceComment[]) {
      try { validateComment(comment); } catch (error) { throw preserved(error); }
      if (comment.pageId !== pageId) throw preserved(new Error("Invalid saved comment reference."));
    }
    return data as SpaceComment[];
  }

  private writeJson(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileDurably(file, JSON.stringify(value));
  }

  // ── Rules shared with SpaceStore ─────────────────────────────────────────────────────────

  private iso(): string { return new Date(this.now()).toISOString(); }

  private liveRel(state: State, id: string): string {
    const live = state.live.get(id);
    if (live) return live.rel;
    // Deleted outside Modex while open in Space: saving writes it back where it was.
    const entry = state.index.notes[id];
    return entry?.trash?.original || entry?.original || `${state.index.defaultProject}/${noteStem(state.pages.get(id)?.title ?? "")}.md`;
  }

  private find(state: State, id: string): SpacePage {
    const page = state.pages.get(id);
    if (!page) throw new Error("This Space page no longer exists.");
    return page;
  }

  private checkRevision(page: SpacePage, revision: number): void {
    if (page.revision !== revision) throw new Error("This page changed in another window. Copy your edits, then reopen Space to load the saved version.");
  }

  private attribution(change: SpaceChangeContext | undefined, summary: string): SpaceChangeContext {
    const attribution = change ?? { actor: "human", summary };
    validateChange(attribution);
    return { actor: attribution.actor, summary: attribution.summary };
  }

  private version(page: SpacePage, change: SpaceChangeContext | undefined, summary: string): SpacePageVersion {
    return { page, ...this.attribution(change, summary) };
  }

  /**
   * Adds `version`. Autosave runs on every keystroke, and Open Knowledge autosaves as it types: for
   * those (`coalesce`), a version within 30 s of the same kind replaces the last instead of piling up,
   * keeping the start of the burst. Explicit changes always stay.
   */
  private appendVersion(versions: SpacePageVersion[], version: SpacePageVersion, coalesce: "human" | "external" | null): SpacePageVersion[] {
    if (!coalesce) return [...versions, version];
    version.checkpointAt = version.page.updatedAt;
    const latest = versions.at(-1);
    const elapsed = Date.parse(version.page.updatedAt) - Date.parse(latest?.checkpointAt ?? "");
    if (latest?.actor === coalesce && latest.checkpointAt && elapsed >= 0 && elapsed < CHECKPOINT_MS && versions.length > 1) {
      version.checkpointAt = latest.checkpointAt;
      return [...versions.slice(0, -1), version];
    }
    return [...versions, version];
  }

  private validateParent(page: SpacePage, pages: Map<string, SpacePage>): void {
    let id = page.parentId;
    const visited = new Set([page.id]);
    while (id) {
      if (visited.has(id)) throw new Error("A page cannot be placed inside itself.");
      visited.add(id);
      const parent = pages.get(id);
      if (!parent || parent.trashedAt) throw new Error("Choose an existing page as the parent.");
      id = parent.parentId;
    }
  }
}

function validateHistory(id: string, data: HistoryFile): void {
  if (!data || data.version !== 1 || !Array.isArray(data.versions) || data.versions.length === 0) throw new Error("Invalid Space version history.");
  let previous: SpacePage | undefined;
  for (const version of data.versions) {
    validateChange(version);
    validate(version.page);
    if (version.page.id !== id) throw new Error("Invalid Space version sequence.");
    if (version.checkpointAt !== undefined && ((version.actor !== "human" && version.actor !== "external") || typeof version.checkpointAt !== "string" || !Number.isFinite(Date.parse(version.checkpointAt)))) throw new Error("Invalid Space typing checkpoint.");
    if (previous && (version.page.revision <= previous.revision || version.page.createdAt !== previous.createdAt)) throw new Error("Invalid Space version sequence.");
    previous = version.page;
  }
}
