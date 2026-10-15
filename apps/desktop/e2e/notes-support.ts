import fs from "node:fs";
import path from "node:path";
import type { SpaceComment } from "../src/shared/space";

export interface SavedNote { rel: string; id?: string; title: string; markdown: string }

/**
 * The notes Space saved under `home/notes` (docs/notes.md), read from disk without the app: each
 * Markdown file outside dot folders, with its frontmatter's `modex_id` and `title` and the body as
 * written. A note without a `title` key is titled by its file name.
 */
export function savedNotes(home: string): SavedNote[] {
  const root = path.join(home, "notes");
  const out: SavedNote[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.name.endsWith(".md")) continue;
      const text = fs.readFileSync(file, "utf8");
      const match = /^---\n([\s\S]*?)\n?---\n/.exec(text);
      const header = match?.[1] ?? "";
      const id = /^modex_id: (.+)$/m.exec(header)?.[1];
      const quoted = /^title: (.+)$/m.exec(header)?.[1];
      const title = quoted === undefined ? entry.name.replace(/\.md$/, "") : quoted.startsWith('"') ? JSON.parse(quoted) as string : quoted;
      out.push({ rel: path.relative(root, file).split(path.sep).join("/"), ...(id ? { id } : {}), title, markdown: match ? text.slice(match[0].length) : text });
    }
  };
  walk(root);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** A page's saved comments. */
export function savedComments(home: string, pageId: string): SpaceComment[] {
  try { return JSON.parse(fs.readFileSync(path.join(home, "notes", ".modex", "comments", `${pageId}.json`), "utf8")) as SpaceComment[]; } catch { return []; }
}

const history = (home: string) => path.join(home, "notes", ".modex", "history");
/** Makes the next save fail for real: its first step, writing the page's version history, is refused. Nothing changes on disk. */
export function blockNoteWrites(home: string): void { fs.chmodSync(history(home), 0o500); }
export function unblockNoteWrites(home: string): void { fs.chmodSync(history(home), 0o700); }
