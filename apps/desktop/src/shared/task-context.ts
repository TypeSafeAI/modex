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

/** A check the turn ran: a test, build, typecheck or lint command. `stale`: something that may change files ran after it. */
export interface TaskCheck extends TaskCommand { passed: boolean; stale: boolean }

/** What the turn's checks say about its latest change (docs/task-context.md#verification). */
export interface TaskVerification {
  state: "verified" | "failed" | "unknown" | "stale" | "none";
  checks: TaskCheck[];
  /** Edits the turn made (patch tools not denied). With none and no check, there is nothing to verify. */
  edits: number;
}

/** A command as the CLI reported it, shown as the script when the whole of it is `sh`/`bash`/`zsh -c '…'`. */
export function displayCommand(command: string): string {
  const wrapper = /^\s*(?:\S*\/)?(?:sh|bash|zsh|dash)\s+-[a-z]*c[a-z]*\s+(['"])([\s\S]*)\1\s*$/.exec(command);
  if (!wrapper) return command;
  const [, quote, script] = wrapper as unknown as [string, string, string];
  // The script must be the one quoted word: `sh -c 'a' && sh -c 'b'` is not one wrapper.
  if (quote === "'" ? script.includes("'") : /(^|[^\\])"/.test(script)) return command;
  return quote === '"' ? script.replace(/\\(["\\$`])/g, "$1") : script;
}



export interface TaskRecord {
  title: string;
  threadId: string;
  request: string;
  plan?: { steps: PlanStep[]; from: PlanSource; revision: number };
  /** The plan Codex proposed in plan mode, as it wrote it: text, with no step statuses. */
  proposedPlan?: string;
  /** The CLI that did this turn's work and reported no plan (docs/task-context.md#plans). */
  noPlan?: "claude" | "codex";
  /** Changed files inside the project, relative to it. */
  files: string[];
  /** Changed files outside the project: counted, never named. */
  outsideFiles: number;
  commands: TaskCommand[];
  /** Each question the CLI asked during the turn, one entry per question on its cards. */
  clarifications: TaskClarification[];
  /** Whether a check that ran after the turn's last change passed. */
  verification?: TaskVerification;
  /** The project files the turn touched, by what the CLI reported. */
  context?: TaskContext;
  answer?: string;
}

/**
 * The record a Save to Notes wrote, kept beside the note in the notes folder's `.modex/tasks/` so the note
 * can reopen as the task it saved (docs/task-context.md#reopening-a-saved-note). Written only by a save.
 */
export interface TaskSnapshot {
  version: 1;
  pageId: string;
  /** The note's revision as this save wrote it. */
  revision: number;
  /** The Modex project the task ran in. */
  projectId: string;
  threadId: string;
  turnId: string;
  savedAt: string;
  record: TaskRecord;
}

/** A saved task note, reopened read-only: the record as saved, and what has happened to the note since. */
export interface TaskNoteView {
  record: TaskRecord;
  threadId: string;
  turnId: string;
  savedAt: string;
  savedRevision: number;
  note: { title: string; revision: number; trashed: boolean };
  /** The note's title or text changed after the save: the first version that changed it. */
  edited?: { revision: number; by: "you" | "outside" | "agent" | "other"; at: string };
  /** The note is now in another project's notes than the one the task ran in (#363). */
  moved?: { from: string; to: string };
  /** The project the task ran in no longer has notes linked to it. */
  unlinked?: true;
  /** A later save of this task went to another note. */
  superseded?: { pageId: string; title: string };
  /** Whether the thread is still in Modex. */
  thread: boolean;
}

/** Whether `value` is a task snapshot this version can show; a damaged file is never rendered. */
export function isTaskSnapshot(value: unknown): value is TaskSnapshot {
  const v = value as TaskSnapshot | null;
  const strings = (list: unknown) => Array.isArray(list) && list.every((s) => typeof s === "string");
  const r = v?.record;
  return typeof v === "object" && v !== null && v.version === 1 && typeof v.pageId === "string" && Number.isInteger(v.revision)
    && typeof v.projectId === "string" && typeof v.threadId === "string" && typeof v.turnId === "string" && typeof v.savedAt === "string"
    && typeof r === "object" && r !== null && typeof r.title === "string" && typeof r.request === "string" && strings(r.files)
    && Number.isInteger(r.outsideFiles) && Array.isArray(r.commands) && r.commands.every((c) => typeof c?.command === "string")
    && Array.isArray(r.clarifications) && r.clarifications.every((c) => typeof c?.question === "string" && (c.answer === null || strings(c.answer)))
    && (r.plan === undefined || (Array.isArray(r.plan.steps) && r.plan.steps.every((s) => typeof s?.text === "string" && typeof s.status === "string")))
    && (r.verification === undefined || (typeof r.verification.state === "string" && Array.isArray(r.verification.checks) && r.verification.checks.every((c) => typeof c?.command === "string")))
    && (r.context === undefined || (Array.isArray(r.context.files) && r.context.files.every((f) => typeof f?.path === "string" && strings(f.relations)) && Number.isInteger(r.context.outside)))
    && (r.answer === undefined || typeof r.answer === "string");
}

/** A question the CLI asked, with the answer as its card shows it. Nothing is filled in that the card does not hold. */
export interface TaskClarification {
  question: string;
  /** The answers as shown, saved and exported (a secret one is "(hidden)"), or null when nobody answered. */
  answer: string[] | null;
  /** Why an unanswered question closed (docs/human-requests.md). */
  closed?: "native" | "stopped" | "ended" | "message";
  /** Answered, but Modex stopped before it could confirm the CLI received the answer. */
  uncertain?: true;
}

const PATCH_TOOLS = new Set(["apply_patch", "Edit", "MultiEdit", "Write", "NotebookEdit"]);
const SETTLED_WELL = new Set<ExecutionOutcome>(["succeeded"]);

/** The record of the turn that `items` belong to: the user message first, then everything after it. */
const CLI_NAMES = { claude: "Claude Code", codex: "Codex" } as const;

/**
 * Which CLI did a turn's work without reporting a plan: it changed files or ran commands, and no plan
 * item or proposed plan came. Claude Code 2.1.308 and later offer Modex no plan tool, and live Codex
 * turns outside plan mode sent none.
 * A chat turn, or one from any other engine, gets null.
 */
export function noPlan(items: readonly ThreadItem[]): "claude" | "codex" | null {
  if (items.some((item) => item.kind === "plan" || proposedPlan(item))) return null;
  const work = items.find((item) => item.kind === "tool" && (PATCH_TOOLS.has(item.name) || item.exec));
  const backend = work?.kind === "tool" ? work.origin?.backend : undefined;
  return backend === "claude" || backend === "codex" ? backend : null;
}

/** "Claude Code reported no plan for this turn", in the footer and the saved note. */
export function noPlanText(cli: "claude" | "codex"): string {
  return `${CLI_NAMES[cli]} reported no plan for this turn`;
}

/** Codex's plan-mode `plan` item arrives as a message with its native phase kept. */
function proposedPlan(item: ThreadItem): boolean {
  return item.kind === "assistant" && item.nativePhase === "plan" && Boolean(item.text.trim());
}

export function taskRecord(items: readonly ThreadItem[], opts: { threadId: string; title: string; cwd: string }): TaskRecord {
  const user = items.find((item) => item.kind === "user");
  const rest = items.filter((item) => item.kind !== "user");
  const plan = [...rest].reverse().find((item) => item.kind === "plan");
  const files = new Set<string>();
  let outsideFiles = 0;
  const commands: TaskCommand[] = [];
  const clarifications: TaskClarification[] = [];
  for (const item of rest) {
    if (item.kind === "question") {
      for (const question of item.questions) {
        const answer = item.answers ? item.answers[question.id] ?? null : null;
        clarifications.push({ question: question.text, answer, ...(!answer && item.withdrawn ? { closed: item.withdrawn } : {}), ...(answer && item.delivery === "uncertain" ? { uncertain: true as const } : {}) });
      }
    }
    // A question the agent asked in its message has no answer in this turn: the next message is the answer.
    if (item.kind === "assistant") for (const ask of item.asks ?? []) clarifications.push({ question: ask.title, answer: null, closed: "message" });
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
  const missing = noPlan(rest);
  const proposed = [...rest].reverse().find(proposedPlan);
  return {
    title: opts.title, threadId: opts.threadId, request: user?.kind === "user" ? user.text : "",
    ...(plan?.kind === "plan" ? { plan: { steps: plan.steps, from: plan.from, revision: plan.revision } } : {}),
    ...(proposed?.kind === "assistant" ? { proposedPlan: proposed.text.trim() } : {}),
    ...(missing ? { noPlan: missing } : {}),
    files: [...files], outsideFiles, commands, clarifications, verification: verification(rest), context: taskContext(rest, opts.cwd),
    ...(answer?.kind === "assistant" && answer !== proposed && answer.text.trim() ? { answer: answer.text.trim() } : {}),
  };
}

export const PROPOSED_WORDS = "Codex proposed this plan in plan mode. Its steps have no statuses.";
const STEP_WORDS: Record<PlanStep["status"], string> = { pending: "not started", "in-progress": "in progress", completed: "reported done", unknown: "status unknown" };
const FROM_WORDS: Record<PlanSource, string> = { "codex-plan": "Codex's plan", "claude-todo": "Claude's todo list", "claude-tasks": "Claude's task list", "acp-plan": "The agent's plan" };

/** The record as portable Markdown for a note. */
export function taskMarkdown(record: TaskRecord): string {
  const lines: string[] = [`# ${record.title}`, ""];
  if (record.request.trim()) lines.push(...record.request.trim().split("\n").map((line) => `> ${line}`), "");
  const clarifications = record.clarifications ?? [];
  if (clarifications.length) lines.push("## Clarifications", "", ...clarifications.map((c) => `- ${clarificationLine(c)}`), "");
  if (!record.plan && record.proposedPlan) lines.push("## Plan", "", `${PROPOSED_WORDS}`, "", ...record.proposedPlan.split("\n").map((line) => line ? `> ${line}` : ">"), "");
  if (!record.plan && !record.proposedPlan && record.noPlan) lines.push("## Plan", "", `${noPlanText(record.noPlan)}.`, "");
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
  const context = record.context;
  if (context && (context.files.length || context.outside)) {
    lines.push("## Files the turn touched", "", "As the CLI reported them. Modex did not index the project.", "");
    for (const file of context.files.slice(0, CONTEXT_SHOWN)) lines.push(`- \`${file.path}\` — ${file.relations.join(", ")}`);
    if (context.files.length > CONTEXT_SHOWN) lines.push(`- and ${context.files.length - CONTEXT_SHOWN} more`);
    if (context.outside) lines.push(`- ${context.outside} outside the project (not named)`);
    lines.push("");
  }
  if (record.commands.length) {
    lines.push("## Commands", "");
    for (const command of record.commands) lines.push(`- ${commandLine(command)}`);
    lines.push("");
  }
  const checked = record.verification;
  if (checked && (checked.checks.length || record.files.length || record.outsideFiles)) {
    lines.push("## Verification", "", VERIFICATION_WORDS[checked.state], "");
    if (checked.checks.length) lines.push(...checked.checks.map((check) => `- ${commandLine(check)}${check.stale ? " (ran before a later change)" : ""}`), "");
  }
  if (record.answer) lines.push("## Answer", "", record.answer, "");
  // A check a later fix superseded is settled by what came after it; the verification line says how.
  const superseded = new Set(checked?.checks.filter((check) => check.stale).map((check) => check.command + "\0" + check.outcome) ?? []);
  const loose = [
    ...record.commands.filter((command) => !SETTLED_WELL.has(command.outcome) && !(checked?.state === "verified" && superseded.has(command.command + "\0" + command.outcome))).map(commandLine),
    ...(record.plan?.steps.filter((step) => step.status !== "completed").map((step) => `${step.text} (${STEP_WORDS[step.status]})`) ?? []),
    ...clarifications.filter((c) => !c.answer || c.uncertain).map(clarificationLine),
    ...(checked && checked.state !== "verified" && (checked.checks.length || record.files.length || record.outsideFiles) ? [VERIFICATION_WORDS[checked.state]] : []),
  ];
  if (loose.length) lines.push("## Not settled", "", ...loose.map((line) => `- ${line}`), "");
  lines.push("---", `From modex thread ${record.threadId}.`);
  return lines.join("\n") + "\n";
}

const CLOSED_WORDS: Record<NonNullable<TaskClarification["closed"]>, string> = { native: "the agent withdrew it", stopped: "the turn was stopped", ended: "the turn ended first", message: "it was asked in a message" };

/** A clarification as one line: the question, then its answer or why it has none. */
export function clarificationLine(c: TaskClarification): string {
  if (!c.answer && c.closed === "message") return `${c.question} — asked in a message: the answer is the next message`;
  if (!c.answer) return `${c.question} — not answered${c.closed ? `: ${CLOSED_WORDS[c.closed]}` : ""}`;
  return `${c.question} — ${c.answer.join(", ")}${c.uncertain ? " (Modex could not confirm the agent received this answer)" : ""}`;
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

/** Lexical paths only: shared with the renderer, so no filesystem or Node path dependency. */
function normalizedPath(path: string, windows: boolean): string {
  if (windows) path = path.replace(/\\/g, "/");
  const prefix = (windows ? path.match(/^(?:[A-Za-z]:\/|\/\/[^/]+\/[^/]+(?:\/|$)|\/)/) : path.match(/^\//))?.[0] ?? "";
  const parts: string[] = [];
  for (const part of path.slice(prefix.length).split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else if (part !== ".." || !prefix) parts.push(part);
  }
  return prefix.replace(/\/?$/, prefix ? "/" : "") + parts.join("/");
}

/** Resolve from the reporting command's cwd, then check the normalized project boundary. */
function resolvedPath(file: string, cwd: string, commandCwd = cwd): string | null {
  const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
  const resolve = (path: string, base: string): string | null => {
    if (windows) {
      path = path.replace(/\\/g, "/");
      base = base.replace(/\\/g, "/");
      // Drive-relative paths depend on process state that the transcript does not contain.
      if (/^[A-Za-z]:(?!\/)/.test(path)) return null;
      if (path.startsWith("/") && !path.startsWith("//")) {
        const device = base.match(/^(?:[A-Za-z]:|\/\/[^/]+\/[^/]+)/)?.[0];
        if (!device) return null;
        path = device + path;
      }
    }
    const absolute = path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
    return normalizedPath(absolute ? path : `${base}/${path}`, windows);
  };
  const base = resolve(commandCwd, cwd);
  if (base === null) return null;
  return resolve(file, base)?.replace(/\/$/, "") ?? null;
}

function relative(file: string, cwd: string, commandCwd = cwd): string | null {
  const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
  const root = normalizedPath(cwd, windows).replace(/\/$/, "");
  const resolved = resolvedPath(file, cwd, commandCwd);
  if (resolved === null) return null;
  const compare = (path: string) => windows ? path.toLowerCase() : path;
  if (compare(resolved) === compare(root)) return ".";
  return compare(resolved).startsWith(compare(root) + "/") ? resolved.slice(root.length + 1) : null;
}

const VERIFICATION_WORDS: Record<TaskVerification["state"], string> = {
  verified: "Verified: every check after the turn's last change passed.",
  failed: "Failed: a check after the turn's last change did not pass.",
  unknown: "Not verified: a check after the turn's last change did not finish or did not say how it ended.",
  stale: "Not verified: every check ran before a later change.",
  none: "Not verified: no check result confirms the latest changes.",
};

/** Tools that change files. `write_file` is the offline engine's. A denied one changed nothing. */
const EDIT_TOOLS = new Set([...PATCH_TOOLS, "write_file"]);

/**
 * What the turn's checks say about its latest change, in transcript order. A check passes only as
 * `succeeded` with exit code 0 or none reported (Claude Code reports none, and its failed commands
 * come through as failed). A check is stale once an edit, or a command that might write files, ran
 * after it: Modex cannot see what an unknown command wrote. Nothing here links a check to a plan
 * step, because neither CLI reports such a link.
 */
export function verification(items: readonly ThreadItem[]): TaskVerification {
  const checks: TaskCheck[] = [];
  let edits = 0;
  const staleAll = () => { for (const check of checks) check.stale = true; };
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const outcome = item.outcome ?? (item.ok === true ? "succeeded" : "unknown");
    if (EDIT_TOOLS.has(item.name)) {
      if (outcome !== "denied") { edits++; staleAll(); }
      continue;
    }
    const command = item.exec?.command;
    if (!command) continue;
    if (isCheckCommand(command)) {
      const passed = outcome === "succeeded" && (item.exitCode === 0 || item.exitCode === undefined);
      checks.push({ command, outcome, ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}), passed, stale: false });
    } else if (outcome !== "denied" && !isReadOnlyCommand(command)) {
      staleAll();
    }
  }
  const current = checks.filter((check) => !check.stale);
  const failed = (check: TaskCheck) => check.outcome === "failed" || check.outcome === "denied" || (typeof check.exitCode === "number" && check.exitCode !== 0);
  const state: TaskVerification["state"] = !checks.length ? "none" : !current.length ? "stale"
    : current.some(failed) ? "failed" : current.every((check) => check.passed) ? "verified" : "unknown";
  return { state, checks, edits };
}

/** Script names that check a project: `test`, `test:e2e`, `build`, `typecheck`, `lint`, `check`, `verify`. */
const CHECK_SCRIPT = /^(test|build|typecheck|type-check|lint|check|verify)(:|$)/;
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
/** Package-manager flags that take a value, so the value is not read as the script. */
const VALUE_FLAGS = new Set(["--filter", "-F", "-C", "--dir", "--prefix", "--cwd", "-w", "--workspace", "-p", "--package"]);
const RUNNERS = new Set(["pytest", "vitest", "jest", "mocha", "tsc", "eslint", "mypy", "flake8", "rspec", "ctest", "phpunit"]);
const SUBCOMMANDS: Record<string, Set<string>> = {
  cargo: new Set(["test", "build", "check", "clippy", "nextest"]), go: new Set(["test", "build", "vet"]), swift: new Set(["test", "build"]),
  make: new Set(["test", "check", "build", "lint", "typecheck"]), gmake: new Set(["test", "check", "build", "lint"]), gradle: new Set(["test", "build", "check"]),
  gradlew: new Set(["test", "build", "check"]), mvn: new Set(["test", "verify", "package"]), dotnet: new Set(["test", "build"]), ruff: new Set(["check"]),
};
/** Commands that only read: running one after a check leaves the check current. */
const READ_ONLY = new Set(["ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "grep", "rg", "which", "type", "file", "stat",
  "cut", "tr", "basename", "dirname", "realpath", "true", "cd", "nl"]);


/** Whether a command, as the CLI reported it, runs a known test, build, typecheck or lint check. */
export function isCheckCommand(command: string): boolean {
  const parts = segments(command, { checks: true, noWrites: true });
  if (!parts?.length) return false;
  let sawCheck = false;
  for (const words of parts) {
    if (checkSegment(words)) { sawCheck = true; continue; }
    // A leading directory change joined with && must succeed before the check runs.
    // Other mixed commands have no individual exit/write evidence in the tool receipt.
    if (!sawCheck && words[0] === "cd" && (words.length === 2 || (words.length === 3 && words[1] === "--"))) continue;
    return false;
  }
  return sawCheck;
}

function checkSegment(words: string[]): boolean {
  const [head, ...rest] = words;
  if (!head) return false;
  const program = head.split("/").pop()!.replace(/^\.\//, "");
  if (PACKAGE_MANAGERS.has(program)) {
    const args = dropFlags(rest);
    const [verb, ...after] = args;
    if (verb === "run" || verb === "run-script") return CHECK_SCRIPT.test(dropFlags(after)[0] ?? "");
    if (verb === "exec" || verb === "dlx" || verb === "x") return checkSegment(dropFlags(after));
    return CHECK_SCRIPT.test(verb ?? "");
  }
  if (program === "npx" || program === "bunx") return checkSegment(dropFlags(rest));
  if (program === "bundle" && rest[0] === "exec") return checkSegment(rest.slice(1));
  if (program === "node") return rest.includes("--test");
  if (/^python3?$/.test(program)) return rest[0] === "-m" && ["pytest", "unittest", "mypy"].includes(rest[1] ?? "");
  if (RUNNERS.has(program)) return true;
  if (program === "playwright") return rest[0] === "test";
  if (program === "xcodebuild") return rest.some((word) => word === "test" || word === "build");
  const verbs = SUBCOMMANDS[program];
  return verbs ? verbs.has(dropFlags(rest)[0] ?? "") : false;
}

function dropFlags(words: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word.startsWith("-")) { if (VALUE_FLAGS.has(word)) i++; continue; }
    out.push(word);
  }
  return out;
}

/** Whether every part of a command only reads. A redirect writes. Anything unknown might write. */
function isReadOnlyCommand(command: string): boolean {
  const parts = segments(command, { noWrites: true });
  return parts !== null && parts.every((words) => {
    const program = (words[0] ?? "").split("/").pop()!;
    // Only known status forms: git config/options and other verbs can invoke helpers or write.
    if (program === "git") return words[1] === "status" && words.slice(2).every((word) => ["--short", "-s", "--branch", "-b", "--porcelain", "--porcelain=v1", "--porcelain=v2"].includes(word));
    if (program === "sed") return words.length >= 3 && words[1] === "-n" && /^\d+(?:,\d+)?p$/.test(words[2]!) && words.slice(3).every((word) => !word.startsWith("-"));
    if (program === "rg" && words.some((word) => word === "--pre" || word.startsWith("--pre="))) return false;
    return READ_ONLY.has(program);
  });
}

/**
 * A command split into simple commands, each a list of words, after unwrapping `sh`/`bash`/`zsh -c '…'`.
 * Quotes are respected, so `echo 'pnpm test'` is one word. Leading `NAME=value` assignments are dropped.
 * Dynamic expansion and unsupported shell syntax fail closed. `checks` permits only && chains:
 * the tool's final exit status cannot prove earlier checks passed across ;, ||, pipes or backgrounding.
 * `noWrites` rejects output redirection; its destination could be a file the check was meant to verify.
 */
function segments(command: string, options: { noWrites?: boolean; checks?: boolean } = {}): string[][] | null {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let quoted = false;
  const endWord = () => { if (word || quoted) words.push(word); word = ""; quoted = false; };
  const endSegment = () => { endWord(); while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (quote === '"' && (c === "$" || c === "`")) return null;
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; quoted = true; continue; }
    if (c === "\\" && i + 1 < command.length) { word += command[++i]; continue; }
    if (c === "$" || c === "`" || c === "(" || c === ")" || c === "#") return null;
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      if (options.checks) {
        if (c !== "&" || command[i + 1] !== "&") return null;
        endWord();
        if (!words.length) return null;
        i++;
      }
      endSegment(); continue;
    }
    if (/\s/.test(c)) { endWord(); continue; }
    if (c === ">" || c === "<") { if (options.checks || (options.noWrites && c === ">")) return null; endWord(); continue; }
    word += c;
  }
  if (quote || (options.checks && !word && !quoted && !words.length)) return null;
  endSegment();
  // `/bin/zsh -lc '<script>'`: the script is the command.
  const result: string[][] = [];
  for (const segment of out) {
    const program = (segment[0] ?? "").split("/").pop()!;
    // Restrict wrappers to common execution forms. In particular, -n/-o noexec only
    // parse the script; their successful receipt says nothing about its checks.
    if (/^(sh|bash|zsh|dash)$/.test(program)) {
      if (segment.length !== 3 || !/^-l?c$/.test(segment[1] ?? "")) return null;
      const inner = segments(segment[2]!, options);
      if (inner === null) return null;
      result.push(...inner);
    } else result.push(segment);
  }
  return result;
}

/** The most files a context map shows; the rest are counted. */
export const CONTEXT_SHOWN = 20;
/** A project file the turn touched, and how, as the CLI reported it. */
export interface ContextFile { path: string; relations: ("read" | "changed" | "searched")[] }
/** The files a turn touched inside the project, and how many outside it (counted, never named). */
export interface TaskContext { files: ContextFile[]; outside: number }

/** Tools that read one file, and the argument that names it. */
const READ_ARGS: Record<string, string> = { Read: "file_path", read_file: "path", NotebookRead: "notebook_path" };
/** Tools that search or list under a path. */
const SEARCH_ARGS: Record<string, string> = { Grep: "path", Glob: "path", LS: "path", list_dir: "path" };

/**
 * The project files a turn touched, by what the CLI reported (docs/task-context.md#context-map): files
 * its patch tools changed, files it read (Claude's Read, Codex's own parse of a command), and paths it
 * searched or listed. A denied or failed tool touched nothing. Nothing is inferred: a `cat` through a
 * shell that the CLI did not parse is not counted, and no dependency is guessed. Changed files come
 * first, then read, then searched, each in the order the turn first touched them.
 */
export function taskContext(items: readonly ThreadItem[], cwd: string): TaskContext {
  const files = new Map<string, ContextFile>();
  const outsidePaths = new Set<string>();
  const add = (raw: unknown, relation: ContextFile["relations"][number], commandCwd = cwd) => {
    if (typeof raw !== "string" || !raw.trim()) return;
    const path = relative(raw.trim(), cwd, commandCwd);
    if (path === null) {
      const resolved = resolvedPath(raw.trim(), cwd, commandCwd);
      const windows = /^[A-Za-z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\");
      outsidePaths.add(resolved === null ? `unresolved:${commandCwd}\0${raw.trim()}` : windows ? resolved.toLowerCase() : resolved);
      return;
    }
    const file = files.get(path) ?? { path, relations: [] };
    if (!file.relations.includes(relation)) file.relations.push(relation);
    files.set(path, file);
  };
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const outcome = item.outcome ?? (item.ok === true ? "succeeded" : "unknown");
    if (outcome === "denied" || outcome === "failed") continue;
    if (EDIT_TOOLS.has(item.name)) {
      for (const file of patchFiles(item)) add(file, "changed");
      if (item.name === "write_file") add(item.args.path, "changed");
    }
    if (READ_ARGS[item.name]) add(item.args[READ_ARGS[item.name]!], "read");
    if (SEARCH_ARGS[item.name]) add(item.args[SEARCH_ARGS[item.name]!], "searched");
    for (const action of item.exec?.actions ?? []) add(action.path, action.kind === "read" ? "read" : "searched", item.exec?.cwd ?? cwd);
  }
  const rank = (file: ContextFile) => (file.relations.includes("changed") ? 0 : file.relations.includes("read") ? 1 : 2);
  const ordered = [...files.values()].map((file, i) => ({ file, i })).sort((a, b) => rank(a.file) - rank(b.file) || a.i - b.i).map(({ file }) => file);
  return { files: ordered, outside: outsidePaths.size };
}
