import { useEffect, useState } from "react";
import type { SpacePage } from "../../shared/space";
import { CONTEXT_SHOWN, clarificationLine, type TaskNoteView as View } from "../../shared/task-context";
import { bridge } from "../bridge";
import { PLAN_FROM, PLAN_STATUS, VerificationText } from "../components/transcript/TaskPlanCard";

const EDITED_BY: Record<NonNullable<View["edited"]>["by"], string> = { you: "You", outside: "Outside Modex", agent: "an agent", other: "an unknown change" };

/**
 * The task a saved task note recorded (docs/task-context.md#reopening-a-saved-note), or null when the page
 * is not one. It looks again when the page changes, and every few seconds while `watch` (a Finder move
 * changes no revision). Each look only reads: `task:note` runs nothing and writes nothing.
 */
export function useTaskNote(page: SpacePage | undefined, watch: boolean): View | null {
  const [view, setView] = useState<{ pageId: string; view: View | null } | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!watch) return;
    const timer = window.setInterval(() => setTick((n) => n + 1), 3000);
    return () => window.clearInterval(timer);
  }, [watch]);
  useEffect(() => {
    if (!page) return;
    let alive = true;
    void bridge.invoke("task:note", { pageId: page.id }).then((v) => { if (alive) setView({ pageId: page.id, view: v }); }).catch(() => { if (alive) setView({ pageId: page.id, view: null }); });
    return () => { alive = false; };
  }, [page?.id, page?.revision, page?.updatedAt, tick]);
  return page && view?.pageId === page.id ? view.view : null;
}

/**
 * A saved task note, reopened read-only: the request, plan, clarifications, files touched and verification
 * as the save recorded them, and what has happened to the note since. Nothing here runs again, asks the
 * CLI or edits the note; continuing is a new message in the thread.
 */
export function TaskNoteView({ view, onOpenThread, onClose }: { view: View; onOpenThread?: (threadId: string) => void; onClose(): void }) {
  const { record } = view;
  const context = record.context;
  const verification = record.verification;
  return <section className="pages-history task-view" aria-label="Task view" data-testid="task-view">
    <div><strong>Task view</strong><button className="btn small" onClick={onClose}>Close task view</button></div>
    <p className="task-view-note" data-testid="task-view-saved">
      Saved {new Date(view.savedAt).toLocaleString()} as revision {view.savedRevision}. Read-only: nothing here runs again. To continue, send a new message in the thread.
      {view.thread && onOpenThread && <> <button className="btn small" data-testid="task-view-thread" onClick={() => onOpenThread(view.threadId)}>Open thread</button></>}
    </p>
    {!view.thread && <p className="task-view-note" data-testid="task-view-thread-gone">The thread is no longer in Modex.</p>}
    {view.edited && <p className="task-view-warning" role="status" data-testid="task-view-edited">This note was edited after it was saved (revision {view.edited.revision}, by {EDITED_BY[view.edited.by]}, {new Date(view.edited.at).toLocaleString()}). Below is the task as saved.</p>}
    {view.moved && <p className="task-view-warning" role="status" data-testid="task-view-moved">This note was moved from {view.moved.from}'s notes to {view.moved.to}'s. The task ran in {view.moved.from}.</p>}
    {view.unlinked && <p className="task-view-warning" role="status" data-testid="task-view-unlinked">The project this task ran in no longer has notes linked to it.</p>}
    {view.note.trashed && <p className="task-view-note" data-testid="task-view-trashed">This note is in Trash.</p>}
    {view.superseded && <p className="task-view-note" data-testid="task-view-superseded">A later save of this task is in “{view.superseded.title}”.{" "}
      <button className="btn small" onClick={() => window.dispatchEvent(new CustomEvent("modex:open-page", { detail: view.superseded!.pageId }))}>Open</button></p>}

    <h3>Request</h3>
    <blockquote data-testid="task-view-request">{record.request}</blockquote>
    {record.clarifications.length > 0 && <><h3>Clarifications</h3>
      <ul>{record.clarifications.map((c, i) => <li key={i} data-testid="task-view-clarification">{clarificationLine(c)}</li>)}</ul></>}
    {record.plan && <><h3>Plan</h3>
      <p className="task-view-note">From {PLAN_FROM[record.plan.from]} · revision {record.plan.revision}. “Reported done” is what the CLI said, not a check.</p>
      <ol className="plan-steps">{record.plan.steps.map((step, i) => <li key={i} className={`plan-step ${step.status}`} data-testid="task-view-step" data-status={step.status}>
        <span className="plan-status">{PLAN_STATUS[step.status] ?? PLAN_STATUS.unknown}</span> {step.text}
      </li>)}</ol></>}
    {context && (context.files.length > 0 || context.outside > 0) && <><h3>Files touched · {context.files.length}</h3>
      <p className="task-view-note">As the CLI reported them. Modex did not index the project.</p>
      <ul className="task-context-files">
        {context.files.slice(0, CONTEXT_SHOWN).map((file) => <li key={file.path} data-testid="task-view-file"><code>{file.path}</code> {file.relations.join(", ")}</li>)}
        {context.files.length > CONTEXT_SHOWN && <li>and {context.files.length - CONTEXT_SHOWN} more</li>}
        {context.outside > 0 && <li>{context.outside} outside the project, not named</li>}
      </ul></>}
    {verification && (verification.checks.length > 0 || verification.edits > 0) && <><h3>Verification</h3>
      <div className="task-verification" data-testid="task-view-verification" data-state={verification.state}><VerificationText v={verification} /></div></>}
    {record.answer && <><h3>Answer</h3><p className="task-view-answer">{record.answer}</p></>}
  </section>;
}
