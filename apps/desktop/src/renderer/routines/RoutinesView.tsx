import { useCallback, useEffect, useRef, useState } from "react";
import type { Routine, RoutineDraft, RoutineRun, RoutinesState, RoutineUnit } from "../../shared/routines";
import type { BackendId, Project } from "../../shared/types";
import { bridge } from "../bridge";
import { useRedact } from "../streamer";
import { ErrorNotice } from "../components/ui/ErrorNotice";
import "./routines.css";

/** `datetime-local` speaks local wall time without a zone; main stores ISO instants. */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
const fromLocalInput = (value: string) => new Date(value).toISOString();
const when = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

function schedule(routine: Pick<Routine, "trigger">): string {
  const t = routine.trigger;
  if (t.kind === "once") return `Once, ${when(t.at)}`;
  const unit = t.every === 1 ? t.unit.slice(0, -1) : t.unit;
  return `Every ${t.every === 1 ? "" : `${t.every} `}${unit}, from ${when(t.from)}`;
}

const TRIGGERS: Record<RoutineRun["trigger"], string> = { schedule: "Scheduled", missed: "Missed, run on wake", manual: "Run now" };
const STATUS: Record<RoutineRun["status"], string> = { running: "Running", completed: "Completed", failed: "Failed", interrupted: "Interrupted" };

function blank(projects: Project[]): RoutineDraft {
  const start = new Date(Date.now() + 60 * 60_000);
  start.setMinutes(0, 0, 0);
  return { name: "", projectId: projects[0]?.id ?? "", instructions: "", mode: "chat", trigger: { kind: "interval", every: 1, unit: "days", from: start.toISOString() }, enabled: true };
}

export interface RoutinesViewProps {
  active: boolean;
  projects: Project[];
  onOpenThread(threadId: string): void;
  onOpenPage?(pageId: string): void;
}

/**
 * Routines and their Activity. A routine runs a read-only Chat or Plan turn on a time trigger and
 * writes the reply to a Space page; Activity lists every run with its thread and page revision.
 */
export function RoutinesView({ active, projects, onOpenThread, onOpenPage }: RoutinesViewProps) {
  const redact = useRedact();
  const [state, setState] = useState<RoutinesState | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The operation behind `error`, for its Retry. List errors have none: the list refreshes every 2 s.
  const [failed, setFailed] = useState<{ message: string; operation: () => Promise<unknown> } | null>(null);
  const [editing, setEditing] = useState<RoutineDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++sequence.current;
    try {
      const next = await bridge.invoke("routines:list", undefined);
      if (seq === sequence.current) setState(next);
    } catch (err) { if (seq === sequence.current) setError((err as Error).message); }
  }, []);

  // Runs start and finish on their own, with or without this window; keep Activity current while it shows.
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  const act = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await operation(); await refresh(); }
    catch (err) { const message = (err as Error).message; setError(message); setFailed({ message, operation }); }
    finally { setBusy(false); }
  };

  const project = (id: string) => projects.find((p) => p.id === id)?.name ?? "Removed project";

  return (
    <section className="routines-view" data-testid="routines-view" aria-label="Routines">
      <header className="routines-header">
        <div>
          <div className="routines-eyebrow">ROUTINES</div>
          <h1>Routines</h1>
          <p>Read-only Chat or Plan turns on a timer, while Modex is running, with or without a window. Each run writes its reply to a Space page in the project's notes, under Routines.</p>
        </div>
        <button type="button" data-testid="routine-new" disabled={!projects.length || Boolean(editing)} onClick={() => setEditing(blank(projects))}>New routine</button>
      </header>
      {state?.error && <ErrorNotice className="routines-error" testId="routines-state-error" where="Routines" message={state.error} />}
      {error && <ErrorNotice className="routines-error" testId="routines-error" where="Routines · action" message={error} onRetry={failed?.message === error && !busy ? () => void act(failed.operation) : undefined} onDismiss={() => setError(null)} />}
      {!projects.length && <p className="routines-empty">Add a project first: a routine runs in one project.</p>}
      {editing && (
        <RoutineEditor
          draft={editing} projects={projects} busy={busy}
          onCancel={() => setEditing(null)}
          onSave={(draft) => act(async () => { await bridge.invoke("routines:save", draft); setEditing(null); })}
        />
      )}

      <h2 className="routines-section">Your routines</h2>
      {state && !state.routines.length && <p className="routines-empty">No routines yet.</p>}
      <ul className="routines-list">
        {state?.routines.map((routine) => {
          const running = state.runs.some((run) => run.routineId === routine.id && run.status === "running");
          return (
            <li key={routine.id} className="routine-card" data-testid="routine-row" data-routine-id={routine.id}>
              <div className="routine-card-main">
                <strong>{redact(routine.name)}</strong>
                <span>{redact(project(routine.projectId))} · {routine.mode === "plan" ? "Plan" : "Chat"} (read-only) · {routine.backend === "claude" ? "Claude Code" : routine.backend === "codex" ? "Codex" : routine.backend === "opencode" ? "OpenCode" : routine.backend === "mimo" ? "MiMo Code" : routine.backend === "mock" ? "Mock" : "Default provider"}{routine.model ? ` · ${redact(routine.model)}` : ""}</span>
                <span>{schedule(routine)}</span>
                <span data-testid="routine-next">{!routine.enabled ? "Paused" : running ? "Running now" : routine.nextRunAt ? `Next run ${when(routine.nextRunAt)}` : "Ran; no further runs"}</span>
              </div>
              <div className="routine-actions">
                <button type="button" data-testid="routine-run-now" disabled={busy || running} onClick={() => act(() => bridge.invoke("routines:run", { id: routine.id }))}>Run now</button>
                <button type="button" disabled={busy || Boolean(editing)} onClick={() => setEditing({ id: routine.id, name: routine.name, projectId: routine.projectId, instructions: routine.instructions, mode: routine.mode, trigger: routine.trigger, enabled: routine.enabled, ...(routine.backend ? { backend: routine.backend } : {}), ...(routine.model ? { model: routine.model } : {}) })}>Edit</button>
                <button type="button" disabled={busy} onClick={() => act(() => bridge.invoke("routines:save", { id: routine.id, name: routine.name, projectId: routine.projectId, instructions: routine.instructions, mode: routine.mode, trigger: routine.trigger, enabled: !routine.enabled, ...(routine.backend ? { backend: routine.backend } : {}), ...(routine.model ? { model: routine.model } : {}) }))}>{routine.enabled ? "Pause" : "Resume"}</button>
                <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Delete the routine “${routine.name}”? Its runs stay in Activity, and its page stays in Space.`)) void act(() => bridge.invoke("routines:delete", { id: routine.id })); }}>Delete</button>
              </div>
            </li>
          );
        })}
      </ul>

      <h2 className="routines-section">Activity</h2>
      {state && !state.runs.length && <p className="routines-empty">Runs appear here as they start.</p>}
      {state && state.runs.length > 0 && (
        <table className="routines-activity" data-testid="routines-activity">
          <thead><tr><th>Routine</th><th>Trigger</th><th>Started</th><th>Ended</th><th>Status</th><th>Thread</th><th>Page</th></tr></thead>
          <tbody>
            {state.runs.map((run) => (
              <tr key={run.id} data-testid="activity-row" data-status={run.status}>
                <td>{redact(run.routineName)}</td>
                <td>{TRIGGERS[run.trigger]}{run.scheduledFor && run.trigger !== "manual" ? <small> due {when(run.scheduledFor)}</small> : null}</td>
                <td>{when(run.startedAt)}</td>
                <td>{run.endedAt ? when(run.endedAt) : "—"}</td>
                <td><span className={`routine-status is-${run.status}`}>{STATUS[run.status]}</span>{run.error ? <small className="routine-run-error">{redact(run.error)}</small> : null}</td>
                <td>{run.threadId ? <button type="button" className="routine-link" data-testid="activity-thread" onClick={() => onOpenThread(run.threadId!)}>Open thread</button> : "—"}</td>
                <td>{run.page
                  ? onOpenPage
                    ? <button type="button" className="routine-link" data-testid="activity-page" onClick={() => onOpenPage(run.page!.id)}>{redact(run.page.title)} · revision {run.page.revision}</button>
                    : <span data-testid="activity-page">{redact(run.page.title)} · revision {run.page.revision}</span>
                  : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RoutineEditor({ draft: initial, projects, busy, onSave, onCancel }: { draft: RoutineDraft; projects: Project[]; busy: boolean; onSave(draft: RoutineDraft): void; onCancel(): void }) {
  const [draft, setDraft] = useState(initial);
  const set = (patch: Partial<RoutineDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const trigger = draft.trigger;
  return (
    <form className="routine-editor" data-testid="routine-editor" aria-label={initial.id ? "Edit routine" : "New routine"} onSubmit={(e) => { e.preventDefault(); onSave(draft); }}>
      <label>Name<input data-testid="routine-name" value={draft.name} maxLength={80} required onChange={(e) => set({ name: e.target.value })} /></label>
      <label>Project
        <select data-testid="routine-project" value={draft.projectId} onChange={(e) => set({ projectId: e.target.value })}>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <label>Instructions<textarea data-testid="routine-instructions" value={draft.instructions} maxLength={20_000} required rows={5} placeholder="What should this routine look into and report?" onChange={(e) => set({ instructions: e.target.value })} /></label>
      <fieldset>
        <legend>Mode (always read-only)</legend>
        <label className="routine-inline"><input type="radio" name="routine-mode" data-testid="routine-mode-chat" checked={draft.mode === "chat"} onChange={() => set({ mode: "chat" })} /> Chat</label>
        <label className="routine-inline"><input type="radio" name="routine-mode" data-testid="routine-mode-plan" checked={draft.mode === "plan"} onChange={() => set({ mode: "plan" })} /> Plan</label>
      </fieldset>
      <div className="routine-row">
        <label>Provider
          <select data-testid="routine-backend" value={draft.backend ?? ""} onChange={(e) => { const { backend: _b, ...rest } = draft; setDraft(e.target.value ? { ...rest, backend: e.target.value as BackendId } : rest); }}>
            <option value="">Default provider</option>
            <option value="codex">Codex</option>
            <option value="claude">Claude Code</option>
            <option value="opencode">OpenCode</option>
            <option value="mimo">MiMo Code</option>
          </select>
        </label>
        <label>Model<input data-testid="routine-model" value={draft.model ?? ""} placeholder="Provider default" maxLength={200} onChange={(e) => set({ model: e.target.value })} /></label>
      </div>
      <fieldset>
        <legend>When</legend>
        <label className="routine-inline"><input type="radio" name="routine-when" data-testid="routine-trigger-interval" checked={trigger.kind === "interval"} onChange={() => set({ trigger: { kind: "interval", every: 1, unit: "days", from: trigger.kind === "once" ? trigger.at : trigger.from } })} /> Repeat</label>
        <label className="routine-inline"><input type="radio" name="routine-when" data-testid="routine-trigger-once" checked={trigger.kind === "once"} onChange={() => set({ trigger: { kind: "once", at: trigger.kind === "interval" ? trigger.from : trigger.at } })} /> Once</label>
        {trigger.kind === "interval" ? (
          <div className="routine-row">
            <label>Every<input type="number" min={1} max={10000} data-testid="routine-every" value={trigger.every} onChange={(e) => set({ trigger: { ...trigger, every: Number(e.target.value) } })} /></label>
            <label>Unit
              <select data-testid="routine-unit" value={trigger.unit} onChange={(e) => set({ trigger: { ...trigger, unit: e.target.value as RoutineUnit } })}>
                <option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option>
              </select>
            </label>
            <label>Starting<input type="datetime-local" data-testid="routine-from" value={toLocalInput(trigger.from)} required onChange={(e) => e.target.value && set({ trigger: { ...trigger, from: fromLocalInput(e.target.value) } })} /></label>
          </div>
        ) : (
          <label>At<input type="datetime-local" data-testid="routine-once-at" value={toLocalInput(trigger.at)} required onChange={(e) => e.target.value && set({ trigger: { kind: "once", at: fromLocalInput(e.target.value) } })} /></label>
        )}
      </fieldset>
      <label className="routine-inline"><input type="checkbox" data-testid="routine-enabled" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled</label>
      <p className="routine-note">The turn cannot edit files, and any approval it asks for is refused, since nobody is there to answer. Missed runs, while the Mac slept or Modex was closed, run once when Modex notices.</p>
      <div className="routine-actions">
        <button type="submit" data-testid="routine-save" disabled={busy}>{initial.id ? "Save routine" : "Create routine"}</button>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
