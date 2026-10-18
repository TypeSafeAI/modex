import { finalAnswerIndex, type ItemOrigin } from "./conversation-events.js";
import { toolFoldsAsWork } from "./tool-summary.js";
import type { ThreadItem } from "./types.js";

/** How one turn (a user message and everything after it) is laid out in the transcript. */
export interface TurnLayout {
  /** Index of the turn's final answer, or -1 when it has none. */
  final: number;
  /** Per item: settled work that may fold under the turn header once the turn is idle. */
  work: boolean[];
  /** Per item: still streaming. */
  live: boolean[];
  /** Per item: the attempt number (2, 3, …) when the item opens a later attempt, else null. */
  attemptStart: (number | null)[];
  /** Whether the turn came through the conversation-event contract; false means the legacy heuristics apply. */
  typed: boolean;
}

/**
 * Lays out one turn's items. Items from the conversation-event contract decide by their own fields:
 * the final answer is the latest attempt's `final` message (or its last reply when the CLI gives no
 * phases), every item still `running` is live, and only work that succeeded folds. Items saved
 * before the contract keep the historical heuristics, isolated here: the last reply is the answer,
 * and the newest item of a running turn is the one streaming.
 */
export function layoutTurn(items: readonly ThreadItem[], opts: { busy: boolean }): TurnLayout {
  const origins = items.map((item) => (item as { origin?: ItemOrigin }).origin);
  const typed = origins.some(Boolean);
  const attempts: string[] = [];
  const attemptStart = origins.map((origin) => {
    if (!origin || attempts.includes(origin.attempt)) return null;
    attempts.push(origin.attempt);
    return attempts.length > 1 ? attempts.length : null;
  });
  let final: number;
  if (typed) {
    // Only the latest attempt can answer: an earlier attempt's reply was superseded by the retry.
    const latest = attempts.at(-1);
    const indexes = items.map((_, i) => i).filter((i) => origins[i]?.attempt === latest);
    const local = finalAnswerIndex(indexes.map((i) => items[i]!));
    final = local < 0 ? -1 : indexes[local]!;
  } else final = finalAnswerIndex(items);
  const work = items.map((item, i) => i < final && settled(item));
  const live = items.map((item, i) => origins[i] ? (item as { outcome?: string }).outcome === "running" : opts.busy && !typed && i === items.length - 1);
  return { final, work, live, attemptStart, typed };
}

/** Whether a finished item may fold away: never a notice, a pending request, or work that did not succeed. */
function settled(item: ThreadItem): boolean {
  switch (item.kind) {
    case "tool": return toolFoldsAsWork(item);
    case "thinking": return item.status === "done";
    case "assistant": case "route": return true;
    case "approval": return Boolean(item.answer);
    default: return false;
  }
}
