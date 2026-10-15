/**
 * The notes folder as a tree: Workspace › Project › Folder › notes and files (docs/notes.md).
 * Pages stay `SpacePage`s, addressed by id and revision; this describes where they and everything
 * else in the folder sit. Paths (`rel`) use `/` and are relative to the notes folder.
 */
export type NotesNodeKind = "workspace" | "project" | "folder" | "note" | "file";

interface NotesNodeBase {
  id: string;
  kind: NotesNodeKind;
  /** The workspace, project or folder this sits in; null for a workspace. */
  parentId: string | null;
  name: string;
  rel: string;
}
export interface NotesWorkspace extends NotesNodeBase { kind: "workspace"; parentId: null; order: number; isDefault: boolean }
export interface NotesProject extends NotesNodeBase { kind: "project"; order: number; isDefault: boolean; /** The Modex project whose notes these are, if any. */ modexProjectId: string | null }
/** A folder; `noteId` is its folder note (the page named like the folder), when it has one. */
export interface NotesFolder extends NotesNodeBase { kind: "folder"; noteId: string | null }
/** A page. Its title, text and revision come from `space:list`. */
export interface NotesNote extends NotesNodeBase { kind: "note" }
export interface NotesFile extends NotesNodeBase { kind: "file"; size: number; /** A preview the renderer can show without opening another app. */ preview: "image" | "text" | null }
export type NotesNode = NotesWorkspace | NotesProject | NotesFolder | NotesNote | NotesFile;

export interface NotesTree {
  /** Changes whenever anything in the folder does; `notes:tree { since }` answers `unchanged` while it holds. */
  version: string;
  nodes: NotesNode[];
  /** More than the listing limit: the folder holds more than is shown. */
  truncated: boolean;
}

/** Where things may go: workspaces at the top, projects in workspaces, everything else in a project or folder. */
export function canContain(container: NotesNodeKind | null, kind: NotesNodeKind): boolean {
  if (kind === "workspace") return container === null;
  if (kind === "project") return container === "workspace";
  return container === "project" || container === "folder";
}

/** Images from the notes folder: `modex-notes://file/<node id>` and `modex-notes://page/<page id>/<path>`. */
export const NOTES_SCHEME = "modex-notes";

const decodeSegment = (segment: string) => { try { return decodeURIComponent(segment); } catch { return segment; } };

/**
 * The URL for an image a page names by a path relative to its own file (`diagram.png`,
 * `assets/a%20b.png`), or null for anything else: a web or other URL, an absolute path, a fragment.
 */
export function pageImageUrl(pageId: string, url: string): string | null {
  const value = url.trim().replace(/^<(.*)>$/, "$1");
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || /^[/\\#?]/.test(value)) return null;
  const segments = value.split(/[?#]/)[0]!.split("/").map(decodeSegment);
  if (!segments.length || segments.some(segment => !segment || segment.includes("\\") || segment.includes("\0"))) return null;
  // One encoded segment, so the URL parser never folds a `..` away before main resolves it.
  return `${NOTES_SCHEME}://page/${encodeURIComponent(pageId)}/${encodeURIComponent(segments.join("/"))}`;
}

/** The page and relative path a page image URL names, or null. */
export function pageImageFromUrl(url: string): { pageId: string; relative: string } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== `${NOTES_SCHEME}:` || parsed.host !== "page") return null;
  const parts = parsed.pathname.slice(1).split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { pageId: decodeSegment(parts[0]), relative: decodeSegment(parts[1]) };
}
