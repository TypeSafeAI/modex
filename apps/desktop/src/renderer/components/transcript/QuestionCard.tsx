import { createContext, useContext, useEffect, useState } from "react";
import type { AnswerResult, ThreadItem } from "../../../shared/types";
import { answerNote, type Question } from "../../../shared/human-requests";

interface QuestionDraft { choice: Record<string, string>; text: Record<string, string> }
/** Window-owned memory only; question answers must never enter composer recovery or storage. */
export const QuestionDraftContext = createContext<Map<string, QuestionDraft> | null>(null);
export type QuestionDraftCache = Map<string, QuestionDraft>;

type QuestionEntry = Extract<ThreadItem, { kind: "question" }>;

/** Why a card closed without an answer, in the approval card's words. */
const CLOSED: Record<NonNullable<QuestionEntry["withdrawn"]>, string> = {
  native: "Withdrawn — the agent no longer needs an answer",
  stopped: "Not answered — the turn was stopped",
  ended: "Not answered — the turn ended first",
};

const REFUSED: Record<Exclude<AnswerResult, { ok: true }>["reason"], string> = {
  "already-resolved": "This question was already answered.",
  withdrawn: "This question no longer needs an answer.",
  unknown: "This question is no longer available.",
  "wrong-identity": "This question changed. Nothing was sent.",
  "changed-action": "This question changed. Nothing was sent.",
  invalid: "Check the answers.",
};

const OTHER = "\u0000other";

/**
 * A question the CLI asked (docs/human-requests.md). Each question gets its own control: options as radio
 * buttons, a text field when the CLI takes free text, a password field for a secret answer. Main checks the
 * answers against the questions before anything reaches the CLI, and the card says why when it refuses.
 */
export function QuestionCard({ item, onAnswer }: { item: QuestionEntry; onAnswer: (itemId: string, answers: Record<string, string[]>) => Promise<AnswerResult | undefined> }) {
  const drafts = useContext(QuestionDraftContext);
  const [draft, setDraft] = useState<QuestionDraft>(() => drafts?.get(item.id) ?? { choice: {}, text: {} });
  const { choice, text } = draft;
  const edit = (field: "choice" | "text", id: string, value: string) => {
    const next = { ...draft, [field]: { ...draft[field], [id]: value } };
    drafts?.set(item.id, next);
    setDraft(next);
  };
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const open = !item.answers && !item.withdrawn && !item.delivery;
  useEffect(() => {
    if (!open) {
      drafts?.delete(item.id);
      setDraft({ choice: {}, text: {} });
    }
  }, [open, drafts, item.id]);
  const typed = (q: Question) => !q.options || choice[q.id] === OTHER;
  const value = (q: Question) => (typed(q) ? text[q.id] ?? "" : choice[q.id] ?? "");
  const submit = async () => {
    setSending(true);
    setError(null);
    try {
      const result = await onAnswer(item.id, Object.fromEntries(item.questions.map((q) => [q.id, value(q).trim() ? [value(q)] : []])));
      if (result && !result.ok) setError(result.error ?? REFUSED[result.reason]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  };
  return (
    <div className={`approval question-card ${open ? "" : "answered"}`} data-testid="item" data-item-kind="question" data-answered={item.answers && (!item.delivery || item.delivery === "sent") ? "true" : "false"} data-delivery={item.delivery} data-withdrawn={item.withdrawn}>
      <div className="approval-head">
        <span className="shield">?</span>
        <span>{item.questions.length === 1 ? "The agent has a question" : `The agent has ${item.questions.length} questions`}</span>
      </div>
      {item.questions.map((q) => (
        <div key={q.id} className="question-field" data-testid="question">
          <div className="question-title">{q.header || q.text}</div>
          {q.header && <div className="question-text">{q.text}</div>}
          {item.answers ? <div className="approval-answer" data-testid="question-answer">{(item.answers[q.id] ?? []).join(", ")}</div> : open && (
            <>
              {q.options && (
                <div className="question-options" role="radiogroup" aria-label={q.header || q.text}>
                  {q.options.map((o) => (
                    <label key={o.label} className="question-option">
                      <input type="radio" name={`${item.id}:${q.id}`} checked={choice[q.id] === o.label} disabled={sending} onChange={() => edit("choice", q.id, o.label)} />
                      <span>{o.label}</span>
                      {o.description && <span className="question-hint">{o.description}</span>}
                    </label>
                  ))}
                  {q.allowOther && (
                    <label className="question-option">
                      <input type="radio" name={`${item.id}:${q.id}`} checked={choice[q.id] === OTHER} disabled={sending} onChange={() => edit("choice", q.id, OTHER)} />
                      <span>Other</span>
                    </label>
                  )}
                </div>
              )}
              {typed(q) && (
                <input className="question-input" data-testid="question-input" type={q.secret ? "password" : "text"} autoComplete="off" spellCheck={!q.secret}
                  aria-label={q.options ? `${q.header || q.text}: other` : q.header || q.text} value={text[q.id] ?? ""} disabled={sending}
                  onChange={(e) => edit("text", q.id, e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submit(); }} />
              )}
            </>
          )}
        </div>
      ))}
      {item.answers && answerNote(item) && <div className="answer-note" data-testid="answer-note" data-delivery={item.delivery}>{answerNote(item)}</div>}
      {item.delivery === "uncertain" || item.delivery === "sending" ? <div className="approval-answer" role="status" data-testid="question-delivery">{item.delivery === "uncertain" ? "Delivery uncertain — not resent. Check the agent before answering again." : "Sending answer…"}</div> : item.withdrawn ? <div className="approval-answer" data-testid="question-closed">{CLOSED[item.withdrawn]}</div> : open && (
        <div className="row">
          <button className="btn primary small" data-testid="question-submit" disabled={sending} onClick={() => void submit()}>Send answers</button>
          {error && <span className="question-error" role="alert" data-testid="question-error">{error}</span>}
        </div>
      )}
    </div>
  );
}
