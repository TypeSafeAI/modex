import fs from "node:fs";
import path from "node:path";
import type { BackendId } from "../../shared/types.js";

export interface MobileCommand {
  id: string;
  title: string;
  detail: string;
  insertion: string;
  kind: "skill" | "command";
}

function metadata(file: string): { name?: string } {
  try {
    const text = fs.readFileSync(file, "utf8").slice(0, 16_384);
    const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(text)?.[1] ?? "";
    const field = (key: string) => new RegExp(`^${key}:\\s*["']?(.+?)["']?\\s*$`, "m").exec(frontmatter)?.[1]?.trim();
    return { name: field("name") };
  } catch { return {}; }
}

function skillCommands(root: string, prefix: "/" | "$"): MobileCommand[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  return entries.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith(".")).slice(0, 250).flatMap((entry) => {
    const file = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) return [];
    const data = metadata(file);
    const title = data.name || entry.name;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/.test(title)) return [];
    return [{ id: `skill:${title}`, title, detail: "Installed skill", insertion: `${prefix}${title} `, kind: "skill" as const }];
  });
}

function claudeCommands(root: string): MobileCommand[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md") && !entry.name.startsWith(".")).slice(0, 250).flatMap((entry) => {
    const title = entry.name.slice(0, -3);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(title)) return [];
    return [{ id: `command:${title}`, title, detail: "Custom command", insertion: `/${title} `, kind: "command" as const }];
  });
}

export function discoverMobileCommands(userHome: string, cwd: string, backend: BackendId): MobileCommand[] {
  if (backend === "mock") return [];
  const commands = backend === "claude"
    ? [
        ...claudeCommands(path.join(userHome, ".claude", "commands")),
        ...claudeCommands(path.join(cwd, ".claude", "commands")),
        ...skillCommands(path.join(userHome, ".claude", "skills"), "/"),
        ...skillCommands(path.join(cwd, ".claude", "skills"), "/"),
      ]
    : [
        ...skillCommands(path.join(userHome, ".codex", "skills"), "$"),
        ...skillCommands(path.join(userHome, ".agents", "skills"), "$"),
        ...skillCommands(path.join(cwd, ".codex", "skills"), "$"),
        ...skillCommands(path.join(cwd, ".agents", "skills"), "$"),
      ];
  const unique = new Map(commands.map((command) => [command.id, command]));
  return [...unique.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
}
