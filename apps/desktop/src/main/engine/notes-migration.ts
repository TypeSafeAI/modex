import type { SpacePage } from "../../shared/space.js";
import { noteStem, uniqueName } from "../../shared/notes-names.js";

/** Where one page of `space.json` goes. `rel` is the note file, relative to the notes root, with `/` separators. */
export interface PlannedNote { id: string; rel: string; folder: boolean; trashed: boolean }
export interface MigrationPlan { notes: PlannedNote[]; warnings: string[] }

/**
 * Lays out `pages` under `projectRel`. A page with any child, live or trashed, becomes a folder that
 * holds its own folder note (`Plan/Plan.md`); a leaf becomes `Name.md`. Names are made safe and unique
 * per folder, next to what `taken` reports already on disk. Parents come before their children.
 */
export function planMigration(pages: SpacePage[], projectRel: string, taken: (dirRel: string) => string[] = () => [], existing: ReadonlyMap<string, PlannedNote> = new Map()): MigrationPlan {
  const byId = new Map(pages.map(page => [page.id, page]));
  const children = new Map<string | null, SpacePage[]>();
  const warnings: string[] = [];
  for (const page of pages) {
    let parent = page.parentId;
    if (parent !== null && !byId.has(parent)) {
      warnings.push(`"${page.title || "Untitled page"}" pointed to a missing parent page and was placed at the top level.`);
      parent = null;
    }
    children.set(parent, [...(children.get(parent) ?? []), page]);
  }
  const used = new Map<string, string[]>();
  const claim = (dirRel: string, stem: string, ext: string): string => {
    const names = used.get(dirRel) ?? taken(dirRel);
    const name = uniqueName(stem, ext, names);
    used.set(dirRel, [...names, name]);
    return name;
  };
  const notes: PlannedNote[] = [];
  const visited = new Set<string>();
  const place = (parent: string | null, dirRel: string) => {
    for (const page of children.get(parent) ?? []) {
      if (visited.has(page.id)) continue;
      visited.add(page.id);
      const stem = noteStem(page.title);
      const folder = (children.get(page.id)?.length ?? 0) > 0;
      const published = existing.get(page.id);
      if (published) {
        if (folder && !published.folder) throw new Error("An existing parent note must be a folder note before migration can continue.");
        notes.push(published);
        place(page.id, published.rel.slice(0, published.rel.lastIndexOf("/")));
      } else if (folder) {
        const dir = claim(dirRel, stem, "");
        // Reserve the folder note before placing children with the same title.
        used.set(`${dirRel}/${dir}`, [...taken(`${dirRel}/${dir}`), `${dir}.md`]);
        notes.push({ id: page.id, rel: `${dirRel}/${dir}/${dir}.md`, folder: true, trashed: page.trashedAt !== null });
        place(page.id, `${dirRel}/${dir}`);
      } else {
        notes.push({ id: page.id, rel: `${dirRel}/${claim(dirRel, stem, ".md")}`, folder: false, trashed: page.trashedAt !== null });
      }
    }
  };
  place(null, projectRel);
  // A parent cycle cannot come from a valid document; place any remainder at the top level rather than lose it.
  for (const page of pages) {
    if (visited.has(page.id)) continue;
    warnings.push(`"${page.title || "Untitled page"}" was part of a parent loop and was placed at the top level.`);
    visited.add(page.id);
    notes.push({ id: page.id, rel: `${projectRel}/${claim(projectRel, noteStem(page.title), ".md")}`, folder: false, trashed: page.trashedAt !== null });
  }
  return { notes, warnings };
}
