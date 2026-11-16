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

const OUTCOME_LABEL = { running: "Working", succeeded: "Done", failed: "Failed", denied: "Denied", interrupted: "Stopped", unknown: "Status unavailable" } as const;
const AGENT_LABEL = { running: "Working", waiting: "Waiting", completed: "Done", failed: "Failed", stopped: "Stopped", unknown: "Status unavailable" } as const;

/** A tool row's status word. A finished tool reads its outcome; one saved before outcomes existed reads `ok`, as it always did. */
export function toolStatusLabel(item: Extract<ThreadItem, { kind: "tool" }>): string {
  if (item.agent) return AGENT_LABEL[item.agent.state];
  if (item.status === "running") return "Working";
  if (item.outcome) return OUTCOME_LABEL[item.outcome];
  return item.ok === false ? "Failed" : "Done";
}

/** Whether a finished tool folds under its turn's header: only work that succeeded. Failed, denied, stopped and unknown work stays in view. */
export function toolFoldsAsWork(item: Extract<ThreadItem, { kind: "tool" }>): boolean {
  if (item.status !== "done" || item.agent?.state === "running" || item.agent?.state === "waiting") return false;
  return item.outcome ? item.outcome === "succeeded" : item.ok !== false;
}

/** What a tool row is, for its icon. `other` is any tool Modex has no picture for. */
export type ToolKind = "command" | "edit" | "search" | "fetch" | "agent" | "file" | "other";

/** Tools that change a file (the patch tools of shared/evidence.ts, plus the scripted engine's `write_file`). */
const EDIT_TOOLS: ReadonlySet<string> = new Set(["apply_patch", "Edit", "MultiEdit", "Write", "NotebookEdit", "write_file"]);

export function toolKind(item: Extract<ThreadItem, { kind: "tool" }>): ToolKind {
  if (item.name === "WebSearch" || item.name === "webSearch") return "search";
  if (item.name === "WebFetch") return "fetch";
  if (item.name === "Agent" || item.name === "Task") return "agent";
  if (EDIT_TOOLS.has(item.name)) return "edit";
  const text = (key: string) => typeof item.args[key] === "string" && !!(item.args[key] as string).trim();
  if (text("command") || item.name === "shell" || item.name === "Bash") return "command";
  return text("file_path") || text("path") || text("notebook_path") ? "file" : "other";
}

/** "Ran" or "Running" for a row whose summary is a command line ("$ …"). Any other summary is already a phrase and gets no verb. */
export function toolVerb(item: Extract<ThreadItem, { kind: "tool" }>): "Ran" | "Running" | null {
  if (!toolSummary(item).startsWith("$ ")) return null;
  return item.status === "running" ? "Running" : "Ran";
}
