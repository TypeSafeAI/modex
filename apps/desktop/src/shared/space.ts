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
/** Personal comments, stored with the local Space; no remote sharing is implied. */
export interface SpaceComment { id: string; pageId: string; text: string; quote: string; createdAt: string; }
export interface SpacePageVersion extends SpaceChangeContext { page: SpacePage; /** Start of a coalesced human typing checkpoint. */ checkpointAt?: string; }

export type CreateSpacePage = {
  title?: string; parentId?: string | null; markdown?: string;
  /** A project or folder of the notes tree to create the page in; its folder note, if any, becomes the parent. */
  containerId?: string;
};

export function pageTitle(page: Pick<SpacePage, "title">): string { return page.title.trim() || "Untitled page"; }
