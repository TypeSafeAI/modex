import { useId, useMemo, useState } from "react";
import type { ThreadItem } from "../../../shared/types";
import type { PlanStep } from "../../../shared/conversation-events";
import { bridge } from "../../bridge";
import { ErrorNotice } from "../ui/ErrorNotice";
import { CONTEXT_SHOWN, displayCommand, taskContext, verification, type TaskCheck } from "../../../shared/task-context";

const STATUS: Record<PlanStep["status"], string> = { pending: "Not started", "in-progress": "In progress", completed: "Reported done", unknown: "Status unknown" };
const FROM = { "codex-plan": "Codex's plan", "claude-todo": "Claude's todo list" } as const;

/**
 * The plan a CLI reported for a turn (docs/task-context.md), in its own statuses. A step the CLI
 * marked completed reads "Reported done": what it said, not a check.
 */
export function TaskPlanCard({ item }: { item: Extract<ThreadItem, { kind: "plan" }> }) {
  return (
    <div className="plan-card" data-testid="item" data-item-kind="plan">
      <div className="plan-head">
        <span className="plan-title">Plan</span>
        <span className="plan-meta" data-testid="plan-meta">From {FROM[item.from]} · revision {item.revision}</span>
      </div>
      {item.explanation && <p className="plan-explanation">{item.explanation}</p>}
      <ol className="plan-steps">
        {item.steps.map((step, i) => (
          <li key={i} className={`plan-step ${step.status}`} data-testid="plan-step" data-status={step.status}>
            <span className="plan-status">{STATUS[step.status]}</span> {step.text}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Saves one turn's task record to its project's notes, only when asked. Saving again updates the
 * same note, unless it was edited since; then the edit stays and this version becomes a new note.
 */
export function SaveTaskNote({ threadId, turnId, saved }: { threadId: string; turnId: string; saved: boolean }) {
  const [state, setState] = useState<{ busy: boolean; result?: { pageId: string; title: string; created: boolean; preserved: boolean }; error?: string }>({ busy: false });
  const save = async () => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    try { setState({ busy: false, result: await bridge.invoke("task:save-note", { threadId, turnId }) }); }
    catch (err) { setState({ busy: false, error: (err as Error).message }); }
  };
  const result = state.result;
  return (
    <div className="task-note">
      <button type="button" className="task-note-save" data-testid="save-task-note" disabled={state.busy} onClick={() => void save()}>{saved || result ? "Update note" : "Save to Notes"}</button>
      {result && <span className="task-note-saved" data-testid="task-note-saved">
        {result.created ? (result.preserved ? "The note was edited since; saved as a new note · " : "Saved to Notes · ") : "Updated in Notes · "}{result.title}
        <button type="button" className="btn small" onClick={() => window.dispatchEvent(new CustomEvent("modex:open-page", { detail: result.pageId }))}>Open</button>
      </span>}
      {state.error && <ErrorNotice testId="task-note-error" where="Notes · save task" message={state.error} onRetry={state.busy ? undefined : () => void save()} context={{ threadId, turnId }} />}
    </div>
  );
}

/** One check, as its script, with the exact command the CLI reported on hover. */
function Check({ check }: { check: TaskCheck }) {
  return <code title={check.command}>{displayCommand(check.command)}</code>;
}

/** The checks named in a line: the first two, then how many more. */
function Checks({ checks }: { checks: TaskCheck[] }) {
  const unique = checks.filter((check, i) => checks.findIndex((other) => displayCommand(other.command) === displayCommand(check.command)) === i);
  return <>{unique.slice(0, 2).map((check, i) => <span key={check.command}>{i ? " and " : ""}<Check check={check} /></span>)}{unique.length > 2 ? ` and ${unique.length - 2} more` : ""}</>;
}

/**
 * What a finished turn's checks say about its latest change (docs/task-context.md#verification), beside
 * Save to Notes. Verified needs a check that ran after the last change and passed; the CLI's word, an
 * unrelated command or an earlier check never is. A turn that changed nothing and ran no check shows nothing.
 */
export function TaskVerificationLine({ items }: { items: readonly ThreadItem[] }) {
  const v = useMemo(() => verification(items), [items]);
  if (!v.checks.length && !v.edits) return null;
  const current = v.checks.filter((check) => !check.stale);
  const failing = current.filter((check) => !check.passed && (check.outcome === "failed" || check.outcome === "denied" || (typeof check.exitCode === "number" && check.exitCode !== 0)));
  const text = v.state === "verified" ? <>Verified: <Checks checks={current} /> passed after the last change</>
    : v.state === "failed" ? <>Failed: <Checks checks={failing} /> did not pass</>
    : v.state === "unknown" ? <>Not verified: <Checks checks={current.filter((check) => !check.passed)} /> did not say how it ended</>
    : v.state === "stale" ? <>Not verified: <Check check={v.checks.at(-1)!} /> ran before a later change</>
    : <>Not verified: no check ran after the changes</>;
  return <div className="task-verification" data-testid="task-verification" data-state={v.state}>{text}</div>;
}

/**
 * The project files a finished turn touched (docs/task-context.md#context-map), shown when asked: what
 * its tools changed, read and searched, as the CLI reported them. Nothing is indexed or inferred.
 * At most 20 are listed, then how many more; paths outside the project are only counted.
 */
export function TaskContextLine({ items, cwd }: { items: readonly ThreadItem[]; cwd: string }) {
  const context = useMemo(() => taskContext(items, cwd), [items, cwd]);
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!context.files.length && !context.outside) return null;
  return (
    <div className="task-context" data-testid="task-context">
      <button type="button" className="task-context-toggle" data-testid="task-context-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        Files touched · {context.files.length}
      </button>
      {open && <div id={listId}>
        <p className="task-context-note">As the CLI reported them. Modex did not index the project.</p>
        <ul className="task-context-files">
          {context.files.slice(0, CONTEXT_SHOWN).map((file) => (
            <li key={file.path} data-testid="task-context-file"><code>{file.path}</code> {file.relations.join(", ")}</li>
          ))}
          {context.files.length > CONTEXT_SHOWN && <li data-testid="task-context-more">and {context.files.length - CONTEXT_SHOWN} more</li>}
          {context.outside > 0 && <li data-testid="task-context-outside">{context.outside} outside the project, not named</li>}
        </ul>
      </div>}
    </div>
  );
}
