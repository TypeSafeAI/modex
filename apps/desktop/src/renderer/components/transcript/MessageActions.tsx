import { useState } from "react";
import type { ThreadItem } from "../../../shared/types";
import { layoutTurn } from "../../../shared/turn-layout";
import { bridge } from "../../bridge";
import { IconButton } from "../ui/IconButton";
import { ErrorNotice } from "../ui/ErrorNotice";
import { SaveTaskNote } from "./TaskPlanCard";
import type { Turn } from "./TurnContent";

/** "Wednesday 9:17 PM" within a week, else "Nov 4, 9:17 PM". */
function when(at: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const recent = Date.now() - date.getTime() < 6 * 86_400_000;
  return `${recent ? date.toLocaleDateString([], { weekday: "long" }) : date.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

/**
 * Under a finished turn's answer: copy it, rate it, and when it was written. A rating is the person's own
 * note on the reply, saved with the thread on this Mac; it is sent to no CLI, provider or service.
 */
export function MessageActions({ threadId, turn, readOnly, noteSaved }: { threadId: string; turn: Turn; readOnly?: boolean; /** The turn already has a note: saving updates it. */ noteSaved?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [note, setNote] = useState<{ busy: boolean; result?: { pageId: string; title: string; created: boolean; preserved: boolean }; error?: string }>({ busy: false });
  const turnId = turn.user?.id;
  const saveNote = async () => {
    if (!turnId) return;
    setNote((current) => ({ ...current, busy: true, error: undefined }));
    try { setNote({ busy: false, result: await bridge.invoke("task:save-note", { threadId, turnId }) }); }
    catch (failure) { setNote({ busy: false, error: (failure as Error).message }); }
  };
  const [error, setError] = useState("");
  const final = layoutTurn(turn.rest, { busy: false }).final;
  const answer = turn.rest[final] ?? [...turn.rest].reverse().find((item) => item.kind === "assistant");
  // A turn with no answer text has nothing to copy or rate, but its record can still be saved.
  if (!answer || answer.kind !== "assistant" || !answer.text.trim()) return turnId ? <SaveTaskNote threadId={threadId} turnId={turnId} saved={Boolean(noteSaved)} /> : null;
  const item: Extract<ThreadItem, { kind: "assistant" }> = answer;
  const copy = () => {
    void bridge.invoke("clipboard:write", { text: item.text }).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, (e: Error) => setError(e.message));
  };
  const rate = (vote: "up" | "down") => {
    setError("");
    void bridge.invoke("thread:vote", { threadId, itemId: item.id, vote: item.vote === vote ? null : vote }).catch((e: Error) => setError(e.message));
  };
  return (
    <div className="msg-actions" data-testid="message-actions" role="group" aria-label="Reply actions">
      <IconButton icon={copied ? "check" : "copy"} label={copied ? "Copied" : "Copy reply"} size="md" data-testid="message-copy" tooltipSide="bottom" onClick={copy} />
      <IconButton icon="thumb-up" solid={item.vote === "up"} label={item.vote === "up" ? "Remove good rating" : "Good reply"} size="md" aria-pressed={item.vote === "up"} disabled={readOnly} data-testid="message-vote-up" tooltipSide="bottom" onClick={() => rate("up")} />
      <IconButton icon="thumb-down" solid={item.vote === "down"} label={item.vote === "down" ? "Remove poor rating" : "Poor reply"} size="md" aria-pressed={item.vote === "down"} disabled={readOnly} data-testid="message-vote-down" tooltipSide="bottom" onClick={() => rate("down")} />
      {turnId && <IconButton icon={note.result ? "check" : "page"} label={noteSaved || note.result ? "Update note" : "Save to Notes"} size="md" disabled={note.busy} data-testid="save-task-note" tooltipSide="bottom" onClick={() => void saveNote()} />}
      <time className="msg-time" dateTime={item.at} data-testid="message-time">{when(item.at)}</time>
      {item.vote && <span className="msg-vote-note" data-testid="message-vote-note">Rating kept on this Mac</span>}
      {error && <span className="msg-vote-note" role="alert">{error}</span>}
      {note.result && <span className="msg-vote-note task-note-saved" data-testid="task-note-saved">
        {note.result.created ? (note.result.preserved ? "The note was edited since; saved as a new note · " : "Saved to Notes · ") : "Updated in Notes · "}{note.result.title}
        <button type="button" className="btn small" onClick={() => window.dispatchEvent(new CustomEvent("modex:open-page", { detail: note.result!.pageId }))}>Open</button>
      </span>}
      {note.error && <ErrorNotice testId="task-note-error" where="Notes · save task" message={note.error} onRetry={note.busy ? undefined : () => void saveNote()} context={{ threadId, turnId }} />}
    </div>
  );
}
