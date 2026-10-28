import { toolStatusLabel, toolSummary } from "../../shared/tool-summary";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { AnswerResult, ApprovalPolicy, ApprovalReceipt, BackendId, FollowUp, Mode, ModelInfo, Project, Thread, ThreadItem, ThreadPatch, TurnFailure, TurnFix } from "../../shared/types";
import { failureReport } from "../../shared/failures";
import { askedBecause, jevNotConsulted, receiptVia } from "../../shared/approval-receipt";
import { safeHref } from "../../shared/inline";
import { answerNote } from "../../shared/human-requests";
import { parseWebSearch, splitSources, type SourceLink, type WebSearch } from "../../shared/sources";
import type { AttachmentActions } from "../composer-attachments";
import type { Attachment } from "../../shared/attachments";
import { bridge } from "../bridge";
import { AttachmentChips } from "./Attachments";
import { Composer } from "./Composer";
import { Markdown } from "./Markdown";
import { Icon } from "./ui/Icon";
import { ErrorNotice } from "./ui/ErrorNotice";
import { TurnContent, groupTurns } from "./transcript/TurnContent";
import { readerStateFor, ReaderStateContext, useExpansionState } from "./transcript/reader-state";
import { ReasoningItem } from "./transcript/ReasoningItem";
import { EvidenceCard } from "./transcript/EvidenceCard";
import { QuestionCard } from "./transcript/QuestionCard";
import { SaveTaskNote, TaskContextLine, TaskNoPlanLine, TaskPlanCard, TaskVerificationLine } from "./transcript/TaskPlanCard";
import { OUTPUT_PREVIEW_BYTES, PATCH_TOOLS, formatBytes, type NativeWebSearch } from "../../shared/evidence";
import { ToolLog } from "./transcript/ToolLog";
import { PatchCompare, TranscriptThread } from "./transcript/PatchCompare";

export { formatElapsed } from "./transcript/TurnContent";

interface Props {
  thread: Thread;
  project: Project;
  items: ThreadItem[];
  /** Unsent composer text for this thread, kept by App across thread switches. */
  text: string;
  onText: (text: string) => void;
  /** Files attached but not yet sent, kept by App like `text`. */
  attachments: Attachment[];
  attachmentActions: AttachmentActions;
  onSend: (text: string) => Promise<void>;
  onStop: () => void;
  onAnswer: (itemId: string, answer: "yes" | "no" | "always") => void;
  /** Answers a question card; resolves to main's verdict so the card can say why it was refused. */
  onAnswerQuestion: (itemId: string, answers: Record<string, string[]>) => Promise<AnswerResult | undefined>;
  onUpdate: (patch: ThreadPatch) => void;
  /** Runs the last message again after a failed turn (the failure card's Retry). */
  onRetry: () => void;
  /** Applies a failure card's remedy: types the sign-in command into the thread's terminal, or opens Settings. */
  onFix: (fix: TurnFix) => void;
  /** Brings an archived thread back to the working list; sending a message does the same. */
  onUnarchive: () => void;
  models: ModelInfo[];
  modelsError?: string;
  onRetryModels?: () => void;
  openModelPickerRequest?: number;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  /** The checkout's current branch (from the Changes snapshot), for the composer's context strip. */
  branch?: string;
}

/** `/Users/val/x` → `~/x` for display; the full path stays in the tooltip and clipboard. */
export function shortenHome(p: string): string {
  return p.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~").replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, "~");
}

/** Keeps the tail of a long path (the part that distinguishes worktrees), dropping whole leading segments. */
export function tailPath(p: string, max = 40): string {
  if (p.length <= max) return p;
  const parts = p.split("/");
  let out = "";
  for (let i = parts.length - 1; i > 0; i--) {
    const next = "/" + parts[i] + out;
    if (next.length + 1 > max) break;
    out = next;
  }
  return "…" + (out || p.slice(-(max - 1)));
}

export function ThreadView({ thread, project, items, text, onText, attachments, attachmentActions, onSend, onStop, onAnswer, onAnswerQuestion, onUpdate, onRetry, onFix, onUnarchive, models, modelsError, onRetryModels, openModelPickerRequest, inputRef, branch }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const reader = useMemo(() => readerStateFor(thread.id), [thread.id]);
  const restored = useRef(false);
  const busy = thread.status === "running" || thread.status === "waiting";
  // The follow-up suggestion answers one transcript state; main caches per state, so re-asking is cheap.
  const [followUp, setFollowUp] = useState<{ key: string; value: FollowUp | null } | null>(null);
  const suggestionKey = JSON.stringify([thread.id, thread.status, thread.plan, thread.mode, thread.auto, items.at(-1)?.id]);
  useEffect(() => {
    // A put-away thread is not asking for a next step; Jev is not consulted for it.
    if (thread.retired || thread.archived || thread.status !== "idle" || !items.length) return;
    let alive = true;
    void bridge.invoke("thread:followup", { threadId: thread.id }).then((value) => {
      if (alive) setFollowUp({ key: suggestionKey, value });
    }).catch(() => { if (alive) setFollowUp(null); });
    return () => { alive = false; };
  }, [suggestionKey, thread.retired, thread.archived]);
  // Follow new output only while the reader is at (or near) the bottom; scrolling up to read stops it.
  const stick = useRef(true);
  // Shown while the reader is away from the bottom, so they can return without losing their place first.
  const [away, setAway] = useState(false);
  const newestUser = useRef<string | undefined>(undefined);
  // Where auto-scroll last put the view. Content can change (a ticking header, streamed text) before the
  // browser delivers the reader's scroll event, so "has the reader moved it?" is read from the position
  // itself: anything above this mark means they scrolled, and following waits until they are back down.
  const autoTop = useRef(0);
  const follow = useRef((el: HTMLDivElement) => {
    if (el.scrollTop < autoTop.current - 2) stick.current = isNearBottom(el);
    if (!stick.current) return;
    el.scrollTop = el.scrollHeight;
    autoTop.current = el.scrollTop;
  }).current;
  // When the reader last scrolled by hand (wheel, keys, the scrollbar, touch), and when they jumped to
  // the latest. A Page Up still animating keeps moving the view after a jump: the browser's keyboard
  // scroll applies its remaining distance whatever the page sets. A scroll with no input since the
  // jump is that leftover motion, not the reader, and the jump holds.
  const lastInput = useRef(0);
  const jumpedAt = useRef(-Infinity);
  const onInput = () => { lastInput.current = performance.now(); };
  const pin = (el: HTMLDivElement) => {
    el.scrollTop = el.scrollHeight;
    autoTop.current = el.scrollTop;
  };
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const leftover = lastInput.current < jumpedAt.current && performance.now() - jumpedAt.current < 1000;
    // A scroll event is delivered before the browser reports a resize. If the view only got shorter
    // under a reader who is following (the composer gaining a follow-up chip right after Jump to
    // latest), it has not been scrolled up: keep following.
    if (stick.current && (leftover || el.scrollTop >= autoTop.current - 2)) {
      pin(el);
      setAway(false);
      return;
    }
    stick.current = isNearBottom(el);
    if (stick.current) autoTop.current = el.scrollTop;
    setAway(!stick.current);
  };
  const jumpToLatest = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    jumpedAt.current = performance.now();
    pin(el);
    setAway(false);
  };
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !items.length || restored.current) return;
    restored.current = true;
    newestUser.current = items.filter(item => item.kind === "user").at(-1)?.id;
    if (reader.scroll) {
      stick.current = reader.scroll.follow;
      el.scrollTop = reader.scroll.top;
      autoTop.current = el.scrollTop;
      setAway(!stick.current);
    }
  }, [items.length, reader]);
  useLayoutEffect(() => () => {
    const el = scroller.current;
    if (el) reader.scroll = { top: el.scrollTop, follow: stick.current };
  }, [reader]);
  // Output also grows without new items (streamed text, a pane opening and re-wrapping the prose):
  // keep following those while stuck to the bottom.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onChange = () => follow(el);
    const resize = new ResizeObserver(onChange);
    resize.observe(el);
    const mutate = new MutationObserver(onChange);
    mutate.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      mutate.disconnect();
    };
  }, []);
  useEffect(() => {
    const el = scroller.current;
    // React may batch the user message with the first reasoning/tool event. Find the newest
    // user id instead of requiring the user item to be last in a particular render.
    let userId: string | undefined;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]!.kind === "user") { userId = items[i]!.id; break; }
    }
    if (userId !== newestUser.current) {
      newestUser.current = userId;
      if (userId) {
        stick.current = true;
        autoTop.current = 0;
      }
    }
    if (el) follow(el);
  }, [thread.id, items.length, items.at(-1)]);
  const turns = groupTurns(items);
  let lastUser = -1;
  turns.forEach((t, i) => { if (t.user) lastUser = i; });
  // Retry belongs on the newest failure, and only while nothing but notices has followed it.
  // The latest reply's own questions can be answered while no turn runs and nothing was sent after it.
  let askId: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind === "user") break;
    if (item.kind === "assistant" && item.asks?.length) { askId = item.id; break; }
  }
  let retryId: string | undefined;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!;
    if (item.kind !== "notice") break;
    if (item.failure) { retryId = item.id; break; }
  }

  return (
    <ReaderStateContext.Provider value={reader}><section className="thread-view" data-testid="thread-view" data-thread-id={thread.id}>

      <TranscriptThread.Provider value={thread.id}>
      <div className="transcript" ref={scroller} data-testid="transcript" onScroll={onScroll} onWheel={onInput} onKeyDown={onInput} onPointerDown={onInput} onTouchStart={onInput}>
        {items.length === 0 && (
          <div className="transcript-empty">
            <p>Describe a task. Modex will inspect <code>{thread.cwd}</code>, then read, edit, and run what it needs — asking first when the mode requires it.</p>
          </div>
        )}
        {turns.map((turn, i) => (
          <TurnContent key={turn.user?.id ?? `pre-${i}`} turn={turn} status={i === lastUser && busy ? thread.status : undefined}
            footer={(t) => <><TaskNoPlanLine items={t.rest} /><TaskVerificationLine items={t.rest} /><TaskContextLine items={t.rest} cwd={thread.cwd} /><SaveTaskNote threadId={thread.id} turnId={t.user!.id} saved={Boolean(thread.taskNotes?.[t.user!.id])} /></>}
            render={(item, live) => <Item key={item.id} item={item} live={live} onAnswer={onAnswer} onAnswerQuestion={onAnswerQuestion} onPolicy={(approvals) => onUpdate({ approvals })} onFix={onFix} onRetry={!thread.retired && !busy && item.id === retryId ? onRetry : undefined} onReply={!thread.retired && !busy && item.id === askId ? (text) => void onSend(text) : undefined} />} />
        ))}
      </div>
      </TranscriptThread.Provider>
      {away && items.length > 0 && <button type="button" className="jump-latest" data-testid="jump-latest" onClick={(e) => {
        // The button goes away at the bottom; focus goes to the message box there, not the page body.
        const held = document.activeElement === e.currentTarget;
        jumpToLatest();
        if (held) inputRef.current?.focus({ preventScroll: true });
      }}>Jump to latest<Icon name="chevron-down" size={12} /></button>}
      {!busy && !thread.retired && items.at(-1)?.kind === "user" && !attachmentActions.sending && <div className="notice" data-testid="saved-message-recovery">
        <p>This message is saved. Start its coding turn when you are ready.</p>
        <button type="button" className="btn small" data-testid="saved-message-retry" onClick={onRetry}>Retry saved message</button>
      </div>}

      {thread.archived && <div className="notice" data-testid="archived-notice">
        <p>This thread is archived.{!thread.retired && " Sending a message brings it back."}</p>
        <button type="button" className="btn small" data-testid="archived-restore" onClick={onUnarchive}>Unarchive</button>
      </div>}
      {thread.retired ? <p className="notice" data-testid="retired-notice">Pull request #{thread.retired.pr} merged. This task is finished; start a new thread to continue.</p> : <Composer
        text={text}
        onText={onText}
        attachments={attachments}
        attachmentActions={attachmentActions}
        busy={busy}
        context={{ project: project.name, cwd: thread.cwd, worktree: thread.worktree, branch }}
        backend={thread.backend}
        mode={thread.mode}
        approvals={thread.approvals ?? "ask"}
        onApprovals={(approvals) => onUpdate({ approvals })}
        plan={thread.plan}
        model={thread.model}
        effort={thread.effort}
        auto={Boolean(thread.auto)}
        models={models}
        modelsError={modelsError}
        onRetryModels={onRetryModels}
        openModelPickerRequest={openModelPickerRequest}
        suggestion={followUp?.key === suggestionKey ? followUp.value : null}
        onBackend={(backend: BackendId) => onUpdate({ backend })}
        onMode={(mode: Mode) => onUpdate({ mode })}
        onPlan={(plan: boolean) => onUpdate({ plan })}
        onModel={(model, effort) => onUpdate({ model, effort })}
        onEffort={(effort) => onUpdate({ effort })}
        onAuto={(auto) => onUpdate({ auto })}
        onSend={onSend}
        onStop={onStop}
        inputRef={inputRef}
      />}
    </section></ReaderStateContext.Provider>
  );
}

/** Within this many px of the bottom counts as "at the bottom" for auto-scroll. */
const STICK_PX = 80;
export function isNearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_PX;
}

function Item({ item, live, onAnswer, onAnswerQuestion, onPolicy, onFix, onRetry, onReply }: { item: ThreadItem; live?: boolean; onAnswer: Props["onAnswer"]; onAnswerQuestion: Props["onAnswerQuestion"]; onPolicy?: (p: ApprovalPolicy) => void; onFix: Props["onFix"]; onRetry?: () => void; onReply?: (text: string) => void }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="msg user" data-testid="item" data-item-kind="user">
          {item.text && <div className="bubble" data-testid="item-text">{item.text}</div>}
          {item.attachments?.length ? <AttachmentChips attachments={item.attachments} onOpen={(a) => void bridge.invoke("attachments:open", { rel: a.rel }).catch(() => {})} /> : null}
        </div>
      );
    case "assistant":
      return <AssistantItem text={item.text} live={Boolean(live)} phase={item.phase} outcome={item.outcome} evidence={item.evidence} asks={item.asks} onReply={onReply} />;
    case "tool":
      return <ToolItem item={item} />;
    case "approval":
      return <ApprovalItem item={item} onAnswer={onAnswer} onPolicy={onPolicy} />;
    case "question":
      return <QuestionCard item={item} onAnswer={onAnswerQuestion} />;
    case "notice":
      if (item.failure) return <FailureItem failure={item.failure} onFix={onFix} onRetry={onRetry} />;
      if (item.pages) return <div className="notice info" data-testid="item" data-item-kind="notice"><span>{item.text} </span><button className="btn small" aria-label={`Open note ${item.pages.title}`} onClick={() => window.dispatchEvent(new CustomEvent("modex:open-page", { detail: item.pages!.pageId }))}>{item.pages.title}<Icon name="arrow-right" size={12} /></button></div>;
      if (item.knowledge) return <KnowledgeReceipt item={item} />;
      return <div className={`notice ${item.level}`} data-testid="item" data-item-kind="notice" data-level={item.level}>{item.text}</div>;
    case "thinking":
      return <ReasoningItem item={item} />;
    case "route":
      return <RouteItem item={item} />;
    case "plan":
      return <TaskPlanCard item={item} />;
  }
}

function KnowledgeReceipt({ item }: { item: Extract<ThreadItem, { kind: "notice" }> }) {
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const open = async () => {
    if (!item.knowledge) return;
    setOpening(true); setError(null);
    try { await bridge.invoke("knowledge:open", { folder: item.knowledge.folder, path: item.knowledge.path }); }
    catch (err) { setError((err as Error).message); }
    finally { setOpening(false); }
  };
  return <div className="notice info" data-testid="item" data-item-kind="notice">
    <span>{item.text} </span><button className="btn small" disabled={opening} onClick={() => void open()} aria-label={`Open knowledge page ${item.knowledge!.path}`}>{item.knowledge!.path}<Icon name="arrow-right" size={12} /></button>
    {error && <ErrorNotice testId="knowledge-open-error" where="Knowledge · open page" message={error} onRetry={opening ? undefined : () => void open()} context={{ folder: item.knowledge?.folder, path: item.knowledge?.path }} />}
  </div>;
}

/**
 * An answer. A trailing "Sources:" list becomes numbered cards once the text has stopped streaming;
 * until then it reads as the list it is, so the cards never flicker in and out mid-line.
 */
/** A reply. Commentary reads as progress, not the answer; a reply that stopped or never completed says so. */
function AssistantItem({ text, live, phase, outcome, evidence, asks, onReply }: { text: string; live: boolean; phase?: Extract<ThreadItem, { kind: "assistant" }>["phase"]; outcome?: Extract<ThreadItem, { kind: "assistant" }>["outcome"]; evidence?: Extract<ThreadItem, { kind: "assistant" }>["evidence"]; asks?: Extract<ThreadItem, { kind: "assistant" }>["asks"]; onReply?: (text: string) => void }) {
  const { body, sources } = useMemo(() => (live ? { body: text, sources: [] } : splitSources(text)), [text, live]);
  const ended = outcome === "interrupted" ? "Stopped before it finished" : outcome === "unknown" ? "This reply may be incomplete"
    : outcome === "failed" ? "Reply failed" : outcome === "denied" ? "Reply denied" : null;
  return (
    <div className={`msg assistant${phase === "commentary" ? " commentary" : ""}`} data-testid="item" data-item-kind="assistant" data-phase={phase} data-outcome={outcome}>
      <Markdown text={body} />
      {evidence?.length ? <EvidenceCard evidence={evidence} /> : null}
      {asks?.length ? <MessageAsks asks={asks} onReply={onReply} /> : null}
      {sources.length > 0 && <Sources links={sources} />}
      {ended && <div className="msg-status" data-testid="message-status">{ended}</div>}
    </div>
  );
}

/**
 * Questions the agent asked in its reply (Codex `agentMessage.questions`). They are not a request: the next
 * message is the answer, so an option sends itself as that message, and only from the latest reply.
 */
function MessageAsks({ asks, onReply }: { asks: NonNullable<Extract<ThreadItem, { kind: "assistant" }>["asks"]>; onReply?: (text: string) => void }) {
  return (
    <div className="message-asks" data-testid="message-asks">
      {asks.map((ask, i) => (
        <div key={i} className="message-ask" data-testid="message-ask">
          <p className="message-ask-title">{ask.title}</p>
          {ask.options && <div className="message-ask-options">
            {ask.options.map((option) => <button key={option} type="button" className="btn small" data-testid="message-ask-option" disabled={!onReply} onClick={() => onReply?.(option)}>{option}</button>)}
          </div>}
        </div>
      ))}
      <p className="message-ask-note">{onReply ? "Codex asked this in its reply. Your next message is the answer." : "Codex asked this in its reply."}</p>
    </div>
  );
}

function Sources({ links }: { links: SourceLink[] }) {
  return (
    // Read from a "Sources:" list the model wrote: ordinary links, not citations Modex has verified.
    <div className="sources" data-testid="sources" data-provenance="reply-text" title="Links the model wrote in its reply. Modex has not checked them.">
      <div className="sources-label">{links.length === 1 ? "Link in the reply" : `Links in the reply · ${links.length}`}</div>
      <ol className="sources-list">
        {links.map((l, i) => (
          <li key={l.url}>
            <a className="source" data-testid="source-link" href={l.url} target="_blank" rel="noreferrer" title={l.url}>
              <span className="source-index" aria-hidden="true">{i + 1}</span>
              <span className="source-text">
                <span className="source-title">{l.title}</span>
                <span className="source-domain">{l.domain}</span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * A turn that did not complete: what went wrong in plain words, the CLI's own message, and the
 * ways out — a contextual resolve action, Retry (newest failure only), the fix when Modex has one, and Copy details, which
 * puts the full report (also shown by Details) on the clipboard for a bug report.
 */
function FailureItem({ failure, onFix, onRetry }: { failure: TurnFailure; onFix: Props["onFix"]; onRetry?: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const report = failureReport(failure);
  const hasResolveAction = Boolean(failure.fix && failure.fix.kind !== "retry");
  const copy = () => {
    void bridge.invoke("clipboard:write", { text: report }).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="failure" data-testid="item" data-item-kind="notice" data-level="error" data-failure-code={failure.code} role="alert">
      <div className="failure-head">
        <span className="failure-icon" aria-hidden="true">!</span>
        <span data-testid="failure-summary">{failure.summary}</span>
      </div>
      {failure.hint && <div className="failure-hint" data-testid="failure-hint">{failure.hint}</div>}
      {failure.message !== failure.summary && <pre className="failure-message" data-testid="failure-message">{failure.message}</pre>}
      <div className="row failure-actions">
        {onRetry && failure.retryable && <button type="button" className={`btn ${hasResolveAction ? "ghost" : "primary"} small`} data-testid="failure-retry" onClick={onRetry}>{failure.fix?.kind === "retry" ? failure.fix.label : "Retry"}</button>}
        {failure.fix && failure.fix.kind !== "retry" && <button type="button" className="btn primary small" data-testid="failure-fix" data-fix-kind={failure.fix.kind} onClick={() => onFix(failure.fix!)}>{failure.fix.label}</button>}
        {!onRetry && failure.fix?.kind === "retry" && <button type="button" className="btn primary small" data-testid="failure-fix" data-fix-kind="retry" onClick={() => onFix(failure.fix!)}>{failure.fix.label}</button>}
        <button type="button" className="btn small" data-testid="failure-copy" onClick={copy}>{copied ? "Copied" : "Copy details"}</button>
        <button type="button" className="btn ghost small" data-testid="failure-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? "Hide details" : "Details"}</button>
      </div>
      {open && <pre className="failure-report" data-testid="failure-report">{report}</pre>}
    </div>
  );
}

type ApprovalEntry = Extract<ThreadItem, { kind: "approval" }>;

/** A card closed without anyone answering it says why, rather than "Denied". */
const WITHDRAWN: Record<NonNullable<ApprovalEntry["withdrawn"]>, string> = {
  native: "Withdrawn — the agent no longer needs an answer",
  stopped: "Not answered — the turn was stopped",
  ended: "Not answered — the turn ended first",
};

/**
 * An approval. A rule's allow or refusal is a compact receipt row (the turn never waited on it);
 * anything a human answers is today's card, plus one line saying why when a rule sent it here.
 */
function ApprovalItem({ item, onAnswer, onPolicy }: { item: ApprovalEntry; onAnswer: Props["onAnswer"]; onPolicy?: (p: ApprovalPolicy) => void }) {
  const card = useRef<HTMLDivElement>(null);
  // The answer buttons go away once pressed. Someone answering from the keyboard or VoiceOver
  // lands on the answer line ("Sending decision…", then "Approved") instead of the page body.
  const refocus = useRef(false);
  const answer = (value: "yes" | "no" | "always") => {
    refocus.current = !!card.current?.contains(document.activeElement);
    onAnswer(item.id, value);
  };
  useLayoutEffect(() => {
    if (!item.answer || !refocus.current) return;
    refocus.current = false;
    card.current?.querySelector<HTMLElement>('[data-testid="approval-answer"]')?.focus({ preventScroll: true });
  }, [item.answer]);
  const r = item.decidedBy;
  if (r && item.answer && r.decision !== "ask") return <ApprovalReceiptRow item={item} receipt={r} />;
  return (
    <div ref={card} className={`approval ${item.answer ? "answered" : ""}`} data-testid="item" data-item-kind="approval" data-answered={item.answer && (!item.delivery || item.delivery === "sent") ? "true" : "false"} data-delivery={item.delivery} data-decided-by={r?.decision}>
      <div className="approval-head" data-testid="approval-question">
        <span className="shield">⚠</span>
        <span>{item.question}</span>
      </div>
      {r?.decision === "ask" && <div className="approval-reason" data-testid="approval-reason">{askedBecause(r)}</div>}
      {item.detail && <pre className="detail">{item.detail}</pre>}
      {item.answer ? (
        <>
          <div className="approval-answer" data-testid="approval-answer" data-withdrawn={item.withdrawn} tabIndex={-1}>{item.delivery === "uncertain" ? "Delivery uncertain — not resent" : item.delivery === "sending" ? "Sending decision…" : item.withdrawn ? WITHDRAWN[item.withdrawn] : item.answer === "yes" ? "Approved" : item.answer === "always" ? "Approved — always for this command" : "Denied"}</div>
          {!item.withdrawn && answerNote(item) && <div className="answer-note" data-testid="answer-note" data-delivery={item.delivery}>{answerNote(item)}</div>}
        </>
      ) : (
        <div className="row">
          <button className="btn primary small" onClick={() => answer("yes")}>Approve</button>
          {item.canAlways !== false && <button className="btn small" onClick={() => answer("always")}>Always</button>}
          {onPolicy && <button className="btn small" data-testid="approval-always-thread" title="Approve this and everything else in this thread, except extra sandbox access" onClick={() => { onPolicy("always"); answer("yes"); }}>Always allow in thread</button>}
          {onPolicy && <button className="btn small" data-testid="approval-yolo" title="Approve this and everything else in this thread, extra sandbox access included" onClick={() => { if (window.confirm("YOLO approves every action in this thread without asking, including access outside the sandbox. Your Never rules still refuse.\n\nTurn on YOLO for this thread?")) onPolicy("yolo"); }}>YOLO</button>}
          <button className="btn danger small" onClick={() => answer("no")}>Deny</button>
        </div>
      )}
    </div>
  );
}

/** "✓ Allowed: $ npm test · rule "run the test suite" · Jev 0.94 · 410 ms", or the same row for a refusal. Expands to the request. */
function ApprovalReceiptRow({ item, receipt: r }: { item: ApprovalEntry; receipt: ApprovalReceipt }) {
  const [open, setOpen] = useState(false);
  const allowed = r.decision === "allow";
  const title = item.title ?? item.question;
  const via = `${receiptVia(r)} · ${r.ms} ms${jevNotConsulted(r) ? " · Jev not consulted" : ""}`;
  return (
    <div className={`approval-receipt ${allowed ? "allowed" : "refused"} ${open ? "open" : ""}`} data-testid="item" data-item-kind="approval" data-answered={!item.delivery || item.delivery === "sent" ? "true" : "false"} data-delivery={item.delivery} data-decided-by={r.decision}>
      <button className="receipt-head" data-testid="item-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="receipt-icon" aria-hidden="true">{allowed ? "✓" : "✕"}</span>
        <span className="receipt-label" data-testid="approval-receipt">
          {allowed ? <>Allowed: <code>{title}</code></> : r.source === "policy" ? <>Refused: <code>{title}</code></> : <>Refused by rule "{r.when}"</>}
        </span>
        <span className="receipt-meta" data-testid="receipt-meta">{r.source === "policy" ? r.when : allowed ? `rule "${r.when}" · ${via}` : <><code>{title}</code> · {via}</>}</span>
        <Icon name="chevron-right" size={12} className={`chev${open ? " open" : ""}`} />
      </button>
      {item.delivery && item.delivery !== "sent" && <div className="answer-note" role="status" data-testid="approval-delivery">{item.delivery === "uncertain" ? "Delivery uncertain — not resent" : "Sending decision…"}</div>}
      {open && (
        <div className="receipt-body" data-testid="item-body">
          <div className="receipt-question">{item.question}</div>
          {item.detail && <pre className="detail">{item.detail}</pre>}
          <div className="dim">
            {r.source === "policy"
              ? allowed ? `Approved because this thread is set to "${r.when}".` : `Refused automatically. ${r.when}: a routine is read-only and nobody is there to answer.`
              : <>{allowed ? "Approved once" : "Denied"} by your rule "{r.when}" ({receiptVia(r)}, {r.ms} ms){r.destructive !== undefined ? `; Jev put the chance that it is destructive at ${r.destructive.toFixed(2)}` : ""}.
                {jevNotConsulted(r) ? " Jev was not consulted (not configured or unavailable), so only rules with an exact match could apply and nothing was checked for destructive effects." : ""}</>}
          </div>
        </div>
      )}
    </div>
  );
}

/** One Auto decision: what runs this turn, and — expanded — the judge's reasons. */
function RouteItem({ item }: { item: Extract<ThreadItem, { kind: "route" }> }) {
  const [open, setOpen] = useState(false);
  const backend = item.backend === "claude" ? "Claude" : item.backend === "codex" ? "Codex" : item.backend === "opencode" ? "OpenCode" : item.backend === "mimo" ? "MiMo Code" : "Mock";
  const extras = [item.effort, item.fast ? "fast" : null].filter(Boolean).join(" · ");
  return (
    <div className={`route ${item.source} ${open ? "open" : ""}`} data-testid="item" data-item-kind="route" data-source={item.source}>
      <button className="route-head" data-testid="item-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="route-icon">⚡</span>
        <span className="route-label" data-testid="route-label">
          {item.blocked ? "Auto blocked" : item.pinned || item.held ? "Auto kept" : "Auto picked"} <b>{backend} · {item.model || "CLI default"}</b>{extras ? ` · ${extras}` : ""}
        </span>
        <span className="route-meta" data-testid="route-meta">{item.task.replace(/_/g, " ")} · {item.source === "jev" ? `Jev ${item.confidence.toFixed(2)}` : "heuristic"}</span>
        <Icon name="chevron-right" size={12} className={`chev${open ? " open" : ""}`} />
      </button>
      {open && (
        <ul className="route-body" data-testid="item-body">
          {item.reasons.map((r, i) => <li key={i}>{r}</li>)}
          <li className="dim">Judged in {item.durationMs} ms · complexity {item.complexity}/3 · task confidence {item.confidence.toFixed(2)}</li>
        </ul>
      )}
    </div>
  );
}

/** Collapsible reasoning: open while the model is still thinking, folded to one line once done. */

function ToolItem({ item }: { item: Extract<ThreadItem, { kind: "tool" }> }) {
  const [open, setOpen] = useExpansionState<boolean>(`tool:${item.id}`, false);
  // Claude Code calls them WebSearch and WebFetch; Codex reports a `webSearch` item.
  const web = item.name === "WebSearch" || item.name === "webSearch" ? "search" : item.name === "WebFetch" ? "fetch" : null;
  const search = useMemo(() => (web === "search" && item.output && item.ok !== false ? parseWebSearch(item.output) : null), [web, item.output, item.ok]);
  // Codex reports a search's results structured (CF-5); one stored before that kept the JSON string "" as output.
  const native = web === "search" ? item.search : undefined;
  const output = web === "search" && item.output === '""' ? undefined : item.output;
  const count = native ? native.results.filter((r) => safeHref(r.url)).length : search?.links.length;
  const page = web === "fetch" && typeof item.args.url === "string" ? safeHref(item.args.url) : null;
  const icon = web === "search" ? <Icon name="search" size={13} /> : web === "fetch" ? <Icon name="globe" size={13} /> : item.name === "shell" ? "›_" : item.name === "apply_patch" || item.name === "write_file" ? "✎" : "◫";
  const summary = toolSummary(item);
  const status = toolStatusLabel(item);
  const outcome = count !== undefined ? `${count} ${count === 1 ? "result" : "results"}` : status.toLowerCase();
  return (
    <div className={`tool ${item.status} ${item.ok === false ? "failed" : ""}`} data-testid="item" data-item-kind="tool" data-status={item.status} data-ok={item.ok === false ? "false" : "true"}>
      <button className="tool-head" data-testid="item-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`${status}: ${summary}`} title={summary}>
        <span className="tool-icon">{icon}</span>
        <code className="tool-title" data-testid="tool-title"><span data-testid="tool-summary">{summary}</span></code>
        {item.status === "running" ? <span className="spinner" aria-label="Working" /> : <span className="tool-meta" data-testid="tool-meta">{outcome}{item.durationMs != null ? ` · ${(item.durationMs / 1000).toFixed(1)}s` : ""}</span>}
        <Icon name="chevron-right" size={12} className={`chev${open ? " open" : ""}`} />
      </button>
      {open && (
        <div className="tool-body" data-testid="item-body">
          {item.exec && <div className="tool-exec">
            <code className="tool-command" data-testid="tool-command">{item.exec.command}</code>
            {item.exec.cwd && <span className="tool-cwd" data-testid="tool-cwd">in {item.exec.cwd}</span>}
            {item.status === "done" && <span className="tool-exit" data-testid="tool-exit">{exitLabel(item.exitCode)}</span>}
          </div>}
          {PATCH_TOOLS.has(item.name) && <div className="tool-patch-note" data-testid="tool-patch-note">The patch as this turn applied it. The working tree may have changed since; Changes shows it now.</div>}
          {PATCH_TOOLS.has(item.name) && <PatchCompare item={item} />}
          {item.name === "apply_patch" && typeof item.args.patch === "string" ? <Patch text={item.args.patch} /> : null}
          {item.outputTruncated && item.outputBytes != null && <div className="tool-truncated" data-testid="tool-truncated">Showing the last {formatBytes(OUTPUT_PREVIEW_BYTES)} of {formatBytes(item.outputBytes)}.</div>}
          {item.outputTruncated && <ToolLog item={item} />}
          {page && <a className="tool-link" data-testid="tool-link" href={page} target="_blank" rel="noreferrer">{page}</a>}
          {native ? <NativeSearchResults search={native} /> : search ? <SearchResults search={search} />
            : output ? (web === "fetch" && item.ok !== false ? <div className="tool-prose" data-testid="tool-output"><Markdown text={output} /></div> : <pre className="output" data-testid="tool-output">{output}</pre>)
            : item.status === "running" ? <pre className="output dim">running…</pre> : null}
          {item.name !== "apply_patch" && Object.keys(item.args).length > 0 && <details className="tool-arguments">
            <summary>Arguments</summary>
            <pre className="output" data-testid="tool-arguments">{JSON.stringify(item.args, null, 2)}</pre>
          </details>}
        </div>
      )}
    </div>
  );
}

/** What a web search found: the results as links, then what the search tool told the model about them. */
function SearchResults({ search }: { search: WebSearch }) {
  return (
    <div className="search" data-testid="search-results">
      {search.links.length > 0 && (
        <ol className="search-links">
          {search.links.map((l) => (
            <li key={l.url}>
              <a className="search-link" data-testid="search-result" href={l.url} target="_blank" rel="noreferrer" title={l.url}>
                <span className="source-title">{l.title}</span>
                <span className="source-domain">{l.domain}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
      {search.summary && <div className="search-summary" data-testid="search-summary"><Markdown text={search.summary} /></div>}
    </div>
  );
}

/**
 * A web search as Codex reported it: the page it opened, if any, and its results as links with their
 * snippets. Labelled as unchecked: a result is what the search returned, not proof of the reply.
 * Showing it fetches nothing; a link opens in the browser only when clicked.
 */
function NativeSearchResults({ search }: { search: NativeWebSearch }) {
  // Main kept only http(s) links; a stored thread is checked again before anything becomes a link.
  const action = search.action && search.action.kind !== "search" ? search.action : undefined;
  const page = action && safeHref(action.url) ? action : undefined;
  const results = search.results.flatMap((r) => { const url = safeHref(r.url); return url ? [{ ...r, url }] : []; });
  return (
    <div className="search" data-testid="search-results" data-provenance="codex-search">
      <div className="search-label" data-testid="search-label">{results.length ? "Results Codex reported. Modex has not checked them." : "What Codex reported. Modex has not checked it."}</div>
      {page && <a className="tool-link" data-testid="search-page" href={page.url} target="_blank" rel="noreferrer">{page.kind === "findInPage" ? `Searched ${page.url}${page.pattern ? ` for “${page.pattern}”` : ""}` : `Opened ${page.url}`}</a>}
      {results.length > 0 && (
        <ol className="search-links">
          {results.map((r, i) => (
            <li key={`${i}:${r.url}`}>
              <a className="search-link" data-testid="search-result" href={r.url} target="_blank" rel="noreferrer" title={r.url}>
                <span className="source-title">{r.title}</span>
                <span className="source-domain">{r.domain}</span>
              </a>
              {r.snippet && <p className="search-snippet" data-testid="search-snippet">{r.snippet}</p>}
            </li>
          ))}
        </ol>
      )}
      {search.dropped ? <div className="search-dropped" data-testid="search-dropped">{search.dropped} more {search.dropped === 1 ? "result had" : "results had"} no web link and {search.dropped === 1 ? "is" : "are"} not shown.</div> : null}
    </div>
  );
}

export function Patch({ text }: { text: string }) {
  return (
    <pre className="patch">
      {text.split("\n").map((l, i) => {
        const cls = l.startsWith("***") ? "hdr" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "";
        return <div key={i} className={cls}>{l || " "}</div>;
      })}
    </pre>
  );
}

/** How a command ended, as the CLI reported it: a code, an explicit none, or nothing reported. */
function exitLabel(code: number | null | undefined): string {
  return typeof code === "number" ? `Exit code ${code}` : code === null ? "No exit code" : "Exit code not reported";
}

