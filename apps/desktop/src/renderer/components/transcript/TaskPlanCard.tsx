import { useState } from "react";
import type { ThreadItem } from "../../../shared/types";
import type { PlanStep } from "../../../shared/conversation-events";
import { bridge } from "../../bridge";
import { ErrorNotice } from "../ui/ErrorNotice";

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
