import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BackendId, Thread, ThreadItem, ThreadStatus } from "../../shared/types.js";
import type { Routine, RoutineDraft, RoutineRun, RoutineRunTrigger, RoutinesState, RoutineTrigger } from "../../shared/routines.js";
import type { CreateSpacePage, SpaceChangeContext, SpacePage, SpacePageVersion } from "../../shared/space.js";

/**
 * Routines Phase 1 (docs/routines.md, docs/specs/2026-10-11-modex-routines-spec.md). A routine runs a
 * read-only Chat or Plan turn in one project when its time trigger fires, while Modex is running
 * with or without a window. Modex writes the turn's reply to a Space page in that project's notes
 * and records each run for Activity.
 *
 * The rules this file keeps:
 * - A saved routine grants nothing. Each run checks the routine as it is at that moment, and the
 *   runner refuses every approval while the turn runs.
 * - Missed due times (asleep, or Modex quit) run once when noticed, never one run per miss. The next
 *   due time moves on before a run starts, so a crash never repeats one.
 * - A run Modex was killed during is marked interrupted on the next start and never re-run. A run is
 *   its page revision's idempotency key: a page already written by that run is found, not repeated.
 * - Only the run's owner may finish it (the fence): a routine deleted or a Modex quitting mid-run
 *   leaves the run interrupted and writes no page.
 */

export const MIN_INTERVAL_MINUTES = 5;
export const RUN_TIMEOUT_MS = 30 * 60_000;
export const RUNS_KEPT = 200;
/** A run that starts more than this after its due time is labelled missed. */
export const MISSED_AFTER_MS = 2 * 60_000;
const TICK_MS = 30_000;
const UNIT_MS = { minutes: 60_000, hours: 60 * 60_000, days: 24 * 60 * 60_000 } as const;
const MAX_INTERVAL = 10_000;

/**
 * The first due time strictly after `after`; null when a one-time trigger is past. Days are local
 * calendar days, so a 9:00 routine stays at 9:00 across a daylight-saving change.
 */
export function nextDue(trigger: RoutineTrigger, after: number): number | null {
  if (trigger.kind === "once") {
    const at = Date.parse(trigger.at);
    return at > after ? at : null;
  }
  const from = Date.parse(trigger.from);
  if (after < from) return from;
  if (trigger.unit === "days") {
    const step = (n: number) => { const date = new Date(from); date.setDate(date.getDate() + n * trigger.every); return date.getTime(); };
    let n = Math.max(0, Math.floor((after - from) / (trigger.every * UNIT_MS.days)) - 1);
    while (step(n) <= after) n++;
    return step(n);
  }
  const period = trigger.every * UNIT_MS[trigger.unit];
  return from + (Math.floor((after - from) / period) + 1) * period;
}

const iso = (ms: number) => new Date(ms).toISOString();

function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${name} must be 1–${max.toLocaleString("en-US")} characters.`);
  return value.trim();
}

function time(value: unknown, name: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Choose a valid ${name}.`);
  return new Date(Date.parse(value)).toISOString();
}

/** Checks a draft from the editor. Routines can only be read-only, so no other mode passes. */
export function validateRoutine(raw: unknown, projectExists: (id: string) => boolean): RoutineDraft {
  if (!raw || typeof raw !== "object") throw new Error("Invalid routine.");
  const draft = raw as Record<string, unknown>;
  const name = text(draft.name, "Name", 80);
  const instructions = text(draft.instructions, "Instructions", 20_000);
  if (typeof draft.projectId !== "string" || !projectExists(draft.projectId)) throw new Error("Choose a project for the routine.");
  if (draft.mode !== "chat" && draft.mode !== "plan") throw new Error("Routines run read-only: choose Chat or Plan.");
  if (draft.backend !== undefined && draft.backend !== "codex" && draft.backend !== "claude" && draft.backend !== "mock") throw new Error("Choose a valid provider.");
  if (draft.model !== undefined && (typeof draft.model !== "string" || draft.model.length > 200)) throw new Error("Invalid model.");
  if (typeof draft.enabled !== "boolean") throw new Error("Invalid enabled flag.");
  const trigger = draft.trigger as Record<string, unknown> | undefined;
  let parsed: RoutineTrigger;
  if (trigger?.kind === "once") parsed = { kind: "once", at: time(trigger.at, "time") };
  else if (trigger?.kind === "interval") {
    const unit = trigger.unit;
    if (unit !== "minutes" && unit !== "hours" && unit !== "days") throw new Error("Choose minutes, hours or days.");
    const every = trigger.every;
    if (typeof every !== "number" || !Number.isInteger(every) || every < 1 || every > MAX_INTERVAL) throw new Error("Repeat every 1 or more.");
    if (every * UNIT_MS[unit] < MIN_INTERVAL_MINUTES * UNIT_MS.minutes) throw new Error(`Repeat at most every ${MIN_INTERVAL_MINUTES} minutes.`);
    parsed = { kind: "interval", every, unit, from: time(trigger.from, "start time") };
  } else throw new Error("Choose when the routine runs.");
  if (draft.id !== undefined && (typeof draft.id !== "string" || !/^[a-f0-9-]{36}$/.test(draft.id))) throw new Error("Invalid routine id.");
  return {
    ...(draft.id ? { id: draft.id as string } : {}),
    name, instructions, projectId: draft.projectId, mode: draft.mode, enabled: draft.enabled, trigger: parsed,
    ...(draft.backend ? { backend: draft.backend as BackendId } : {}),
    ...(typeof draft.model === "string" && draft.model.trim() ? { model: draft.model.trim() } : {}),
  };
}

interface RoutinesFile { version: 1; routines: Routine[]; runs: RoutineRun[] }

/**
 * `app/routines.json`: read once, replaced atomically on every change. A file that can't be read is
 * left as it is: routines are then unavailable, and nothing is written over it.
 */
export class RoutineFile {
  private data: RoutinesFile = { version: 1, routines: [], runs: [] };
  readonly error?: string;
  constructor(readonly file: string) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RoutinesFile;
      if (parsed?.version !== 1 || !Array.isArray(parsed.routines) || !Array.isArray(parsed.runs)) throw new Error("Unsupported routines file.");
      this.data = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.error = `Routines could not be read, so the file was left as it is. ${(error as Error).message}`;
    }
  }
  get routines(): Routine[] { return this.data.routines; }
  get runs(): RoutineRun[] { return this.data.runs; }
  set runs(runs: RoutineRun[]) { this.data.runs = runs; }
  save(): void {
    if (this.error) throw new Error(this.error);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}

/** The part of the notes store a routine writes through: the same revision-checked pages the Pages MCP uses. */
export interface RoutineNotes {
  linkProject(project: { id: string; name: string; path: string }): { id: string };
  tree(): { nodes: { id: string; kind: string; parentId: string | null; name: string }[] };
  createFolder(parentId: string, name: string): { id: string };
  list(): SpacePage[];
  history(id: string): SpacePageVersion[];
  create(input: CreateSpacePage, change?: SpaceChangeContext): SpacePage;
  save(input: SpacePage, change?: SpaceChangeContext): SpacePage;
}

export const ROUTINES_FOLDER = "Routines";
const summaryFor = (run: Pick<RoutineRun, "id">) => `Routine run ${run.id}`;

/** Writes a routine's page in its project's notes, under Routines/, one revision per run. */
export class RoutinePages {
  constructor(private readonly notes: RoutineNotes) {}

  /** The revision this run already wrote, if it got that far. */
  find(routine: Pick<Routine, "name" | "pageId">, run: Pick<RoutineRun, "id">): RoutineRun["page"] {
    const summary = summaryFor(run);
    for (const page of this.notes.list()) {
      if (page.id !== routine.pageId && page.title !== routine.name) continue;
      const version = this.notes.history(page.id).find((v) => v.summary === summary);
      if (version) return { id: page.id, title: version.page.title, revision: version.page.revision };
    }
    return undefined;
  }

  write(routine: Routine, run: RoutineRun, project: { id: string; name: string; path: string }, markdown: string): NonNullable<RoutineRun["page"]> {
    const written = this.find(routine, run);
    if (written) return written;
    const change = { actor: `Routine: ${routine.name}`.slice(0, 200), summary: summaryFor(run) };
    const current = routine.pageId ? this.notes.list().find((page) => page.id === routine.pageId && !page.trashedAt) : undefined;
    const page = current
      ? this.notes.save({ ...current, markdown }, change)
      : this.notes.create({ containerId: this.folder(project), title: routine.name, markdown }, change);
    return { id: page.id, title: page.title, revision: page.revision };
  }

  private folder(project: { id: string; name: string; path: string }): string {
    const notesProject = this.notes.linkProject(project);
    const existing = this.notes.tree().nodes.find((node) => node.kind === "folder" && node.parentId === notesProject.id && node.name === ROUTINES_FOLDER);
    return existing?.id ?? this.notes.createFolder(notesProject.id, ROUTINES_FOLDER).id;
  }
}

/** What the scheduler needs from the rest of Modex. */
export interface RoutineHost {
  project(id: string): { id: string; name: string; path: string } | undefined;
  createThread(projectId: string, routine: { id: string; name: string; runId: string; plan: boolean; backend?: BackendId; model?: string }): Promise<Thread>;
  /** Runs one read-only turn and resolves when it ends, saying whether it completed; approvals are refused meanwhile. */
  sendUnattended(threadId: string, text: string): Promise<{ completed: boolean }>;
  stop(threadId: string): void;
  items(threadId: string): ThreadItem[];
  status(threadId: string): ThreadStatus;
  addNotice(threadId: string, level: "info" | "warn" | "error", text: string): void;
  pages: Pick<RoutinePages, "find" | "write">;
  /** Routines or runs changed. */
  changed?(): void;
  /** A run started or ended: keep the Mac from suspending Modex meanwhile, tell the phone. */
  runStarted?(run: RoutineRun): void;
  runEnded?(run: RoutineRun): void;
}

const TRIGGER_LABEL: Record<RoutineRunTrigger, string> = { schedule: "scheduled", missed: "missed", manual: "manual" };

export class RoutineScheduler {
  private readonly file: RoutineFile;
  /** Names this Modex process. A running run owned by another one was cut off by a quit or crash. */
  readonly owner = `${process.pid}-${crypto.randomUUID()}`;
  private readonly owners = new Map<string, string>();
  /** Routine id → its run in progress. */
  private readonly active = new Map<string, { runId: string; threadId?: string }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  /** Fires at the next due time when that comes before the next regular check. */
  private soon: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private disposed = false;
  /** When the last check ran. A due time no check saw (asleep, quit) is a missed run. */
  private lastCheck = 0;

  constructor(home: string, private readonly host: RoutineHost, private readonly now: () => number = Date.now, private readonly limits: { runTimeoutMs?: number; stopGraceMs?: number } = {}) {
    this.file = new RoutineFile(path.join(home, "app", "routines.json"));
  }

  /** Settle runs a previous process left running, then check for due routines now and every 30 s. */
  start(): void {
    if (this.file.error) { console.error("[modex]", this.file.error); return; }
    let changed = false;
    for (const run of this.file.runs) {
      if (run.status !== "running" || this.owners.has(run.id)) continue;
      const routine = this.file.routines.find((r) => r.id === run.routineId);
      let page: RoutineRun["page"];
      // Notes that can't be read leave the run interrupted rather than stopping every routine.
      try { page = this.host.pages.find({ name: run.routineName, pageId: routine?.pageId }, run); }
      catch (error) { console.error("[modex] a routine run's page could not be checked:", error); }
      Object.assign(run, page
        ? { status: "completed", page, endedAt: iso(this.now()) }
        : { status: "interrupted", endedAt: iso(this.now()), error: "Modex quit while this run was working." });
      if (page && routine && !routine.pageId) routine.pageId = page.id;
      changed = true;
    }
    this.started = true;
    if (changed) {
      try { this.persist(); } catch (error) { console.error("[modex] routines could not be saved:", error); }
    }
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.tick();
  }

  /** On wake or any other moment worth a look. Timers call this, so it never throws. */
  tick(): void {
    try { this.check(); }
    catch (error) { console.error("[modex] routines check failed:", error); }
  }

  private check(): void {
    if (this.disposed || !this.started) return;
    const now = this.now();
    const lastCheck = this.lastCheck;
    this.lastCheck = now;
    for (const routine of this.file.routines) {
      if (!routine.enabled || !routine.nextRunAt || Date.parse(routine.nextRunAt) > now || this.active.has(routine.id)) continue;
      const due = routine.nextRunAt;
      // Move on before running: however many due times passed, this is one run, and a crash during
      // it never repeats it.
      routine.nextRunAt = routine.trigger.kind === "once" ? null : iso(nextDue(routine.trigger, now)!);
      this.persist();
      // Missed: late, and no check saw it come due. A due time that waited on the previous run is not.
      const missed = now - Date.parse(due) > MISSED_AFTER_MS && Date.parse(due) > lastCheck;
      this.execute(routine, missed ? "missed" : "schedule", due);
    }
    this.arm();
  }

  private arm(): void {
    clearTimeout(this.soon);
    this.soon = undefined;
    if (!this.started || this.disposed) return;
    const due = this.file.routines.filter((r) => r.enabled && r.nextRunAt && !this.active.has(r.id)).map((r) => Date.parse(r.nextRunAt!));
    const delay = Math.min(...due) - this.now();
    if (!Number.isFinite(delay) || delay > TICK_MS) return;
    this.soon = setTimeout(() => this.tick(), Math.max(0, delay) + 25);
    this.soon.unref?.();
  }

  list(): RoutinesState {
    return structuredClone({ routines: this.file.routines, runs: this.file.runs, ...(this.file.error ? { error: this.file.error } : {}) });
  }

  save(draft: RoutineDraft): Routine {
    const now = this.now();
    const existing = draft.id ? this.file.routines.find((r) => r.id === draft.id) : undefined;
    if (draft.id && !existing) throw new Error("This routine no longer exists.");
    const retimed = !existing || JSON.stringify(existing.trigger) !== JSON.stringify(draft.trigger);
    const next = (trigger: RoutineTrigger) => trigger.kind === "once" ? trigger.at : iso(nextDue(trigger, now - 1)!);
    // Resuming starts from the next due time: due times passed while paused are not missed runs.
    const resumed = existing && !existing.enabled && draft.enabled && draft.trigger.kind === "interval";
    const routine: Routine = {
      id: existing?.id ?? crypto.randomUUID(),
      name: draft.name, projectId: draft.projectId, instructions: draft.instructions, mode: draft.mode,
      ...(draft.backend ? { backend: draft.backend } : {}), ...(draft.model ? { model: draft.model } : {}),
      trigger: draft.trigger, enabled: draft.enabled,
      createdAt: existing?.createdAt ?? iso(now), updatedAt: iso(now),
      ...(existing?.pageId && existing.projectId === draft.projectId ? { pageId: existing.pageId } : {}),
      nextRunAt: retimed || resumed ? next(draft.trigger) : existing!.nextRunAt,
    };
    const index = existing ? this.file.routines.indexOf(existing) : this.file.routines.length;
    this.file.routines.splice(index, existing ? 1 : 0, routine);
    try { this.persist(); }
    catch (error) {
      this.file.routines.splice(index, 1, ...(existing ? [existing] : []));
      throw error;
    }
    // Saved: a failure to start a due run must not read as a failed save, or a retry would duplicate it.
    this.tick();
    return structuredClone(routine);
  }

  /** Deleting a routine stops its run in progress; its past runs stay in Activity. */
  remove(id: string): void {
    const index = this.file.routines.findIndex((r) => r.id === id);
    if (index < 0) return;
    this.file.routines.splice(index, 1);
    const active = this.active.get(id);
    if (active) {
      this.finish(active.runId, { status: "interrupted", error: "The routine was deleted while it ran." });
      if (active.threadId) this.host.stop(active.threadId);
    }
    this.persist();
  }

  /** Run now. It leaves the schedule as it was. */
  async runNow(id: string): Promise<RoutineRun> {
    const routine = this.file.routines.find((r) => r.id === id);
    if (!routine) throw new Error("This routine no longer exists.");
    if (this.active.has(id)) throw new Error("This routine is already running.");
    const run = this.begin(routine, "manual");
    this.background(routine.id, run.id);
    return structuredClone(run);
  }

  /** Quitting: runs in progress end interrupted and write nothing. */
  dispose(): void {
    if (this.disposed) return;
    for (const [, active] of this.active) this.finish(active.runId, { status: "interrupted", error: "Modex quit while this run was working." });
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.soon);
  }

  private execute(routine: Routine, trigger: RoutineRunTrigger, scheduledFor: string): void {
    const run = this.begin(routine, trigger, scheduledFor);
    this.background(routine.id, run.id);
  }

  /** A run works on its own; even a failure to record its end must not escape as an unhandled rejection. */
  private background(routineId: string, runId: string): void {
    this.work(routineId, runId).catch((error) => console.error("[modex] routine run could not be recorded:", error));
  }

  private begin(routine: Routine, trigger: RoutineRunTrigger, scheduledFor?: string): RoutineRun {
    const run: RoutineRun = { id: crypto.randomUUID(), routineId: routine.id, routineName: routine.name, projectId: routine.projectId, trigger, ...(scheduledFor ? { scheduledFor } : {}), startedAt: iso(this.now()), status: "running" };
    const runs = this.file.runs;
    this.file.runs = [run, ...runs].slice(0, RUNS_KEPT);
    try { this.persist(); }
    catch (error) {
      this.file.runs = runs;
      throw error;
    }
    this.owners.set(run.id, this.owner);
    this.active.set(routine.id, { runId: run.id });
    this.host.runStarted?.(structuredClone(run));
    return run;
  }

  private async work(routineId: string, runId: string): Promise<void> {
    let threadId: string | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // A saved routine grants nothing: check it as it is now.
      const routine = this.file.routines.find((r) => r.id === routineId);
      if (!routine) throw new Error("The routine was deleted.");
      if (routine.mode !== "chat" && routine.mode !== "plan") throw new Error("Routines run read-only; this one is not Chat or Plan.");
      const project = this.host.project(routine.projectId);
      if (!project) throw new Error("The routine's project is no longer in Modex.");
      const run = this.run(runId)!;
      const thread = await this.host.createThread(project.id, { id: routine.id, name: routine.name, runId, plan: routine.mode === "plan", ...(routine.backend ? { backend: routine.backend } : {}), ...(routine.model ? { model: routine.model } : {}) });
      threadId = thread.id;
      if (!this.owns(runId)) return this.host.stop(thread.id);
      this.active.set(routineId, { runId, threadId });
      this.update(runId, { threadId });
      this.host.addNotice(thread.id, "info", `Routine “${routine.name}” · ${TRIGGER_LABEL[run.trigger]} run · read-only ${routine.mode === "plan" ? "Plan" : "Chat"}. Approvals are refused while it runs.`);
      const limit = this.limits.runTimeoutMs ?? RUN_TIMEOUT_MS;
      timeout = setTimeout(() => {
        // The run ends now, whatever the CLI does; a second stop forces a CLI that ignored the first.
        this.finish(runId, { status: "failed", error: `The run took longer than ${Math.round(limit / 60_000)} minutes and was stopped.` });
        this.host.stop(thread.id);
        setTimeout(() => this.host.stop(thread.id), this.limits.stopGraceMs ?? 10_000).unref?.();
      }, limit);
      timeout.unref?.();
      const turn = await this.host.sendUnattended(thread.id, routine.instructions);
      clearTimeout(timeout);
      // The fence: a deleted routine, a quitting Modex or the timeout took the run away, so it writes nothing.
      if (!this.owns(runId)) return;
      const items = this.host.items(thread.id);
      if (!turn.completed) {
        if (this.host.status(thread.id) === "error") throw new Error(lastError(items) ?? "The turn failed.");
        this.host.addNotice(thread.id, "warn", "Routine run interrupted: the turn was stopped before it finished, so no page was written.");
        return this.finish(runId, { status: "interrupted", error: "The turn was stopped before it finished." });
      }
      const reply = lastReply(items);
      if (!reply) throw new Error("The turn ended without a reply.");
      // The page belongs to the project the run worked in. A routine moved to another project mid-run
      // keeps its new page; this run writes to the one it started with.
      const runProject = this.host.project(this.run(runId)!.projectId);
      if (!runProject) throw new Error("The routine's project is no longer in Modex.");
      const latest = this.file.routines.find((r) => r.id === routineId);
      const writer = latest && latest.projectId === runProject.id ? latest : routine;
      const page = this.host.pages.write(writer, this.run(runId)!, runProject, pageMarkdown(writer, this.run(runId)!, reply));
      if (!this.owns(runId)) return;
      if (writer === latest && latest.pageId !== page.id) latest.pageId = page.id;
      this.finish(runId, { status: "completed", page });
      this.host.addNotice(thread.id, "info", `Saved to the Space page “${page.title}”, revision ${page.revision}.`);
    } catch (error) {
      clearTimeout(timeout);
      const message = (error as Error).message || "The run failed.";
      if (threadId && this.owns(runId)) this.host.addNotice(threadId, "error", `Routine run failed: ${message}`);
      this.finish(runId, { status: "failed", error: message });
    }
  }

  private run(id: string): RoutineRun | undefined { return this.file.runs.find((r) => r.id === id); }

  private owns(runId: string): boolean {
    return !this.disposed && this.owners.get(runId) === this.owner && this.run(runId)?.status === "running";
  }

  private update(runId: string, patch: Partial<RoutineRun>): void {
    const run = this.run(runId);
    if (!run) return;
    Object.assign(run, patch);
    this.persist();
  }

  private finish(runId: string, patch: Pick<RoutineRun, "status"> & Partial<RoutineRun>): void {
    const run = this.run(runId);
    if (!run || run.status !== "running") return;
    this.owners.delete(runId);
    for (const [routineId, active] of this.active) if (active.runId === runId) this.active.delete(routineId);
    Object.assign(run, patch, { endedAt: iso(this.now()) });
    this.persist();
    this.host.runEnded?.(structuredClone(run));
    this.arm();
  }

  private persist(): void {
    this.file.save();
    this.host.changed?.();
  }
}

/** The reply of the turn: the last assistant message after its user message. */
export function lastReply(items: ThreadItem[]): string | undefined {
  const user = items.map((item) => item.kind).lastIndexOf("user");
  const reply = items.slice(user + 1).filter((item): item is Extract<ThreadItem, { kind: "assistant" }> => item.kind === "assistant" && item.text.trim().length > 0).at(-1);
  return reply?.text.trim();
}

function lastError(items: ThreadItem[]): string | undefined {
  const notice = [...items].reverse().find((item): item is Extract<ThreadItem, { kind: "notice" }> => item.kind === "notice" && item.level === "error");
  return notice?.text;
}

export function pageMarkdown(routine: Pick<Routine, "name" | "mode">, run: Pick<RoutineRun, "trigger" | "startedAt">, reply: string): string {
  return `${reply}\n\n---\n\n*Written by the routine “${routine.name}”: ${TRIGGER_LABEL[run.trigger]} run started ${run.startedAt}, read-only ${routine.mode === "plan" ? "Plan" : "Chat"}.*\n`;
}
