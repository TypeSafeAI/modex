import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { git, isRepo, workspaceRel } from "./git.js";

const MAX_BYTES = 1024 * 1024;
const MAX_FILES = 5000;

/** Read-only, bounded previews. A project symlink never grants access outside its root. */
export async function readWorkspaceFile(cwd: string, relative: string): Promise<string> {
  const root = await fs.realpath(cwd);
  const { abs } = workspaceRel(root, relative);
  const real = await fs.realpath(abs);
  workspaceRel(root, real);
  const file = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Select a regular file.");
    if (stat.size > MAX_BYTES) throw new Error("This file is too large to preview (1 MB limit).");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error("This file is too large to preview (1 MB limit).");
    const content = bytes.subarray(0, bytesRead);
    if (content.includes(0)) throw new Error("Binary files cannot be previewed.");
    return content.toString("utf8");
  } finally { await file.close(); }
}

export async function listWorkspaceFiles(cwd: string): Promise<{ paths: string[]; truncated: boolean }> {
  let paths: string[] = [];
  if (await isRepo(cwd)) {
    const result = await git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."]);
    if (result.code) throw new Error(result.stderr || "Could not list project files.");
    paths = [...new Set(result.stdout.split("\0").filter(Boolean))];
  } else {
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await fs.readdir(path.join(cwd, relative), { withFileTypes: true })) {
        if (paths.length > MAX_FILES) return;
        const name = path.posix.join(relative, entry.name);
        if (entry.isFile()) paths.push(name);
        else if (entry.isDirectory() && ![".git", "node_modules", ".worktrees"].includes(entry.name)) await walk(name);
      }
    };
    await walk("");
  }
  return { paths: paths.sort().slice(0, MAX_FILES), truncated: paths.length > MAX_FILES };
}
