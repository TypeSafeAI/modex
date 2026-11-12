import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Routine, RoutineDraft, RoutineRun, RoutinesState, RoutineUnit } from "../../shared/routines";
import type { BackendId, Project } from "../../shared/types";
import { taskFromText } from "../../shared/routine-text";
import { bridge } from "../bridge";
import { useRedact } from "../streamer";
import { ErrorNotice } from "../components/ui/ErrorNotice";
import { Icon } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../components/ui/Menu";
import { Markdown } from "../components/Markdown";
import type { SpacePage, SpacePageVersion } from "../../shared/space";
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

export interface RoutinesViewProps {
  active: boolean;
  projects: Project[];
  onOpenThread(threadId: string): void;
  onOpenPage?(pageId: string): void;
  /** Asks the app to show a task's thread beside the list (null: show this page's own pane). */
  onShowThread?(threadId: string | null): void;
  /** The app is showing that thread now: this view draws only its list and the thread's header. */
  chatShown?: boolean;
}

/**
 * Scheduled tasks (routines) and their runs. A task runs a read-only Chat or Plan turn on a time trigger and
 * writes the reply to a Space page; Activity lists every run with its thread and page revision.
 */
export function RoutinesView({ active, projects, onOpenThread, onOpenPage, onShowThread, chatShown }: RoutinesViewProps) {
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
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<"tasks" | "activity">("tasks");
  const [listOpen, setListOpen] = useState(true);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"next" | "name">("next");
  const [menu, setMenu] = useState(false);
  const [pausedOpen, setPausedOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);

  const runningIds = new Set((state?.runs ?? []).filter((run) => run.status === "running").map((run) => run.routineId));
  const shown = (state?.routines ?? []).filter((routine) => routine.name.toLowerCase().includes(query.trim().toLowerCase()))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : (a.nextRunAt ?? "9").localeCompare(b.nextRunAt ?? "9") || a.name.localeCompare(b.name));
  const activeTasks = shown.filter((routine) => routine.enabled && (routine.nextRunAt || runningIds.has(routine.id)));
  const pausedTasks = shown.filter((routine) => !routine.enabled);
  const completedTasks = shown.filter((routine) => routine.enabled && !routine.nextRunAt && !runningIds.has(routine.id));
  const current = view === "tasks" ? state?.routines.find((routine) => routine.id === selected) : undefined;
  const draftOf = (routine: Routine): RoutineDraft => ({ id: routine.id, name: routine.name, projectId: routine.projectId, instructions: routine.instructions, mode: routine.mode, trigger: routine.trigger, enabled: routine.enabled, ...(routine.backend ? { backend: routine.backend } : {}), ...(routine.model ? { model: routine.model } : {}) });
  // A task that has run opens as its conversation: the newest run's thread, with the task's menu above it.
  const [details, setDetails] = useState(false);
  const [taskMenu, setTaskMenu] = useState(false);
  const taskMenuRef = useRef<HTMLButtonElement>(null);
  const latestThread = current && !details ? state?.runs.find((run) => run.routineId === current.id && run.threadId)?.threadId ?? null : null;
  useEffect(() => { onShowThread?.(active ? latestThread : null); }, [latestThread, active]);
  useEffect(() => () => onShowThread?.(null), []);
  const inChat = Boolean(chatShown && latestThread);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [rowMenu, setRowMenu] = useState<string | null>(null);
  const rowMenuRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  // What the task wrote: its Space page, shown beside the conversation with its revisions.
  const [output, setOutput] = useState(false);
  const [outputMenu, setOutputMenu] = useState(false);
  const [infoMenu, setInfoMenu] = useState(false);
  const [page, setPage] = useState<SpacePage | null>(null);
  const [versions, setVersions] = useState<SpacePageVersion[] | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const outputMenuRef = useRef<HTMLButtonElement>(null);
  const infoMenuRef = useRef<HTMLButtonElement>(null);
  const pageId = current?.pageId;
  const pageRevision = state?.runs.find((run) => run.routineId === current?.id && run.page)?.page?.revision;
  useEffect(() => {
    setRevision(null); setVersions(null);
    if (!pageId || !inChat) { setPage(null); return; }
    let live = true;
    void bridge.invoke("space:list", undefined).then((pages) => { if (live) setPage(pages.find((p) => p.id === pageId && !p.trashedAt) ?? null); }).catch(() => { if (live) setPage(null); });
    return () => { live = false; };
  }, [pageId, pageRevision, inChat]);
  useEffect(() => { if (!pageId) setOutput(false); }, [pageId]);
  const loadVersions = () => { if (pageId && !versions) void bridge.invoke("space:history", { id: pageId }).then(setVersions).catch(() => setVersions([])); };
  const shownPage = revision === null ? page : versions?.find((v) => v.page.revision === revision)?.page ?? page;
  const fileName = `${(page?.title.trim() || current?.name || "output").replace(/[^\w.-]+/g, "_")}.md`;
  const download = () => {
    if (!shownPage) return;
    const url = URL.createObjectURL(new Blob([shownPage.markdown], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url; link.download = fileName; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const [sheet, setSheet] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setSheet(inChat && output ? document.querySelector<HTMLElement>('[data-testid="sheet"]') : null); }, [inChat, output]);
  useLayoutEffect(() => { setSlot(inChat ? document.getElementById("scheduled-chat-header") : null); }, [inChat]);
  // A new task is made by describing it in a message, never by filling in a form: the schedule is read from
  // the message by fixed rules, the message becomes the task's instructions, and its first run starts at once.
  const [composing, setComposing] = useState<{ text: string; projectId: string } | null>(null);
  const startNew = (text = "") => { if (projects.length) { setView("tasks"); setEditing(null); setSelected(null); setComposing({ text, projectId: composing?.projectId ?? projects[0]!.id }); } };
  const reading = composing?.text.trim() ? taskFromText(composing.text) : null;
  const createFromChat = () => {
    if (!composing || !reading || busy) return;
    const { text, projectId } = composing;
    void act(async () => {
      const saved = await bridge.invoke("routines:save", { name: reading.name, projectId, instructions: text.trim(), mode: "chat", trigger: reading.trigger, enabled: true });
      setComposing(null); setDetails(false); setSelected(saved.id);
      await bridge.invoke("routines:run", { id: saved.id });
    });
  };

  const row = (routine: Routine) => (
    <li key={routine.id}>
      <button type="button" className={`sched-row${current?.id === routine.id ? " selected" : ""}`} data-testid="routine-row" data-routine-id={routine.id} aria-current={current?.id === routine.id ? "true" : undefined}
        onClick={() => { setEditing(null); setComposing(null); setView("tasks"); setDetails(false); setSelected(routine.id); }}>
        <span className="sched-row-title">{redact(routine.name)}</span>
        <span className="sched-row-sub">{rowLine(routine, runningIds.has(routine.id))}</span>
      </button>
      <span className="sched-row-menu composer-menu">
        <IconButton ref={(el) => { rowMenuRefs.current[routine.id] = el; }} icon="more" label={`Actions for ${routine.name}`} size="sm" data-testid="routine-row-menu" aria-haspopup="menu" aria-expanded={rowMenu === routine.id} onClick={() => setRowMenu(rowMenu === routine.id ? null : routine.id)} />
        {rowMenu === routine.id && <Menu open onClose={() => setRowMenu(null)} anchorRef={{ current: rowMenuRefs.current[routine.id] ?? null }} label={`Actions for ${routine.name}`} placement="bottom-end">
          <MenuItem disabled={busy} onClick={() => { setRowMenu(null); void act(() => bridge.invoke("routines:save", { ...draftOf(routine), enabled: !routine.enabled })); }}><Icon name="stop" />{routine.enabled ? "Pause" : "Resume"}</MenuItem>
          <MenuItem disabled={busy || runningIds.has(routine.id)} onClick={() => { setRowMenu(null); setComposing(null); setEditing(null); setDetails(false); setSelected(routine.id); void act(() => bridge.invoke("routines:run", { id: routine.id })); }}><Icon name="restart" />Run now</MenuItem>
          <MenuItem onClick={() => { setRowMenu(null); setComposing(null); setView("tasks"); setSelected(routine.id); setEditing(draftOf(routine)); }}><Icon name="compose" />Edit</MenuItem>
          <MenuSeparator />
          <MenuItem className="danger" disabled={busy} onClick={() => { setRowMenu(null); if (window.confirm(`Delete the task “${routine.name}”? Its runs stay in All activity, and its page stays in Space.`)) void act(async () => { await bridge.invoke("routines:delete", { id: routine.id }); if (selected === routine.id) setSelected(null); }); }}><Icon name="trash" />Delete</MenuItem>
        </Menu>}
      </span>
    </li>
  );
  const runsTable = (runs: RoutineRun[], named: boolean) => (
    <table className="routines-activity" data-testid="routines-activity">
      <thead><tr>{named && <th>Task</th>}<th>Trigger</th><th>Started</th><th>Ended</th><th>Status</th><th>Thread</th><th>Page</th></tr></thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.id} data-testid="activity-row" data-status={run.status}>
            {named && <td>{redact(run.routineName)}</td>}
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
  );

  return (
    <section className={`routines-view${listOpen ? "" : " list-closed"}${inChat ? " chat-shown" : ""}`} data-testid="routines-view" aria-label="Scheduled">
      {inChat && current && slot && createPortal(<>
        {!listOpen && <IconButton icon="sidebar" label="Show task list" size="md" onClick={() => setListOpen(true)} />}
        <span className="composer-menu">
          <button ref={taskMenuRef} type="button" className="sched-chat-title" data-testid="sched-chat-title" aria-haspopup="menu" aria-expanded={taskMenu} onClick={() => setTaskMenu((v) => !v)}><span>{redact(current.name)}</span><Icon name="chevron-down" size={12} /></button>
          <Menu open={taskMenu} onClose={() => setTaskMenu(false)} anchorRef={taskMenuRef} label="Task" placement="bottom-start">
            <MenuItem disabled={busy || runningIds.has(current.id)} onClick={() => { setTaskMenu(false); void act(() => bridge.invoke("routines:run", { id: current.id })); }}>Run now</MenuItem>
            <MenuItem data-testid="sched-details" onClick={() => { setTaskMenu(false); setDetails(true); }}>Task details and runs</MenuItem>
            <MenuItem onClick={() => { setTaskMenu(false); setEditing(draftOf(current)); }}>Edit</MenuItem>
            <MenuItem disabled={busy} onClick={() => { setTaskMenu(false); void act(() => bridge.invoke("routines:save", { ...draftOf(current), enabled: !current.enabled })); }}>{current.enabled ? "Pause" : "Resume"}</MenuItem>
          </Menu>
        </span>
        <span className="spacer" />
        <IconButton icon="external" label="Open in Chat" size="md" onClick={() => onOpenThread(latestThread!)} />
        <span className="composer-menu">
          <IconButton ref={infoMenuRef} icon="checklist" label="Schedule and outputs" size="md" data-testid="sched-info" aria-haspopup="menu" aria-expanded={infoMenu} onClick={() => setInfoMenu((v) => !v)} />
          <Menu open={infoMenu} onClose={() => setInfoMenu(false)} anchorRef={infoMenuRef} label="Schedule and outputs" placement="bottom-end" className="sched-info-menu">
            <MenuLabel>Scheduled</MenuLabel>
            <MenuItem onClick={() => { setInfoMenu(false); setDetails(true); }}><Icon name="history" /><span className="sched-info-name">{redact(current.name)}</span><small>{current.enabled ? cadence(current.trigger) : "Paused"}</small></MenuItem>
            <MenuLabel>Outputs</MenuLabel>
            {page ? <MenuItem data-testid="sched-output-open" onClick={() => { setInfoMenu(false); setOutput(true); }}><Icon name="page" /><span className="sched-info-name">{redact(fileName)}</span><small>rev {page.revision}</small></MenuItem>
              : <MenuItem disabled><Icon name="page" /><span className="sched-info-name">No output yet</span></MenuItem>}
          </Menu>
        </span>
      </>, slot)}
      {sheet && shownPage && createPortal(<aside className="sched-output" data-testid="sched-output" aria-label="Task output">
        <header className="sched-output-bar">
          <span className="composer-menu">
            <button ref={outputMenuRef} type="button" className="file-pill" aria-haspopup="menu" aria-expanded={outputMenu} onClick={() => { setOutputMenu((v) => !v); loadVersions(); }}><Icon name="page" size={15} /><span className="sched-output-name">{redact(shownPage.title.trim() || current?.name || "Output")}</span><Icon name="chevron-down" size={12} /></button>
            <Menu open={outputMenu} onClose={() => setOutputMenu(false)} anchorRef={outputMenuRef} label="Output" placement="bottom-start" className="sched-info-menu">
              <MenuLabel>{redact(fileName)} · revision {shownPage.revision} · {when(shownPage.updatedAt)}</MenuLabel>
              {onOpenPage && <MenuItem onClick={() => { setOutputMenu(false); onOpenPage(shownPage.id); }}><Icon name="space" />Open in Space</MenuItem>}
              <MenuLabel>Version history</MenuLabel>
              {!versions ? <MenuItem disabled>Loading…</MenuItem> : versions.length ? [...versions].sort((a, b) => b.page.revision - a.page.revision).slice(0, 8).map((v) => <MenuItem key={v.page.revision} checkable selected={(revision ?? page?.revision) === v.page.revision} onClick={() => { setOutputMenu(false); setRevision(v.page.revision === page?.revision ? null : v.page.revision); }}>Revision {v.page.revision} · {when(v.page.updatedAt)}</MenuItem>) : <MenuItem disabled>Only this revision</MenuItem>}
            </Menu>
          </span>
          {revision !== null && <button type="button" className="file-pill" onClick={() => setRevision(null)}>Back to latest</button>}
          <span className="spacer" />
          <IconButton icon="download" label={`Download ${fileName}`} size="md" className="file-round" data-testid="sched-output-download" onClick={download} />
          <IconButton icon={copied ? "check" : "copy"} label={copied ? "Copied" : "Copy output"} size="md" className="file-round" onClick={() => void bridge.invoke("clipboard:write", { text: shownPage.markdown }).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch((e: Error) => setError(e.message))} />
          <IconButton icon="close" label="Close output" size="md" className="file-round" onClick={() => setOutput(false)} />
        </header>
        <div className="sched-output-scroll"><article className="sched-paper" data-testid="sched-output-page"><h1>{redact(shownPage.title.trim() || current?.name || "Output")}</h1><Markdown text={redact(shownPage.markdown)} /></article></div>
      </aside>, sheet)}
      {editing && <RoutineEditor draft={editing} projects={projects} busy={busy} onCancel={() => setEditing(null)}
        onSave={(draft) => act(async () => { const saved = await bridge.invoke("routines:save", draft); setEditing(null); setSelected(saved.id); })} />}
      <aside className="sched-list" aria-label="Scheduled tasks" hidden={!listOpen}>
        <header className="sched-list-head">
          <h1>Scheduled</h1>
          <span className="composer-menu">
            <IconButton ref={menuRef} icon="sort" label="Sort and view" size="md" data-testid="sched-menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
            <Menu open={menu} onClose={() => setMenu(false)} anchorRef={menuRef} label="Sort and view" placement="bottom-end">
              <MenuItem onClick={() => { setSort("next"); setMenu(false); }}>{sort === "next" ? "✓ " : ""}Sort by next run</MenuItem>
              <MenuItem onClick={() => { setSort("name"); setMenu(false); }}>{sort === "name" ? "✓ " : ""}Sort by name</MenuItem>
              <MenuItem data-testid="sched-all-activity" onClick={() => { setEditing(null); setComposing(null); setView("activity"); setMenu(false); }}>All activity</MenuItem>
            </Menu>
          </span>
          <IconButton icon="search" label="Search tasks" size="md" aria-pressed={searching} onClick={() => { setSearching((v) => !v); setQuery(""); }} />
          <IconButton icon="sidebar" label="Hide task list" size="md" onClick={() => setListOpen(false)} />
        </header>
        {searching && <input className="sched-search" autoFocus aria-label="Search tasks" placeholder="Search tasks" value={query} onChange={(e) => setQuery(e.target.value)} />}
        <button type="button" className="sched-new" data-testid="routine-new" disabled={!projects.length || Boolean(editing)} onClick={() => startNew()}><Icon name="plus" size={16} /><span>New task</span></button>
        <div className="sched-scroll">
          <h2 className="sched-section">Active</h2>
          {state && !activeTasks.length && <p className="sched-none">{query ? "No matching tasks" : "No active tasks"}</p>}
          <ul>{activeTasks.map(row)}</ul>
          {pausedTasks.length > 0 && <>
            <button type="button" className="sched-section sched-fold" aria-expanded={pausedOpen} onClick={() => setPausedOpen((v) => !v)}>Paused<Icon name={pausedOpen ? "chevron-down" : "chevron-right"} size={12} /></button>
            {pausedOpen && <ul>{pausedTasks.map(row)}</ul>}
          </>}
          {completedTasks.length > 0 && <>
            <h2 className="sched-section">Completed</h2>
            <ul>{completedTasks.map(row)}</ul>
          </>}
        </div>
      </aside>
      {!inChat && <div className="sched-main">
        {!listOpen && <IconButton icon="sidebar" label="Show task list" size="md" className="sched-reopen" onClick={() => setListOpen(true)} />}
        {state?.error && <ErrorNotice className="routines-error" testId="routines-state-error" where="Scheduled" message={state.error} />}
        {error && <ErrorNotice className="routines-error" testId="routines-error" where="Scheduled · action" message={error} onRetry={failed?.message === error && !busy ? () => void act(failed.operation) : undefined} onDismiss={() => setError(null)} />}
        {composing ? (
          <div className="sched-compose" data-testid="sched-compose">
            <div className="sched-compose-hero">
              <div className="sched-clock" aria-hidden="true">🕐</div>
              <h2>New task</h2>
              <p>Say what to look into and how often. Tasks run read-only.</p>
            </div>
            <form className="sched-composer" onSubmit={(e) => { e.preventDefault(); createFromChat(); }}>
              <textarea autoFocus rows={3} data-testid="sched-compose-text" aria-label="Describe the task" placeholder="Every Monday at 8 AM, review what changed in this project…" maxLength={20_000}
                value={composing.text} onChange={(e) => setComposing({ ...composing, text: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); createFromChat(); } else if (e.key === "Escape") setComposing(null); }} />
              <div className="sched-composer-row">
                <select aria-label="Project" data-testid="sched-compose-project" value={composing.projectId} onChange={(e) => setComposing({ ...composing, projectId: e.target.value })}>
                  {projects.map((p) => <option key={p.id} value={p.id}>{redact(p.name)}</option>)}
                </select>
                <span className="sched-reading" data-testid="sched-reading">{reading ? `${reading.assumed ? "No schedule found: " : ""}${cadence(reading.trigger)} · first run now` : ""}</span>
                <span className="spacer" />
                <IconButton type="submit" icon="arrow-up" label="Create task and run it now" size="md" className="sched-send" data-testid="sched-compose-send" disabled={!reading || busy} />
              </div>
            </form>
          </div>
        ) : view === "activity" ? (
          <div className="sched-page">
            <h2 className="sched-title">All activity</h2>
            {state && !state.runs.length ? <p className="routines-empty">Runs appear here as they start.</p> : state && runsTable(state.runs, true)}
          </div>
        ) : current ? (
          <div className="sched-page" data-testid="routine-detail">
            <h2 className="sched-title">{redact(current.name)}</h2>
            <p className="sched-meta">{redact(project(current.projectId))} · {current.mode === "plan" ? "Plan" : "Chat"} (read-only) · {current.backend === "claude" ? "Claude Code" : current.backend === "codex" ? "Codex" : current.backend === "opencode" ? "OpenCode" : current.backend === "mimo" ? "MiMo Code" : current.backend === "mock" ? "Mock" : "Default provider"}{current.model ? ` · ${redact(current.model)}` : ""}</p>
            <p className="sched-meta">{schedule(current)}</p>
            <p className="sched-meta" data-testid="routine-next">{!current.enabled ? "Paused" : runningIds.has(current.id) ? "Running now" : current.nextRunAt ? `Next run ${when(current.nextRunAt)}` : "Ran; no further runs"}</p>
            <div className="routine-actions">
              <button type="button" data-testid="routine-run-now" disabled={busy || runningIds.has(current.id)} onClick={() => { setDetails(true); void act(() => bridge.invoke("routines:run", { id: current.id })); }}>Run now</button>
              <button type="button" disabled={busy} onClick={() => setEditing(draftOf(current))}>Edit</button>
              <button type="button" disabled={busy} onClick={() => act(() => bridge.invoke("routines:save", { ...draftOf(current), enabled: !current.enabled }))}>{current.enabled ? "Pause" : "Resume"}</button>
              <button type="button" disabled={busy} onClick={() => { if (window.confirm(`Delete the task “${current.name}”? Its runs stay in All activity, and its page stays in Space.`)) void act(async () => { await bridge.invoke("routines:delete", { id: current.id }); setSelected(null); }); }}>Delete</button>
            </div>
            <p className="sched-instructions">{redact(current.instructions)}</p>
            <h3 className="routines-section">Runs</h3>
            {state!.runs.some((run) => run.routineId === current.id) ? runsTable(state!.runs.filter((run) => run.routineId === current.id), false) : <p className="routines-empty">Runs appear here as they start.</p>}
          </div>
        ) : (
          <div className="sched-hero" data-testid="sched-hero">
            <div className="sched-clock" aria-hidden="true">🕐</div>
            <h2>Schedule a task</h2>
            <p>Modex can take care of ongoing tasks so you don’t have to.</p>
            {!projects.length && <p className="routines-empty">Add a project first: a task runs in one project.</p>}
            <div className="sched-cards">
              {SUGGESTIONS.map((card) => (
                <button key={card.name} type="button" className="sched-card" data-testid="sched-suggestion" disabled={!projects.length} onClick={() => startNew(card.instructions)}>
                  <span className="sched-card-icon" aria-hidden="true">{card.icon}</span>
                  <span className="sched-card-text"><strong>{card.name}</strong><span>{card.instructions}</span></span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>}
    </section>
  );
}

/** Starting points for a new task. Picking one opens the editor with its name and instructions filled in; nothing is created until it is saved. */
const SUGGESTIONS = [
  { icon: "💻", name: "Coven Chat iOS readiness", instructions: "Let me know when iOS approval dialogs or attachment support reach meaningful progress." },
  { icon: "💰", name: "Weekly finances update", instructions: "Review my recent spending, recurring charges, and anything that needs my attention." },
  { icon: "📖", name: "Find weekend reads", instructions: "Send me a great article to read every Saturday." },
  { icon: "🛍️", name: "Price alerts", instructions: "Check prices daily and alert me when my item costs less." },
  { icon: "🎵", name: "Find concerts", instructions: "Check weekly for new concerts that match my taste." },
  { icon: "📍", name: "Plan my weekend", instructions: "Send me local weekend ideas every Thursday." },
];

/** "Daily at 8:00 AM", "Fridays at 8:00 AM", "Every 2 hours", "Once, Nov 13, 3:00 PM". */
function cadence(t: Routine["trigger"]): string {
  if (t.kind === "once") return `Once, ${when(t.at)}`;
  const from = new Date(t.from);
  return t.unit === "days" && t.every === 1 ? `Daily at ${clock(from, true)}`
    : t.unit === "days" && t.every === 7 ? `${from.toLocaleDateString([], { weekday: "long" })}s at ${clock(from, true)}`
    : `Every ${t.every === 1 ? "" : `${t.every} `}${t.every === 1 ? t.unit.slice(0, -1) : t.unit}`;
}

const clock = (date: Date, minutes: boolean) => date.toLocaleTimeString([], minutes || date.getMinutes() ? { hour: "numeric", minute: "2-digit" } : { hour: "numeric" });

/** The line under a task's name in the list: "Tomorrow 8 AM · Fridays at 8:00 AM", "Nov 16 · Mondays at 8:00 AM", "Running". */
function rowLine(routine: Routine, running: boolean): string {
  if (running) return "Running";
  if (!routine.enabled) return "Paused";
  if (!routine.nextRunAt) return "Ran; no further runs";
  const next = new Date(routine.nextRunAt), today = new Date();
  const days = Math.round((new Date(next.getFullYear(), next.getMonth(), next.getDate()).getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  const day = days === 0 ? `Today ${clock(next, false)}` : days === 1 ? `Tomorrow ${clock(next, false)}` : next.toLocaleDateString([], { month: "short", day: "numeric" });
  const t = routine.trigger;
  if (t.kind === "once") return `${day} · Once`;
  return `${day} · ${cadence(t)}`;
}

/** The task's settings, as a dialog of grouped rows. A new task is never made here: that is a message. */
function RoutineEditor({ draft: initial, projects, busy, onSave, onCancel }: { draft: RoutineDraft; projects: Project[]; busy: boolean; onSave(draft: RoutineDraft): void; onCancel(): void }) {
  const [draft, setDraft] = useState(initial);
  const [advanced, setAdvanced] = useState(false);
  const set = (patch: Partial<RoutineDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const trigger = draft.trigger;
  const start = trigger.kind === "once" ? trigger.at : trigger.from;
  const local = toLocalInput(start);
  const setStart = (value: string) => { if (!value || Number.isNaN(new Date(value).getTime())) return; const iso = fromLocalInput(value); set({ trigger: trigger.kind === "once" ? { kind: "once", at: iso } : { ...trigger, from: iso } }); };
  const repeat = trigger.kind !== "interval" ? "" : trigger.unit === "days" && trigger.every === 1 ? "daily" : trigger.unit === "days" && trigger.every === 7 ? "weekly" : "interval";
  const [custom, setCustom] = useState(repeat === "interval");
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onCancel(); } };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onCancel]);
  return (
    <div className="st-backdrop" onPointerDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <form className="st-dialog" role="dialog" aria-modal="true" data-testid="routine-editor" aria-label={initial.id ? "Edit task" : "New task"} onSubmit={(e) => { e.preventDefault(); onSave(draft); }}>
        <header><h2>Schedule a task</h2><button type="button" className="st-close" aria-label="Close" onClick={onCancel}><Icon name="close" size={15} /></button></header>
        <div className="st-scroll">
          <div className="st-text">
            <input data-testid="routine-name" aria-label="Task name" placeholder="Task name" value={draft.name} maxLength={80} required onChange={(e) => set({ name: e.target.value })} />
            <textarea data-testid="routine-instructions" aria-label="Instructions" value={draft.instructions} maxLength={20_000} required rows={4} placeholder="Instructions…" onChange={(e) => set({ instructions: e.target.value })} />
          </div>
          <div className="st-group">
            <label className="st-row"><span>Repeat task</span><input type="checkbox" className="st-switch" data-testid="routine-repeat" checked={trigger.kind === "interval"} onChange={(e) => { setCustom(false); set({ trigger: e.target.checked ? { kind: "interval", every: 1, unit: "days", from: start } : { kind: "once", at: start } }); }} /></label>
            {trigger.kind === "interval" && <label className="st-row"><span>Repeat</span>
              <select data-testid="routine-repeat-kind" value={custom ? "interval" : repeat} onChange={(e) => { const kind = e.target.value; setCustom(kind === "interval"); if (kind === "daily") set({ trigger: { ...trigger, every: 1, unit: "days" } }); else if (kind === "weekly") set({ trigger: { ...trigger, every: 7, unit: "days" } }); }}>
                <option value="interval">Interval</option><option value="daily">Daily</option><option value="weekly">Weekly</option>
              </select></label>}
            {trigger.kind === "interval" && custom && <div className="st-row"><span>Every</span><span className="st-pair">
              <input type="number" min={1} max={10000} aria-label="Every" data-testid="routine-every" value={trigger.every} onChange={(e) => set({ trigger: { ...trigger, every: Number(e.target.value) } })} />
              <select aria-label="Unit" data-testid="routine-unit" value={trigger.unit} onChange={(e) => set({ trigger: { ...trigger, unit: e.target.value as RoutineUnit } })}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select>
            </span></div>}
            <label className="st-row"><span>Time</span><input type="time" data-testid="routine-time" required value={local.slice(11)} onChange={(e) => setStart(`${local.slice(0, 10)}T${e.target.value}`)} /></label>
            <label className="st-row"><span>{trigger.kind === "interval" ? "Starting" : "Date"}</span><input type="date" data-testid="routine-date" required value={local.slice(0, 10)} onChange={(e) => setStart(`${e.target.value}T${local.slice(11)}`)} /></label>
          </div>
          <button type="button" className="st-advanced" aria-expanded={advanced} data-testid="routine-advanced" onClick={() => setAdvanced((v) => !v)}>Advanced<Icon name={advanced ? "chevron-up" : "chevron-down"} size={11} /></button>
          {advanced && <>
            <label className="st-group st-row"><span>Project</span><select data-testid="routine-project" value={draft.projectId} onChange={(e) => set({ projectId: e.target.value })}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="st-group st-row"><span>Mode (always read-only)</span><select data-testid="routine-mode" value={draft.mode} onChange={(e) => set({ mode: e.target.value as RoutineDraft["mode"] })}><option value="chat">Chat</option><option value="plan">Plan</option></select></label>
            <label className="st-group st-row"><span>Provider</span>
              <select data-testid="routine-backend" value={draft.backend ?? ""} onChange={(e) => { const { backend: _b, ...rest } = draft; setDraft(e.target.value ? { ...rest, backend: e.target.value as BackendId } : rest); }}>
                <option value="">Default provider</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="opencode">OpenCode</option><option value="mimo">MiMo Code</option>
              </select></label>
            <label className="st-group st-row"><span>Model</span><input data-testid="routine-model" value={draft.model ?? ""} placeholder="Provider default" maxLength={200} onChange={(e) => set({ model: e.target.value })} /></label>
            <label className="st-group st-row"><span>Active</span><input type="checkbox" className="st-switch" data-testid="routine-enabled" checked={draft.enabled} onChange={(e) => set({ enabled: e.target.checked })} /></label>
            <p className="st-note">Each run starts a new read-only chat: it cannot edit files, and any approval it asks for is refused. Runs missed while the Mac slept or Modex was closed run once when Modex notices.</p>
          </>}
        </div>
        <footer><button type="button" className="st-cancel" onClick={onCancel}>Cancel</button><button type="submit" className="st-save" data-testid="routine-save" disabled={busy}>{initial.id ? "Save" : "Create"}</button></footer>
      </form>
    </div>
  );
}
