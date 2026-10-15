export const PAGES_TOOLS = ["search", "read", "create", "edit", "update", "trash", "restore", "history", "revert", "list", "create_folder", "move", "read_file"] as const;
export type PagesConnection = { url: string; instructions: string };
export type PagesChange = { pageId: string; title: string; summary: string; revision: number };
