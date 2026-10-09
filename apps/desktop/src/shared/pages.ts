export const PAGES_TOOLS = ["search", "read", "create", "edit", "update", "trash", "restore", "history", "revert"] as const;
export type PagesConnection = { url: string; instructions: string };
export type PagesChange = { pageId: string; title: string; summary: string; revision: number };
