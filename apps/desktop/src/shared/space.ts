/** Space documents are local to this Modex home. Markdown is the portable source of truth. */
export interface SpacePage {
  id: string;
  parentId: string | null;
  title: string;
  markdown: string;
  favorite: boolean;
  createdAt: string;
  updatedAt: string;
  trashedAt: string | null;
  revision: number;
}
export interface SpaceChangeContext { actor: string; summary: string; }
export interface SpacePageVersion extends SpaceChangeContext { page: SpacePage; /** Start of a coalesced human typing checkpoint. */ checkpointAt?: string; }

export type CreateSpacePage = { title?: string; parentId?: string | null; markdown?: string };

export function pageTitle(page: Pick<SpacePage, "title">): string { return page.title.trim() || "Untitled page"; }
