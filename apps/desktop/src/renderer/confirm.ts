/**
 * Confirmation requests, answered in the app by `ConfirmHost` (components/ConfirmDialog.tsx).
 *
 * `confirmDialog` replaces `window.confirm`: it resolves true when the person accepts and false when
 * they cancel. Requests are answered one at a time, oldest first, so a second request made while one
 * is open is neither lost nor shown over it. The store is module-level so any code in the window can
 * ask, including `App`, which also renders the host. It imports nothing from the DOM or React.
 */

export type ConfirmTone = "neutral" | "warn" | "danger";
/** The subset of `ui/Icon` names a confirmation uses. */
export type ConfirmIcon = "info" | "alert" | "trash" | "changes" | "restart" | "folder" | "stack";
/** One consequence of accepting: something that is kept, or something that is lost. */
export interface ConfirmFact { kind: "kept" | "lost"; text: string }

export interface ConfirmOptions {
  /** The question. */
  title: string;
  /** One sentence of consequence. */
  body?: string;
  /** A path or identifier, shown in monospace and never truncated. */
  path?: string;
  facts?: ConfirmFact[];
  /** The accept button names the action ("Delete thread"), never "OK". */
  confirmLabel: string;
  tone?: ConfirmTone;
  icon?: ConfirmIcon;
}

export interface ConfirmRequest extends ConfirmOptions { id: number }

interface Pending { request: ConfirmRequest; resolve: (accepted: boolean) => void }

const queue: Pending[] = [];
const listeners = new Set<() => void>();
let nextId = 1;

const notify = () => { for (const listener of [...listeners]) listener(); };

/** Asks the person to confirm. Resolves true on accept, false on cancel. */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.push({ request: { ...options, id: nextId++ }, resolve });
    // A request behind another does not change what is on screen.
    if (queue.length === 1) notify();
  });
}

/** The oldest unanswered request. Its identity is stable until it is settled. */
export function currentConfirm(): ConfirmRequest | null {
  return queue[0]?.request ?? null;
}

/** Answers the current request. An id that is not current (already answered, or still queued) is ignored. */
export function settleConfirm(id: number, accepted: boolean): void {
  const head = queue[0];
  if (!head || head.request.id !== id) return;
  queue.shift();
  head.resolve(accepted);
  notify();
}

export function subscribeConfirm(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Answers every pending request with false. For a window that is starting over, and for tests. */
export function resetConfirms(): void {
  if (queue.length === 0) return;
  for (const pending of queue.splice(0)) pending.resolve(false);
  notify();
}
