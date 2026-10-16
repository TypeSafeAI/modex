import type { BackendId } from "./types.js";

/**
 * Routines Phase 1 (docs/routines.md): a saved responsibility that Modex runs on a time trigger, as
 * a read-only Chat or Plan turn in one project, writing its result to a Space page.
 */

/** Once at a time, or every `every` units on a grid that starts at `from`. */
export type RoutineTrigger =
  | { kind: "once"; at: string }
  | { kind: "interval"; every: number; unit: RoutineUnit; from: string };
export type RoutineUnit = "minutes" | "hours" | "days";

/** Routines are read-only: Chat, or Chat with the Plan toggle. */
export type RoutineMode = "chat" | "plan";

export interface Routine {
  id: string;
  name: string;
  projectId: string;
  instructions: string;
  mode: RoutineMode;
  /** Absent: the default provider in Settings at the moment the run starts. */
  backend?: BackendId;
  /** Empty: the provider's default model. */
  model?: string;
  trigger: RoutineTrigger;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /** The Space page this routine writes; made by its first completed run. */
  pageId?: string;
  /** When the next scheduled run is due; null once a one-time routine has run. */
  nextRunAt: string | null;
}

/** What the routine editor sends; main fills in the rest. */
export type RoutineDraft = Pick<Routine, "name" | "projectId" | "instructions" | "mode" | "backend" | "model" | "trigger" | "enabled"> & { id?: string };

export type RoutineRunTrigger = "schedule" | "missed" | "manual";
export type RoutineRunStatus = "running" | "completed" | "failed" | "interrupted";

/** One run, as Activity shows it. */
export interface RoutineRun {
  id: string;
  routineId: string;
  /** The routine's name when it ran; runs outlive deleted routines. */
  routineName: string;
  projectId: string;
  trigger: RoutineRunTrigger;
  /** The due time a scheduled or missed run answers. */
  scheduledFor?: string;
  startedAt: string;
  endedAt?: string;
  status: RoutineRunStatus;
  threadId?: string;
  /** The Space page revision the run wrote. */
  page?: { id: string; title: string; revision: number };
  error?: string;
}

export interface RoutinesState { routines: Routine[]; runs: RoutineRun[]; /** Routines are unavailable: their file could not be read. */ error?: string }

export interface RoutineCommands {
  "routines:list": { req: undefined; res: RoutinesState };
  "routines:save": { req: RoutineDraft; res: Routine };
  "routines:delete": { req: { id: string }; res: void };
  "routines:run": { req: { id: string }; res: RoutineRun };
}
