import type { ThreadItem } from "./types.js";

export function toolSummary(item: Extract<ThreadItem, { kind: "tool" }>): string {
  const line = (text: string) => text.replace(/\s+/g, " ").trim();
  const title = line(item.title);
  const name = line(item.name.replace(/[_-]+/g, " ")) || "tool";
  if (title && title !== item.name && title !== name) return title;
  const arg = (...keys: string[]) => keys.map(k => item.args[k]).find((v): v is string => typeof v === "string" && !!v.trim());
  const command = arg("command");
  if (command) return `$ ${line(command)}`;
  const description = arg("description");
  if ((item.name === "Agent" || item.name === "Task") && description) return `agent: ${line(description)}`;
  const path = arg("file_path", "path", "notebook_path");
  if (path) return `${name} ${line(path)}`;
  const detail = arg("query", "pattern", "url", "description");
  return detail ? `${name} · ${line(detail)}` : title || name;
}
