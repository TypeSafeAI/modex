/**
 * A task's record (docs/task-context.md): one turn's request, the plan the CLI reported, the files it
 * changed, the commands it ran and how they ended, its answer, and what is not settled. It is built
 * from transcript items only and says no more than they do: a step the CLI reported done is
 * "reported done", never checked. It leaves out reasoning, command output and any path outside the
 * project. Pure; main and the renderer both use it.
 */
import { finalAnswerIndex, type ExecutionOutcome, type PlanSource, type PlanStep } from "./conversation-events.js";
import type { ThreadItem } from "./types.js";
import { copyTaskContextEvidence, isTaskContextEvidence, isTaskCommandText, isCommandOmission, OMITTED_COMMAND, taskContextBelongsTo, type CommandOmission, type TaskContextEvidence } from "./task-context-evidence.js";
export * from "./task-context-evidence.js";

export interface TaskCommand { command: string; outcome: ExecutionOutcome; exitCode?: number | null; commandOmission?: CommandOmission; itemId?: string }

/** A check the turn ran: a test, build, typecheck or lint command. `stale`: something that may change files ran after it. */
export interface TaskCheck extends TaskCommand { passed: boolean; stale: boolean }

/** What the turn's checks say about its latest change (docs/task-context.md#verification). */
export interface TaskVerification {
  state: "verified" | "failed" | "unknown" | "stale" | "none";
  checks: TaskCheck[];
  /** Edits the turn made (patch tools not denied). With none and no check, there is nothing to verify. */
  edits: number;
  /** Modern provenance is limited to timed snapshots, never subprocess input attestation. */
  basis?: "context-snapshots";
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
  /** Main-owned timed provenance, frozen at Save; omitted for legacy turns. */
  contextEvidence?: TaskContextEvidence;
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
  pageId: string;
  projectId: string;
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
    && Number.isInteger(r.outsideFiles) && Array.isArray(r.commands) && r.commands.every((c) => isTaskCommandText(c) && (c.itemId === undefined || portableItemId(c.itemId)))
    && Array.isArray(r.clarifications) && r.clarifications.every((c) => typeof c?.question === "string" && (c.answer === null || strings(c.answer)))
    && (r.plan === undefined || (Array.isArray(r.plan.steps) && r.plan.steps.every((s) => typeof s?.text === "string" && typeof s.status === "string")))
    && (r.verification === undefined || (typeof r.verification.state === "string" && Array.isArray(r.verification.checks) && r.verification.checks.every(isTaskCommandText)))
    && (r.context === undefined || (Array.isArray(r.context.files) && r.context.files.every((f) => typeof f?.path === "string" && strings(f.relations)) && Number.isInteger(r.context.outside)
      && (r.context.unlisted === undefined || strings(r.context.unlisted)) && validUnlistedOmissions(r.context)))
    && (r.answer === undefined || typeof r.answer === "string")
    && (r.contextEvidence === undefined || (isTaskContextEvidence(r.contextEvidence) && taskContextBelongsTo(r.contextEvidence, v.threadId, v.turnId, v.projectId)));
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

export function taskRecord(items: readonly ThreadItem[], opts: { threadId: string; title: string; cwd: string; contextEvidence?: TaskContextEvidence }): TaskRecord {
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
    if (PATCH_TOOLS.has(item.name) && !item.displayOnlyInputs) {
      for (const file of patchFiles(item)) {
        const rel = relative(file, opts.cwd);
        if (rel === null) outsideFiles++;
        else files.add(rel);
      }
    }
    if (item.exec) commands.push({ command: item.exec.command, ...(!isPortableCommand(item.exec.command) && portableItemId(item.id) ? { itemId: item.id } : {}), outcome: item.outcome ?? (item.ok === true ? "succeeded" : "unknown"), ...(item.exitCode !== undefined ? { exitCode: item.exitCode } : {}) });
  }
  const evidence = opts.contextEvidence ?? (user?.kind === "user" ? user.contextEvidence : undefined);
  if (evidence !== undefined && (!isTaskContextEvidence(evidence) || !user || !taskContextBelongsTo(evidence, opts.threadId, user.id))) throw new Error("Task context does not belong to this request.");
  const context = taskContext(items, opts.cwd, evidence);
  const final = finalAnswerIndex(rest);
  const answer = final >= 0 ? rest[final] : undefined;
  const missing = noPlan(rest);
  const proposed = [...rest].reverse().find(proposedPlan);
  return portableTaskRecord({
    ...(evidence !== undefined ? { contextEvidence: copyTaskContextEvidence(evidence) } : {}),
    title: opts.title, threadId: opts.threadId, request: user?.kind === "user" ? user.text : "",
    ...(plan?.kind === "plan" ? { plan: { steps: plan.steps, from: plan.from, revision: plan.revision } } : {}),
    ...(proposed?.kind === "assistant" ? { proposedPlan: proposed.text.trim() } : {}),
    ...(missing ? { noPlan: missing } : {}),
    files: evidence === undefined ? [...files] : context.files.filter(file => file.relations.includes("changed")).map(file => file.path), outsideFiles, commands, clarifications, verification: verification(rest, evidence), context,
    ...(answer?.kind === "assistant" && answer !== proposed && answer.text.trim() ? { answer: answer.text.trim() } : {}),
  });
}

export const PROPOSED_WORDS = "Codex proposed this plan in plan mode. Its steps have no statuses.";
const STEP_WORDS: Record<PlanStep["status"], string> = { pending: "not started", "in-progress": "in progress", completed: "reported done", unknown: "status unknown" };
const FROM_WORDS: Record<PlanSource, string> = { "codex-plan": "Codex's plan", "claude-todo": "Claude's todo list", "claude-tasks": "Claude's task list", "acp-plan": "The agent's plan" };

/** The record as portable Markdown for a note. */
export function taskMarkdown(record: TaskRecord, options: { fullContext?: boolean } = {}): string {
  record = portableTaskRecord(record);
  const evidence = record.contextEvidence === undefined ? undefined : copyTaskContextEvidence(record.contextEvidence);
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
    if (evidence) lines.push(`${record.files.length} project ${record.files.length === 1 ? "file" : "files"} changed; recorded relations are in Context references below.`);
    else for (const file of record.files) lines.push(`- \`${file}\``);
    if (record.outsideFiles) lines.push(`- ${record.outsideFiles} ${record.outsideFiles === 1 ? "file" : "files"} outside the project (not named)`);
    lines.push("");
  }
  const context = record.context;
  const unlisted = context?.unlisted ?? [];
  if (context && ((!evidence && context.files.length) || context.outside || unlisted.length)) {
    lines.push("## Files the turn touched", "", "As the CLI reported them. Modex did not index the project.", "");
    if (!evidence) {
      for (const file of (options.fullContext ? context.files : context.files.slice(0, CONTEXT_SHOWN))) lines.push(`- \`${file.path}\` — ${file.relations.join(", ")}`);
      if (!options.fullContext && context.files.length > CONTEXT_SHOWN) lines.push(`- and ${context.files.length - CONTEXT_SHOWN} more`);
    }
    if (context.outside) lines.push(`- ${context.outside} outside the project (not named)`);
    if (context.files.length || context.outside) lines.push("");
    if (unlisted.length) {
      lines.push(UNLISTED_WORDS, "");
      for (const [index, command] of (options.fullContext ? unlisted : unlisted.slice(0, CONTEXT_SHOWN)).entries()) {
        const omission = context.unlistedOmissions?.find(row => row.index === index)?.omission;
        lines.push(`- ${omission ? omittedCommandLabel(omission) : `\`${command.replace(/`/g, "'")}\``}`);
      }
      if (!options.fullContext && unlisted.length > CONTEXT_SHOWN) lines.push(`- and ${unlisted.length - CONTEXT_SHOWN} more`);
      lines.push("");
    }
  }
  if (evidence?.refs.length) {
    const captures = new Map(evidence.captures.map(capture => [capture.id, capture]));
    const refs = options.fullContext ? evidence.refs : evidence.refs.slice(0, CONTEXT_SHOWN);
    lines.push("## Context references", "", "Snapshots record timed observations; process input bytes remain unverified.", "");
    for (const ref of refs) {
      const label = ref.target.kind === "file" ? `File ${contextCode(ref.target.path)}` : ref.target.kind === "note" ? `Note ${contextCode(ref.target.pageId)}` : `Notes file ${contextCode(ref.target.id)}`;
      const relations = [...new Set(ref.relations.map(relation => relation.provenance === "user-confirmed" ? "human-confirmed relevance" : relation.provenance === "model-proposed" ? `model-proposed ${relation.role ?? "relevance"}` : `${relation.provenance} ${relation.kind}`))];
      let row = `- ${label}${relations.length ? ` — ${relations.join("; ")}` : ""}. ${ref.captureIds.length} retained captures.`;
      const capture = ref.captureIds.map(id => captures.get(id)).filter(c => c !== undefined).at(-1);
      if (capture) {
        const revision = capture.revision.state === "available" ? `SHA-256 ${capture.revision.digest}, ${capture.revision.bytes} bytes` : `revision unavailable: ${capture.revision.reason}`;
        row += ` Retained capture: ${capture.phase}, ${capture.startedAt} → ${capture.finishedAt}; ${revision}${capture.noteVersion ? `; Note revision ${capture.noteVersion.revision} (${capture.noteVersion.via})` : ""}.`;
      }
      lines.push(row);
    }
    if (!options.fullContext && evidence.refs.length > CONTEXT_SHOWN) lines.push("", `${evidence.refs.length - CONTEXT_SHOWN} more context references are retained. Use the full record export for every reference and provenance receipt.`);
    else if (!options.fullContext) lines.push("", "Use the full record export for all provenance receipts, captures and check-reference mappings.");
    lines.push("");
  }
  if (record.commands.length) {
    lines.push("## Commands", "");
    for (const command of record.commands) lines.push(`- ${commandLine(command)}`);
    lines.push("");
  }
  const checked = record.verification;
  if (checked && (checked.checks.length || record.files.length || record.outsideFiles)) {
    lines.push("## Verification", "", verificationWords(checked), "");
    if (checked.checks.length) lines.push(...checked.checks.map((check) => `- ${commandLine(check)}${check.stale ? " (ran before a later change)" : ""}`), "");
  }
  if (record.answer) lines.push("## Answer", "", record.answer, "");
  // A check a later fix superseded is settled by what came after it; the verification line says how.
  const superseded = new Set(checked?.checks.filter((check) => check.stale).map((check) => commandKey(check) + "\0" + check.outcome) ?? []);
  const loose = [
    ...record.commands.filter((command) => !SETTLED_WELL.has(command.outcome) && !(checked?.state === "verified" && superseded.has(commandKey(command) + "\0" + command.outcome))).map(commandLine),
    ...(record.plan?.steps.filter((step) => step.status !== "completed").map((step) => `${step.text} (${STEP_WORDS[step.status]})`) ?? []),
    ...clarifications.filter((c) => !c.answer || c.uncertain).map(clarificationLine),
    ...(checked && checked.state !== "verified" && (checked.checks.length || record.files.length || record.outsideFiles) ? [verificationWords(checked)] : []),
  ];
  if (loose.length) lines.push("## Not settled", "", ...loose.map((line) => `- ${line}`), "");
  if (options.fullContext && evidence) lines.push("## Full context provenance", "", "Retained metadata only. Export does not refresh files, execute a check or reconstruct a missing observation.", "", "```json", JSON.stringify(evidence, null, 2), "```", "");
  lines.push("---", `From modex thread ${record.threadId}.`);
  return lines.join("\n") + "\n";
}

/** Quoted data in a code span, including literal backticks and whitespace in filenames. */
function contextCode(value: string): string {
  const quoted = /`|\s/.test(value) ? JSON.stringify(value) : value, ticks = quoted.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(1, ...ticks.map(run => run.length + 1)));
  return `${fence}${quoted}${fence}`;
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
  return `${command.commandOmission ? omittedCommandLabel(command.commandOmission) : `\`${command.command.replace(/`/g, "'")}\``} — ${words[command.outcome]}, ${exit}${command.itemId ? `; source item ${contextCode(command.itemId)}` : ""}`;
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

export function verificationWords(value: TaskVerification): string {
  if (value.basis !== "context-snapshots") return VERIFICATION_WORDS[value.state];
  const words: Record<TaskVerification["state"], string> = {
    verified: "Checks passed for confirmed references with matching timed snapshots. These snapshots do not prove which bytes the check consumed.",
    failed: "A check for confirmed project references did not pass. Timed snapshots do not prove which bytes the check consumed.",
    unknown: "Not verified: project scope, confirmed relevance, exit status or matching timed snapshots are incomplete.",
    stale: "Not verified: a later change or plan revision superseded the check's timed snapshots.",
    none: "Not verified: no check receipt covers the current task context.",
  };
  return words[value.state];
}

/** Tools that change files. `write_file` is the offline engine's. A denied one changed nothing. */
const EDIT_TOOLS = new Set([...PATCH_TOOLS, "write_file"]);

/**
 * What the turn's checks say about its latest change, in transcript order. A check passes only as
 * `succeeded` with exit code 0 or none reported (Claude Code reports none, and its failed commands
 * come through as failed). A check is stale once an edit, or a command that might write files, ran
 * after it: Modex cannot see what an unknown command wrote. Nothing here links a check to a plan
 * step, because neither CLI reports such a link.
 */
export function verification(items: readonly ThreadItem[], supplied?: TaskContextEvidence): TaskVerification {
  const user = items.find(item => item.kind === "user");
  const evidence = supplied ?? (user?.kind === "user" ? user.contextEvidence : undefined);
  const legacy = legacyVerification(items);
  if (evidence === undefined) return legacy;
  const result: TaskVerification = { ...legacy, state: legacy.checks.length ? "unknown" : "none", basis: "context-snapshots" };
  if (!isTaskContextEvidence(evidence)) return result;
  const plan = [...items].reverse().find(item => item.kind === "plan");
  const currentPlan = plan?.kind === "plan" ? plan.revision : undefined;
  const needed = evidence.refs.filter(ref => ref.relations.some(r => r.provenance === "user-confirmed" || (r.kind === "changed" && r.provenance === "observed")));
  const covered = new Set<string>();
  let stale = false, failed = false;
  const sameOrigin = (a: import("./conversation-events.js").ItemOrigin | undefined, b: import("./conversation-events.js").ItemOrigin | undefined) => Boolean(a && b
    && a.thread === b.thread && a.turn === b.turn && a.attempt === b.attempt && a.backend === b.backend && a.account === b.account
    && a.native.runtime === b.native.runtime && a.native.item === b.native.item && a.native.thread === b.native.thread && a.native.turn === b.native.turn && a.native.part === b.native.part);
  for (const check of evidence.checks) {
    const index = items.findIndex(item => item.kind === "tool" && item.id === check.itemId && sameOrigin(item.origin, check.origin));
    const item = items[index];
    if (item?.kind !== "tool" || item.unavailableInputs?.includes("exec.command") || item.exec?.command !== check.command || !isCheckCommand(check.command)) continue;
    if (check.scope !== "project" || check.relevance !== "user-confirmed" || !check.relevantRefIds.length) continue;
    // A later write can affect a reference even when no native file-change item named it.
    const laterWriter = items.slice(index + 1).some(later => later.kind === "tool" && later.outcome !== "denied"
      && (EDIT_TOOLS.has(later.name) || Boolean(later.exec?.command && mayWrite(later.exec.command))));
    if (laterWriter || check.staleness === "stale" || check.planRevision !== currentPlan) { stale = true; continue; }
    if (check.outcome === "failed" || check.outcome === "denied" || (typeof check.exitCode === "number" && check.exitCode !== 0)) { failed = true; continue; }
    if (check.outcome !== "succeeded" || check.exitCode !== 0 || item.outcome !== "succeeded" || item.exitCode !== 0 || check.staleness !== "current-observation" || check.eventIds.length < 2 || !check.startedAt || !check.finishedAt) continue;
    const captures = new Map(evidence.captures.map(c => [c.id, c]));
    for (const refId of check.relevantRefIds) {
      const ref = evidence.refs.find(ref => ref.id === refId);
      if (!ref) continue;
      const owns = (c: import("./task-context-evidence.js").ContextCapture | undefined, phase: "check-start-observed" | "check-end-observed") => Boolean(c && c.phase === phase && c.source.kind === "native"
        && c.source.itemId === check.itemId && sameOrigin(c.source.origin, check.origin)
        && JSON.stringify(c.target) === JSON.stringify(ref.target) && ref.captureIds.includes(c.id));
      const start = check.startCaptureIds.map(id => captures.get(id)).find(c => owns(c, "check-start-observed"));
      const end = check.endCaptureIds.map(id => captures.get(id)).find(c => owns(c, "check-end-observed"));
      if (!start || !end || start.finishedAt > end.startedAt || (check.startedAt !== undefined && start.startedAt < check.startedAt)
        || (check.finishedAt !== undefined && (start.finishedAt > check.finishedAt || end.startedAt < check.finishedAt))
        || start.revision.state !== "available" || end.revision.state !== "available") continue;
      if (start.revision.digest !== end.revision.digest || start.revision.bytes !== end.revision.bytes || start.revision.noteRevision !== end.revision.noteRevision) { stale = true; continue; }
      const endRevision = end.revision;
      const later = ref.captureIds.map(id => captures.get(id)).filter(c => c && c.startedAt > end.finishedAt && c.noteVersion?.via !== "history");
      if (later.some(c => c!.revision.state === "available" && (c!.revision.digest !== endRevision.digest || c!.revision.bytes !== endRevision.bytes || c!.revision.noteRevision !== endRevision.noteRevision))) { stale = true; continue; }
      if (later.some(c => c!.revision.state !== "available")) continue;
      covered.add(refId);
    }
  }
  result.state = failed ? "failed" : needed.length && needed.every(ref => covered.has(ref.id)) ? "verified" : stale ? "stale" : result.state;
  return result;
}

function legacyVerification(items: readonly ThreadItem[]): TaskVerification {
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
    } else if (outcome !== "denied" && mayWrite(command)) {
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

/** Literal leading cd operations only. Directory-changing tool flags remain unqualified. */
export function checkDirectoryChanges(command: string): string[] | null {
  const parts = segments(command, { checks: true, noWrites: true });
  if (!parts || !isCheckCommand(command)) return null;
  const changes: string[] = [];
  for (const words of parts) {
    if (words[0] === "cd") {
      const dir = words.at(-1)!;
      if (dir === "-" || dir.startsWith("~")) return null;
      changes.push(dir);
    } else if (words.some(word => /^(?:-C|--(?:cwd|dir|directory|prefix))(?:=|$)/.test(word) || /^-C.+/.test(word))) return null;
  }
  return changes;
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
function segments(command: string, options: { noWrites?: boolean; checks?: boolean; portable?: boolean } = {}, depth = 0): string[][] | null {
  if (options.portable && depth > 16) return null;
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let quoted = false;
  let portable = true;
  const endWord = () => { if (word || quoted) words.push(word); word = ""; quoted = false; };
  const endSegment = () => { endWord();
    if (options.portable && words.length) {
      const program = (words[0] ?? "").split("/").pop()!;
      const shell = /^(sh|bash|zsh|dash)$/.test(program) && words.length === 3 && /^-l?c$/.test(words[1] ?? "");
      if (!shell && !portableInvocation(words)) portable = false;
      if (words.some((word, index) => !(shell && index === 2) && !portableWord(word, index === 0, program === "printf" && index > 0, (program === "printf" || program === "echo") && index > 0))) portable = false;
      if ((/^node(?:js)?$/.test(program) && words.slice(1).some(word => /^-[ep]|^--(?:eval|print)(?:=|$)/.test(word)))
        || (/^python[0-9.]*$/.test(program) && words.slice(1).some(word => /^-c|^--command/.test(word)))
        || (/^(perl|ruby)$/.test(program) && words.slice(1).some(word => /^-[^-]*e/.test(word)))
        || /^(cmd|powershell|pwsh)$/.test(program)
        || (program === "env" && words.some(word => word === "-S" || word.startsWith("--split-string")))
        || (program === "sed" && !(words[1] === "-n" && /^\d+(?:,\d+)?p$/.test(words[2] ?? "")))
        || (program === "awk" && !words.includes("-f"))) portable = false;
    }
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift(); if (words.length) out.push(words); words = []; };
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
  if (!portable) return null;
  // `/bin/zsh -lc '<script>'`: the script is the command.
  const result: string[][] = [];
  for (const segment of out) {
    const program = (segment[0] ?? "").split("/").pop()!;
    // Restrict wrappers to common execution forms. In particular, -n/-o noexec only
    // parse the script; their successful receipt says nothing about its checks.
    if (/^(sh|bash|zsh|dash)$/.test(program)) {
      if (segment.length !== 3 || !/^-l?c$/.test(segment[1] ?? "")) return null;
      const inner = segments(segment[2]!, options, depth + 1);
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
/**
 * The files a turn touched inside the project, and how many outside it (counted, never named).
 * `unlisted`: commands that may have changed files no CLI named (a shell redirect, `perl -pi`, `sed -i`),
 * by the rule that makes a check stale. They are listed as commands; Modex does not guess their files.
 * Absent in records saved before it existed.
 */
export interface TaskContext { files: ContextFile[]; outside: number; unlisted?: string[]; unlistedOmissions?: { index: number; omission: CommandOmission }[] }

const portableItemId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 32768 && !/[\\/\u0000-\u001f\u007f]/.test(value);
const commandKey = (command: Pick<TaskCommand, "command" | "commandOmission">) => command.commandOmission ? `omitted:${command.commandOmission.id}` : `text:${command.command}`;
export const omittedCommandLabel = (omission: CommandOmission) => `Recorded command ${omission.id}: text omitted for privacy; result retained`;
function validUnlistedOmissions(context: TaskContext): boolean {
  const rows = context.unlistedOmissions;
  return rows === undefined || (Array.isArray(rows) && rows.every(row => row && Object.keys(row).length === 2 && Object.hasOwn(row, "index") && Object.hasOwn(row, "omission")
    && Number.isSafeInteger(row.index) && row.index >= 0 && context.unlisted?.[row.index] === OMITTED_COMMAND && isCommandOmission(row.omission))
    && new Set(rows.map(row => row.index)).size === rows.length);
}

/** A detached portable view, never a refresh or a new verification calculation. */
export function portableTaskRecord(record: TaskRecord): TaskRecord {
  if (record.contextEvidence !== undefined && !isTaskContextEvidence(record.contextEvidence)) throw new Error("Invalid task context metadata.");
  const automatic = [...record.commands, ...(record.verification?.checks ?? []), ...(record.contextEvidence?.checks ?? [])];
  if (!automatic.every(isTaskCommandText) || (record.context && !validUnlistedOmissions(record.context))) throw new Error("Invalid command omission metadata.");
  const ids = [...automatic.flatMap(c => c.commandOmission ? [c.commandOmission.id] : []), ...(record.context?.unlistedOmissions?.map(row => row.omission.id) ?? [])];
  let next = ids.reduce((max, id) => Math.max(max, id), 0) + 1;
  const omitted = new Map<string, CommandOmission>();
  const project = <T extends { command: string; commandOmission?: CommandOmission }>(command: T): T => {
    if (command.commandOmission || isPortableCommand(command.command)) return command;
    let omission = omitted.get(command.command);
    if (!omission) {
      if (!Number.isSafeInteger(next)) throw new Error("Invalid command omission identity.");
      omission = { id: next++, reason: "privacy" }; omitted.set(command.command, omission);
    }
    return { ...command, command: OMITTED_COMMAND, commandOmission: { ...omission } };
  };
  const result = structuredClone(record);
  result.commands = result.commands.map(project);
  if (result.verification) result.verification.checks = result.verification.checks.map(project);
  if (result.contextEvidence) result.contextEvidence.checks = result.contextEvidence.checks.map(project);
  if (result.context?.unlisted) {
    const old = new Map(result.context.unlistedOmissions?.map(row => [row.index, row.omission]));
    const rows: NonNullable<TaskContext["unlistedOmissions"]> = [];
    result.context.unlisted = result.context.unlisted.map((command, index) => {
      const safe = project({ command, ...(old.has(index) ? { commandOmission: old.get(index)! } : {}) });
      if (safe.commandOmission) rows.push({ index, omission: { ...safe.commandOmission } });
      return safe.command;
    });
    if (rows.length) result.context.unlistedOmissions = rows;
  }
  return result;
}

/** Classify retained text only. Ambiguous syntax is withheld, never resolved with a shell or filesystem. */
function isPortableCommand(command: string): boolean {
  if (!command || command.length > 8192 || /[\u0000-\u001f\u007f]|(?:^|[^A-Za-z0-9_])[A-Za-z]:[\\/]|%[0-9a-f]{2}/i.test(command)) return false;
  const parsed = segments(command, { portable: true });
  return parsed !== null && parsed.length > 0;
}
// Portable text has a deliberately positive grammar. Unknown programs and inline
// interpreter forms are not classified by an ever-growing list of script flags.
const PORTABLE_PROGRAMS = new Set(["pnpm", "npm", "yarn", "bun", "npx", "git", "cat", "head", "tail", "wc", "ls", "rg", "grep", "find", "tree", "sort", "uniq", "sed", "printf", "echo", "touch", "mkdir", "rm", "rmdir", "cp", "mv", "true", "false", "exit", "test", "pwd", "cd", "make", "cmake", "ninja", "cargo", "go", "rustc", "cc", "gcc", "clang", "tsc", "vitest", "jest", "playwright", "eslint", "prettier"]);
function portableInvocation(words: string[], depth = 0): boolean {
  if (depth > 16) return false;
  const program = words[0] ?? "";
  // Inline-source switches are unclassified even when reached through a utility
  // such as find. Safe shell wrappers are handled separately by recursive parsing.
  if (words.slice(1).some(word => /^--(?:eval|execute|command)(?:=|$)|^-[eEc]/.test(word))) return false;
  if (program === "npx") return portableInvocation(words.slice(words[1] === "--" ? 2 : 1), depth + 1);
  if (["pnpm", "npm", "yarn", "bun"].includes(program)) {
    let at = 1;
    while (words[at]?.startsWith("-")) {
      if (["--filter", "-F"].includes(words[at]!)) { if (!words[at + 1]) return false; at += 2; }
      else if (["--silent", "-s", "--recursive", "-r", "--workspace-root", "-w", "--offline", "--frozen-lockfile"].includes(words[at]!)) at++;
      else return false;
    }
    const action = words[at++];
    if (action === "exec") return portableInvocation(words.slice(words[at] === "--" ? at + 1 : at), depth + 1);
    if (action === "run" || action === "run-script") return /^(?:build|test|lint|typecheck|check|format|verify)(?::[A-Za-z0-9_-]+)*$/.test(words[at] ?? "");
    return /^(?:build|test|lint|typecheck|check|format|verify)(?::[A-Za-z0-9_-]+)*$/.test(action ?? "")
      || ["install", "ci", "fetch", "update", "outdated", "list", "why", "audit", "pack", "publish", "prune", "dedupe"].includes(action ?? "");
  }
  if (PORTABLE_PROGRAMS.has(program)) return true;
  // A named relative script is a reference, not embedded source. Options before
  // it and inline/-m modes stay unclassified rather than guessing their grammar.
  const scripts = /^(?:node(?:js)?|python[0-9.]*|ruby|perl|lua|php)$/;
  return scripts.test(program) && /^[A-Za-z0-9_./-]+\.(?:[cm]?js|ts|py|rb|pl|lua|php)$/.test(words[1] ?? "")
    && !words.slice(2).some(word => /^--?(?:eval|execute|command|[eEc])(?:=|$)/.test(word));
}
function portableWord(word: string, executable: boolean, printfFormat = false, literalData = false): boolean {
  if (executable && /^\/(?:usr\/)?bin\/(?:sh|bash|zsh|dash)$/.test(word)) return true;
  // Compact option values and response-file operands have tool-specific boundaries.
  // Do not mistake -I/private or @/private for ordinary relative path words.
  if ((word.startsWith("-") && /[\\/]/.test(word)) || /^@[\\/~]/.test(word)) return false;
  // Format escapes/substitutions can move a slash to an absolute-path boundary.
  // Keep static text/redirects, but do not classify path-bearing printf operands.
  if (printfFormat && word.includes("/")) return false;
  if (/^https?:\/\//i.test(word)) {
    try { const url = new URL(word); return !url.username && !url.password && !url.search && !url.hash && /^[A-Za-z0-9:/.~_-]+$/.test(word); } catch { return false; }
  }
  // Opaque multiword arguments can be another program's source. Only the two
  // literal-output utilities classify spaces as data; other quoted forms omit.
  if (!literalData && /\s/.test(word)) return false;
  if (!(printfFormat ? /^(?:[A-Za-z0-9_@.,:+%=~ /-]|\\[abefnrtv\\])*$/ : /^(?:[A-Za-z0-9_@.:+=~ /-]*|\d+(?:,\d+)?p)$/).test(word)) return false;
  return !/(?:^|[\s=:])(?:[\\/]|~)|(?:^|[^A-Za-z0-9_.\/-])\/|(?:^|[=/])\.\.(?:\/|$)|file:|[()[\]{}$`;|&]|^[A-Za-z_][A-Za-z0-9_]*=|^--?(?:token|secret|password|api[-_]?key|auth)|\bauthorization\b|\bbearer\b/i.test(word);
}

/** Tools that read one file, and the argument that names it. */
const READ_ARGS: Record<string, string> = { Read: "file_path", read_file: "path", NotebookRead: "notebook_path" };
/** Tools that search or list under a path. */
const SEARCH_ARGS: Record<string, string> = { Grep: "path", Glob: "path", LS: "path", list_dir: "path" };

/**
 * The project files a turn touched, by what the CLI reported (docs/task-context.md#context-map): files
 * its patch tools changed, files it read (Claude's Read, Codex's own parse of a command), and paths it
 * searched or listed. Denied tools are excluded; failed tools do not establish named file relations. A
 * failed command can still have written before failing. Nothing is inferred: a `cat` through a
 * shell that the CLI did not parse is not counted, and no dependency is guessed. Changed files come
 * first, then read, then searched, each in the order the turn first touched them. A command that may
 * have written files without naming them is listed in `unlisted`, once, so the map never reads as complete
 * when it might not be.
 */
export function taskContext(items: readonly ThreadItem[], cwd: string, evidence?: TaskContextEvidence): TaskContext {
  const files = new Map<string, ContextFile>();
  const outsidePaths = new Set<string>();
  const unlisted: string[] = [];
  type Relation = TaskContextEvidence["refs"][number]["relations"][number];
  const native = new Map<string, { relation: Relation; path: string }[]>();
  for (const user of items) {
    if (user.kind !== "user") continue;
    const context = evidence ?? user.contextEvidence;
    if (!context || !isTaskContextEvidence(context)) continue;
    for (const ref of context.refs) for (const relation of ref.relations) {
      if (ref.target.kind !== "file" || relation.source.kind !== "native" || relation.source.origin.turn !== user.id) continue;
      const rows = native.get(relation.source.itemId) ?? [];
      rows.push({ relation, path: ref.target.path }); native.set(relation.source.itemId, rows);
    }
  }
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
    if (outcome === "denied") continue;
    const command = item.exec?.command;
    // A failed command can have written before failing; keep that uncertainty without guessing paths.
    if (command && !EDIT_TOOLS.has(item.name) && mayWrite(command) && !unlisted.includes(command)) unlisted.push(command);
    if (outcome === "failed") continue;
    const recorded = (native.get(item.id) ?? []).filter(({ relation }) => {
      if (relation.source.kind !== "native" || !item.origin) return false;
      const a = relation.source.origin, b = item.origin;
      return a.thread === b.thread && a.turn === b.turn && a.attempt === b.attempt && a.backend === b.backend && a.account === b.account
        && a.native.runtime === b.native.runtime && a.native.item === b.native.item && a.native.thread === b.native.thread && a.native.turn === b.native.turn && a.native.part === b.native.part;
    });
    if (recorded.length) {
      for (const { relation, path } of recorded) if (relation.provenance === "observed" && relation.kind !== "relevant") add(path, relation.kind);
      continue;
    }
    if (item.displayOnlyInputs) continue;
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
  return { files: ordered, outside: outsidePaths.size, ...(unlisted.length ? { unlisted } : {}) };
}

/** Whether a command may have written files: neither a check nor known to be read-only (the rule that makes a check stale). */
export function mayWrite(command: string): boolean {
  return !isCheckCommand(command) && !isReadOnlyCommand(command);
}

/** How a context map's files read in a label: "3", "3, maybe more" when a command may have changed others, "not listed". */
export function contextCount(context: TaskContext): string {
  const more = (context.unlisted?.length ?? 0) > 0;
  if (!context.files.length && more) return "not listed";
  return `${context.files.length}${more ? ", maybe more" : ""}`;
}

/** The words before the commands a context map could not resolve to files. */
export const UNLISTED_WORDS = "These commands may have changed files that neither the CLI nor Modex named:";
