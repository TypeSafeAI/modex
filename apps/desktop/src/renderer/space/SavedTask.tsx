import { useEffect, useRef, useState } from "react";
import type { SavedTaskView, SpacePage } from "../../shared/space";
import { bridge } from "../bridge";
import { Markdown } from "../components/Markdown";
import { ErrorNotice } from "../components/ui/ErrorNotice";

/** A historical task receipt: no editor, runner actions, or transcript reconstruction. */
export function SavedTask({ page }: { page: SpacePage }) {
  const [saved, setSaved] = useState<SavedTaskView | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let alive = true;
    void bridge.invoke("task:read-note", { pageId: page.id }).then(value => {
      if (alive) { setSaved(value); setError(undefined); }
    }, err => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, [page.id, page.revision, open, attempt]);
  useEffect(() => { if (open) heading.current?.focus(); }, [open]);
  return <>
    {error && <ErrorNotice where="Notes · saved task" message={error} onRetry={() => setAttempt(n => n + 1)} />}
    {saved && <div className="saved-task">
      <button ref={trigger} type="button" className="btn small" aria-expanded={open} onClick={() => setOpen(!open)}>View saved task</button>
      {open && <section aria-label="Saved task">
        <h2 ref={heading} tabIndex={-1}>Saved task · Read-only</h2>
        <p>Saved {new Date(saved.savedAt).toLocaleString()} · revision {saved.revision}. This view shows the task as saved.</p>
        {(saved.edited || page.title !== saved.title || page.markdown !== saved.markdown) && <p role="status">The note was edited after this task was saved. Your edits are kept in the note.</p>}
        {saved.moved === null && <p>The original project was not recorded for this older save; its current placement cannot be compared.</p>}
        {saved.moved && <p role="status">The note has moved outside its original project.</p>}
        <Markdown text={saved.markdown} />
        <button type="button" className="btn small" onClick={() => { setOpen(false); trigger.current?.focus(); }}>Close saved task</button>
      </section>}
    </div>}
  </>;
}
