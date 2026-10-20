import { useEffect, useId, useState, type ReactNode } from "react";
import type { Thread, ThreadItem } from "../../../shared/types";
import { layoutTurn } from "../../../shared/turn-layout";
import { useExpansionState } from "./reader-state";
import { Icon } from "../ui/Icon";

export interface Turn {
  user?: Extract<ThreadItem, { kind: "user" }>;
  rest: ThreadItem[];
}

/** Typed records follow their authoritative turn; only legacy records follow user boundaries. */
export function groupTurns(items: ThreadItem[]): Turn[] {
  const turns: Turn[] = [];
  const byId = new Map<string, Turn>();
  let legacy: Turn | undefined;
  for (const item of items) {
    if (item.kind === "user") {
      let turn = byId.get(item.id);
      if (!turn) {
        turn = { rest: [] };
        byId.set(item.id, turn);
        turns.push(turn);
      }
      turn.user = item;
      legacy = turn;
    } else if ("origin" in item && item.origin) {
      let turn = byId.get(item.origin.turn);
      if (!turn) {
        turn = { rest: [] };
        byId.set(item.origin.turn, turn);
        turns.push(turn);
      }
      turn.rest.push(item);
    } else {
      // Explicit legacy adapter: history and unscoped notices/requests keep their existing placement.
      if (!legacy) { legacy = { rest: [] }; turns.push(legacy); }
      legacy.rest.push(item);
    }
  }
  return turns;
}

/**
 * Keep the final answer and actionable items visible; completed work stays inspectable. Which item
 * answers, which are live and which may fold comes from `layoutTurn` (shared/turn-layout.ts).
 */
export function TurnContent({ turn, status, render, footer }: { turn: Turn; status?: Thread["status"]; render: (item: ThreadItem, live: boolean) => ReactNode; footer?: (turn: Turn) => ReactNode }) {
  const [expanded, setExpanded] = useExpansionState<boolean>(`turn:${turn.user?.id ?? turn.rest[0]?.id}`, false);
  const historyId = useId();
  const live = status !== undefined;
  const layout = layoutTurn(turn.rest, { busy: live });
  const hasWork = layout.work.some(Boolean);
  const showWork = live || expanded || !turn.user;
  return <>
    {turn.user && render(turn.user, false)}
    {turn.user && (live || turn.rest.length > 0) && <TurnHeader start={turn.user.at} end={live ? undefined : turnEnd(turn.rest)} status={status}
      asking={turn.rest.some((item) => item.kind === "question" && !item.answers && !item.withdrawn)}
      expanded={hasWork && !live ? expanded : undefined} controls={historyId} onToggle={() => setExpanded(value => !value)} />}
    {/* Wrappers preserve chronological order and mounted item state while work is folded. */}
    <div id={historyId} className="turn-content">
      {turn.rest.flatMap((item, index) => [
        ...(layout.attemptStart[index] ? [<div key={`attempt:${item.id}`} className="attempt-divider" data-testid="attempt-divider">Attempt {layout.attemptStart[index]}</div>] : []),
        <div key={item.id} hidden={layout.work[index] && !showWork} data-final={index === layout.final ? "true" : undefined} data-live={layout.live[index] ? "true" : undefined}>{render(item, layout.live[index]!)}</div>,
      ])}
    </div>
    {!live && turn.user && turn.rest.length > 0 && footer?.(turn)}
  </>;
}

/** When a finished turn ended: its last item's time, plus that item's own duration when it has one. */
function turnEnd(rest: ThreadItem[]): number {
  return Math.max(...rest.map((i) => Date.parse(i.at) + ("durationMs" in i && typeof i.durationMs === "number" ? i.durationMs : 0)));
}

/** 7s · 1m 36s · 1h 4m */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "Working for 7s" (live, ticking) or "Worked for 1m 36s" above a rule, between a message and the agent's work. */
function TurnHeader({ start, end, status, asking, expanded, controls, onToggle }: { start: string; end?: number; status?: Thread["status"]; asking?: boolean; expanded?: boolean; controls?: string; onToggle?: () => void }) {
  const live = end === undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);
  const elapsed = formatElapsed((live ? now : end) - Date.parse(start));
  const label = !live ? `Worked for ${elapsed}` : status === "waiting" ? `${asking ? "Waiting for your answer" : "Waiting for approval"} · ${elapsed}` : `Working for ${elapsed}`;
  return (
    <div className={`turn-header${live ? " live" : ""}`} data-testid="turn-header" data-live={live ? "true" : "false"}>
      {expanded === undefined ? <span className="turn-label" data-testid="turn-label">{label}</span> : <button className="turn-label" data-testid="turn-label" aria-expanded={expanded} aria-controls={controls} onClick={onToggle}><span>{label}</span><Icon name="chevron-right" size={12} className={expanded ? "chev open" : "chev"} /></button>}
    </div>
  );
}
