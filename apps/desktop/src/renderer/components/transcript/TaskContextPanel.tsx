import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { bridge } from "../../bridge";
import type { ContextDraftUi } from "../../task-context-draft";
import { contextRefId, type ContextSource, type ContextTarget, type TaskCheckEvidence, type TaskContextEvidence } from "../../../shared/task-context-evidence";
import { useExpansionState } from "./reader-state";

export const contextTargetLabel = (target: ContextTarget): string => target.kind === "file" ? target.path : target.kind === "note" ? `Note ${target.pageId}` : `Notes file ${target.id}`;
type Ref = TaskContextEvidence["refs"][number];

function ContextSourceLabel({ source, onRevealItem }: { source: ContextSource; onRevealItem?: (id: string) => void }) {
  const link = source.kind === "native" ? { itemId: source.itemId } : source.kind === "notes-read" || source.kind === "model-proposal" ? source.nativeLink : undefined;
  const text = source.kind === "human" ? `Source: you · ${source.at}` : source.kind === "native" ? `Source: ${source.origin.backend} native tool`
    : source.kind === "notes-read" ? `Source: Modex Notes ${source.method} · ${source.at}` : source.kind === "model-proposal" ? `Source: ${source.turn.backend} proposal · ${source.at}` : `Source: historical tool; native origin unavailable · ${source.at}`;
  return <p className="task-context-source">{text}{link && (onRevealItem ? <> · <button type="button" className="btn small" aria-label={`Show native item ${link.itemId}`} onClick={() => onRevealItem(link.itemId)}>Show reported tool</button></> : <> · native item <code>{link.itemId}</code></>)}</p>;
}

/** Expanding these rows is a pure view of retained metadata. It makes no bridge call. */
export function ContextReferences({ context, renderControls, onRevealItem }: { context: TaskContextEvidence; renderControls?: (ref: Ref) => ReactNode; onRevealItem?: (id: string) => void }) {
  const [all, setAll] = useState(false), refs = all ? context.refs : context.refs.slice(0, 20);
  const captures = useMemo(() => new Map(context.captures.map(capture => [capture.id, capture])), [context.captures]);
  return <>
    <ul className="task-context-refs">{refs.map(ref => {
      const observed = ref.relations.some(r => r.kind === "read" && r.provenance === "observed");
      return <li key={ref.id} data-testid="context-reference"><strong>{contextTargetLabel(ref.target)}</strong>
        {ref.relations.some(r => r.provenance === "model-proposed") && <span>Proposed by model</span>}
        {[...new Set(ref.relations.filter(relation => relation.provenance === "model-proposed" && relation.role).map(relation => relation.role!))].map(role => <span key={role}>Proposed role: {role}</span>)}
        {ref.relations.some(r => r.provenance === "user-confirmed") && <span>Confirmed by you</span>}
        {observed ? <span>Observed read</span> : <span>{ref.relations.some(r => r.provenance === "user-confirmed") ? "Selected, not inspected" : "Not inspected"}</span>}
        {ref.relations.some(r => r.kind === "changed" && r.provenance === "observed") && <span>Observed change</span>}
        {[...new Map(ref.relations.map(relation => [JSON.stringify(relation.source), relation.source])).values()].map((source, i) => <ContextSourceLabel key={i} source={source} onRevealItem={onRevealItem} />)}
        {renderControls?.(ref)}
        {ref.captureIds.map(id => captures.get(id)).filter(c => c !== undefined).map(c => <details key={c.id}><summary>{c.phase} · <time dateTime={c.finishedAt}>{c.finishedAt}</time></summary>
          <p>Observation started <time dateTime={c.startedAt}>{c.startedAt}</time>. {c.revision.state === "available" ? <><code data-testid="context-digest">{c.revision.digest}</code> · {c.revision.bytes} bytes</> : <>Revision unavailable: {c.revision.reason}</>}</p>
          {c.noteVersion && <p>Note revision {c.noteVersion.revision} · {c.noteVersion.via} · {c.noteVersion.updatedAt}</p>}
          <p>{c.repository.state === "available" ? <>Repository HEAD <code>{c.repository.head}</code> (not a dirty-tree snapshot)</> : <>Repository HEAD unavailable: {c.repository.reason}</>}</p>
        </details>)}
      </li>;
    })}</ul>
    {context.refs.length > 20 && <button type="button" className="btn small" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? "Show first 20 references" : `Show all ${context.refs.length} references`}</button>}
  </>;
}

export function TaskContextSelect({ ui }: { ui: ContextDraftUi }) {
  const trigger = useRef<HTMLButtonElement>(null), [all, setAll] = useState(false), state = ui.state;
  if (!state.owner || !bridge.taskContextEditing) return null;
  const candidates = [
    ...(state.candidates?.files.paths ?? []).map(path => ({ target: { kind: "file" as const, path }, title: path })),
    ...(state.candidates?.notes.items ?? []).map(row => ({ target: row.target, title: `Note: ${row.title}` })),
  ];
  const busy = state.busy || state.held;
  return <div className="task-context-select">
    <button type="button" className="btn small" ref={trigger} aria-expanded={state.open} onClick={ui.toggle}>Context for next request</button>
    {state.open && <section role="region" aria-label="Context for next request" className="task-context-panel" onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); ui.close(); trigger.current?.focus(); } }}>
      <p>Select relevant references. Selection records a snapshot; it does not establish agent inspection or grant tool access.</p>
      {state.error && <p role="alert">{state.error}</p>}
      {state.error && state.binding && <button type="button" className="btn small" disabled={busy} onClick={() => void ui.reload()}>Reload saved context</button>}
      {state.busy && <p role="status">Loading context…</p>}
      {!state.binding && !state.busy && <button type="button" className="btn small" onClick={() => void ui.load()}>Retry context</button>}
      <div className="task-context-candidates">{(all ? candidates : candidates.slice(0, 20)).map(row => <div key={contextRefId(row.target)}><label><input type="checkbox" aria-label={row.title} disabled={busy} checked={state.selected.some(target => contextRefId(target) === contextRefId(row.target))} onChange={event => ui.choose(row.target, event.currentTarget.checked)} />{row.title}</label>{row.target.kind === "note" && <button type="button" className="btn small" onClick={() => window.dispatchEvent(new CustomEvent("modex:open-page", { detail: row.target.kind === "note" ? row.target.pageId : "" }))}>Preview {row.title}</button>}</div>)}</div>
      {candidates.length > 20 && <button type="button" className="btn small" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? "Show first 20 candidates" : `Show all candidates (${candidates.length})`}</button>}
      {(state.candidates?.files.truncated || state.candidates?.notes.truncated) && <p>The candidate list is bounded and may omit references.</p>}
      <button type="button" className="btn small" disabled={!state.binding || busy} onClick={() => void ui.apply()}>Apply context</button>
      {state.context && <ContextReferences key={state.key} context={state.context} />}
    </section>}
  </div>;
}

export function TaskContextPanel({ context, threadId, turnId, readOnly = false, onRevealItem }: { context?: TaskContextEvidence; threadId?: string; turnId?: string; readOnly?: boolean; onRevealItem?: (id: string) => void }) {
  const [open, setOpen] = useExpansionState<boolean>(`task-context:${turnId ?? "saved"}`, false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  if (!context || (!context.refs.length && !context.checks.length)) return null;
  const editable = !readOnly && bridge.taskContextEditing === true;
  const confirm = async (id: string, selected: boolean) => {
    if (!editable || !threadId || !turnId || busy) return;
    const refIds = context.refs.filter(ref => ref.id === id ? selected : ref.relations.some(r => r.provenance === "user-confirmed")).map(ref => ref.id);
    setBusy(true); setError("");
    try { await bridge.invoke("task:context-confirm", { threadId, turnId, expectedRevision: context.revision, refIds }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <div className="task-context-turn">
    <button type="button" className="btn small" aria-expanded={open} onClick={() => setOpen(value => !value)}>Task context · {context.refs.length}</button>
    {open && <section role="region" aria-label="Task context" className="task-context-panel">
      {!editable && !readOnly && <p>Edit context on the desktop that owns this project.</p>}
      {readOnly && <p>Saved metadata. Read-only; expanding it does not refresh any observation.</p>}
      {error && <p role="alert">{error}</p>}
      <p>Snapshots record timed observations; process input bytes remain unverified.</p>
      {context.capabilities?.map(receipt => <p key={receipt.turn.attempt}>Attempt setup reported: {receipt.capability.state}{receipt.capability.state === "unavailable" ? ` (${receipt.capability.reason})` : ""} · {receipt.at}</p>)}
      {!editable ? <ContextReferences context={context} /> : <fieldset disabled={busy}><legend>Relevant to this request</legend><ContextReferences context={context} onRevealItem={onRevealItem} renderControls={ref => <div><label className="task-context-confirm"><input type="checkbox" aria-label={`Relevant: ${contextTargetLabel(ref.target)}`} checked={ref.relations.some(r => r.provenance === "user-confirmed")} onChange={event => void confirm(ref.id, event.currentTarget.checked)} />{contextTargetLabel(ref.target)}</label>{ref.target.kind === "note" && <button type="button" className="btn small" onClick={() => window.dispatchEvent(new CustomEvent("modex:open-page", { detail: ref.target.kind === "note" ? ref.target.pageId : "" }))}>Preview Note</button>}</div>} /></fieldset>}
      {context.checks.map(check => <CheckRelevance key={check.itemId} check={check} context={context} threadId={threadId} turnId={turnId} readOnly={!editable} onRevealItem={readOnly ? undefined : onRevealItem} />)}
    </section>}
  </div>;
}

function CheckRelevance({ check, context, threadId, turnId, readOnly, onRevealItem }: { check: TaskCheckEvidence; context: TaskContextEvidence; threadId?: string; turnId?: string; readOnly: boolean; onRevealItem?: (id: string) => void }) {
  const [selected, setSelected] = useState(check.relevantRefIds), [all, setAll] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const baseline = JSON.stringify(check.relevantRefIds);
  useEffect(() => { setSelected(check.relevantRefIds); }, [baseline]);
  const apply = async (refIds: string[]) => {
    if (readOnly || !threadId || !turnId || busy) return;
    setBusy(true); setError("");
    try { await bridge.invoke("task:check-confirm", { threadId, turnId, expectedRevision: context.revision, itemId: check.itemId, refIds }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setBusy(false); }
  };
  return <fieldset aria-label={`Check relevance: ${check.command}`} disabled={busy}><legend><code>{check.command}</code></legend>
    <p>{check.origin ? <>Source: {check.origin.backend} native check · {onRevealItem ? <button type="button" className="btn small" aria-label={`Show native item ${check.itemId}`} onClick={() => onRevealItem(check.itemId)}>Show reported check</button> : <code>{check.itemId}</code>}</> : "Native check origin unavailable"}</p>
    <p>{check.outcome} · exit {check.exitCode ?? "not reported"} · {check.scope} scope · {check.relevance}</p><p>{check.startedAt ?? "Start unavailable"} → {check.finishedAt ?? "Completion unavailable"}</p>
    {error && <p role="alert">{error}</p>}
    {!readOnly && <><p>Choose references this check is relevant to. Its result and snapshots stay as recorded.</p>
      {(all ? context.refs : context.refs.slice(0, 20)).map(ref => <label key={ref.id} className="task-context-confirm"><input type="checkbox" aria-label={`Check reference: ${contextTargetLabel(ref.target)}`} checked={selected.includes(ref.id)} onChange={event => { const checked = event.currentTarget.checked; setSelected(values => checked ? [...values, ref.id] : values.filter(id => id !== ref.id)); }} />{contextTargetLabel(ref.target)}</label>)}
      {context.refs.length > 20 && <button type="button" className="btn small" onClick={() => setAll(value => !value)}>{all ? "Show first 20 check references" : `Show all ${context.refs.length} check references`}</button>}
      <button type="button" className="btn small" onClick={() => void apply(selected)}>Apply check relevance</button><button type="button" className="btn small" onClick={() => void apply([])}>Clear check relevance</button>
    </>}
  </fieldset>;
}
