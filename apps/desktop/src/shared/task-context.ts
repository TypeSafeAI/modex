/**
 * A task's record (docs/task-context.md): one turn's request, the plan the CLI reported, the files it
 * changed, the commands it ran and how they ended, its answer, and what is not settled. It is built
 * from transcript items only and says no more than they do: a step the CLI reported done is
 * "reported done", never checked. It leaves out reasoning, command output and any path outside the
 * project. Pure; main and the renderer both use it.
 */
import { finalAnswerIndex, type ExecutionOutcome, type PlanSource, type PlanStep } from "./conversation-events.js";
import type { ThreadItem } from "./types.js";

export interface TaskCommand { command: string; outcome: ExecutionOutcome; exitCode?: number | null }

export interface TaskRecord {
  title: string;
  threadId: string;
  request: string;
  plan?: { steps: PlanStep[]; from: PlanSource; revision: number };
  /** Changed files inside the project, relative to it. */
  files: string[];
  /** Changed files outside the project: counted, never named. */
  outsideFiles: number;
  commands: TaskCommand[];
  answer?: string;
}

const PATCH_TOOLS = new Set(["apply_patch", "Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SETTLED_WELL = new Set<ExecutionOutcome>(["succeeded"]);

/** The record of the turn that `items` belong to: the user message first, then everything after it. */
export function taskRecord(items: readonly ThreadItem[], opts: { threadId: string; title: string; cwd: string }): TaskRecord {
  const user = items.find((item) => item.kind === "user");
  const rest = items.filter((item) => item.kind !== "user");
  const plan = [...rest].reverse().find((item) => item.kind === "plan");
  const files = new Set<string>();
  let outsideFiles = 0;
  const commands: TaskCommand[] = [];
  for (const item of rest) {
    if (item.kind !== "tool") continue;
    if (PATCH_TOOLS.has(item.name)) {
      for (const file of patchFiles(item)) {
        const rel = relative(file, opts.cwd);
        if (rel === null) outsideFiles++;
        else files.add(rel);
      }
    }
    if (item.exec) commands.push({ command: item.exec.command, outcome: item.outcome ?? (item.ok === true ? "succeeded" : "unknown"), ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}) });
  }
  const final = finalAnswerIndex(rest);
  const answer = final >= 0 ? rest[final] : undefined;
  return {
    title: opts.title, threadId: opts.threadId, request: user?.kind === "user" ? user.text : "",
    ...(plan?.kind === "plan" ? { plan: { steps: plan.steps, from: plan.from, revision: plan.revision } } : {}),
    files: [...files], outsideFiles, commands,
    ...(answer?.kind === "assistant" && answer.text.trim() ? { answer: answer.text.trim() } : {}),
  };
}

const STEP_WORDS: Record<PlanStep["status"], string> = { pending: "not started", "in-progress": "in progress", completed: "reported done", unknown: "status unknown" };
const FROM_WORDS: Record<PlanSource, string> = { "codex-plan": "Codex's plan", "claude-todo": "Claude's todo list" };

/** The record as portable Markdown for a note. */
export function taskMarkdown(record: TaskRecord): string {
  const lines: string[] = [`# ${record.title}`, ""];
  if (record.request.trim()) lines.push(...record.request.trim().split("\n").map((line) => `> ${line}`), "");
  if (record.plan) {
    lines.push("## Plan", "");
    for (const step of record.plan.steps) lines.push(`- [${step.status === "completed" ? "x" : " "}] ${step.text} (${STEP_WORDS[step.status]})`);
    lines.push("", `From ${FROM_WORDS[record.plan.from]}, revision ${record.plan.revision}. "Reported done" is what the CLI said, not a check.`, "");
  }
  if (record.files.length || record.outsideFiles) {
    lines.push("## Files changed", "");
    for (const file of record.files) lines.push(`- \`${file}\``);
    if (record.outsideFiles) lines.push(`- ${record.outsideFiles} ${record.outsideFiles === 1 ? "file" : "files"} outside the project (not named)`);
    lines.push("");
  }
  if (record.commands.length) {
    lines.push("## Commands", "");
    for (const command of record.commands) lines.push(`- ${commandLine(command)}`);
    lines.push("");
  }
  if (record.answer) lines.push("## Answer", "", record.answer, "");
  const loose = [
    ...record.commands.filter((command) => !SETTLED_WELL.has(command.outcome)).map(commandLine),
    ...(record.plan?.steps.filter((step) => step.status !== "completed").map((step) => `${step.text} (${STEP_WORDS[step.status]})`) ?? []),
  ];
  if (loose.length) lines.push("## Not settled", "", ...loose.map((line) => `- ${line}`), "");
  lines.push("---", `From modex thread ${record.threadId}.`);
  return lines.join("\n") + "\n";
}

function commandLine(command: TaskCommand): string {
  const words: Record<ExecutionOutcome, string> = { running: "running", succeeded: "succeeded", failed: "failed", denied: "denied", interrupted: "stopped", unknown: "status unknown" };
  const exit = typeof command.exitCode === "number" ? `exit code ${command.exitCode}` : command.exitCode === null ? "no exit code" : "exit code not reported";
  return `\`${command.command.replace(/`/g, "'")}\` — ${words[command.outcome]}, ${exit}`;
}

/** Files a patch tool touched: Claude's `file_path`/`notebook_path`, or the names in Codex's "edit a, b" title. */
function patchFiles(item: Extract<ThreadItem, { kind: "tool" }>): string[] {
  const path = item.args.file_path ?? item.args.notebook_path;
  if (typeof path === "string" && path) return [path];
  if (item.name === "apply_patch" && item.title.startsWith("edit ")) return item.title.slice(5).split(", ").map((file) => file.trim()).filter(Boolean);
  return [];
}

/** `file` relative to `cwd`, or null when it lies outside it. Relative paths are already the project's. */
function relative(file: string, cwd: string): string | null {
  const isAbsolute = file.startsWith("/") || /^[A-Za-z]:[\\/]/.test(file);
  if (!isAbsolute) return file.includes("..") ? null : file.replace(/^\.\//, "");
  const root = cwd.replace(/[\\/]+$/, "");
  return file.startsWith(root + "/") || file.startsWith(root + "\\") ? file.slice(root.length + 1) : null;
}
