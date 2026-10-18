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
