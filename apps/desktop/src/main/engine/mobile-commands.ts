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

const MAX_DESCRIPTION = 4_000;

/** One frontmatter field: inline (optionally quoted), a `|`/`>` block, or a plain value continued on indented lines. */
function frontmatterField(frontmatter: string, key: string): string | undefined {
  const lines = frontmatter.split("\n");
  const at = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
  if (at < 0) return undefined;
  const inline = lines[at]!.slice(key.length + 1).trim();
  const block = /^[|>][+-]?$/.test(inline);
  const rest: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && !/^\s/.test(line)) break;
    rest.push(line.trim());
  }
  const folded = inline.startsWith(">") || !block;
  const parts = block ? rest : [inline, ...rest];
  const text = (folded ? parts.join(" ") : parts.join("\n")).replace(/ {2,}/g, " ").trim();
  return text.replace(/^(["'])([\s\S]*)\1$/, "$2").trim() || undefined;
}

function metadata(file: string): { name?: string; description?: string } {
  try {
    const text = fs.readFileSync(file, "utf8").slice(0, 32_768);
    const frontmatter = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(text)?.[1] ?? "";
    return { name: frontmatterField(frontmatter, "name"), description: frontmatterField(frontmatter, "description") };
  } catch { return {}; }
}

/** A skill's own words, whole, with the user's and project's absolute locations replaced: the phone never learns where things live. */
function scrub(text: string, userHome: string, cwd: string): string {
  const withoutPlaces = [[cwd, "<project>"], [userHome, "~"]].reduce((out, [from, to]) => (from && from.length > 1 ? out.split(from).join(to!) : out), text);
  return withoutPlaces.replace(/\/(?:Users|home)\/[^/\s]+/g, "~").slice(0, MAX_DESCRIPTION);
}

function skillCommands(root: string, prefix: "/" | "$", userHome: string, cwd: string): MobileCommand[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return []; }
  return entries.filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith(".")).slice(0, 250).flatMap((entry) => {
    const file = path.join(root, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) return [];
    const data = metadata(file);
    const title = data.name || entry.name;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,99}$/.test(title)) return [];
    return [{ id: `skill:${title}`, title, detail: data.description ? scrub(data.description, userHome, cwd) : "Installed skill", insertion: `${prefix}${title} `, kind: "skill" as const }];
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
        ...skillCommands(path.join(userHome, ".claude", "skills"), "/", userHome, cwd),
        ...skillCommands(path.join(cwd, ".claude", "skills"), "/", userHome, cwd),
      ]
    : [
        ...skillCommands(path.join(userHome, ".codex", "skills"), "$", userHome, cwd),
        ...skillCommands(path.join(userHome, ".agents", "skills"), "$", userHome, cwd),
        ...skillCommands(path.join(cwd, ".codex", "skills"), "$", userHome, cwd),
        ...skillCommands(path.join(cwd, ".agents", "skills"), "$", userHome, cwd),
      ];
  const unique = new Map(commands.map((command) => [command.id, command]));
  return [...unique.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
}
