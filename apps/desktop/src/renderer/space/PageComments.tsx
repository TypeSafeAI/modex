import { useEffect, useRef, useState } from "react";
import type { SpaceComment } from "../../shared/space";
import { bridge } from "../bridge";
import { ErrorNotice } from "../components/ui/ErrorNotice";
import { Icon } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";
import { SecretTextarea } from "../streamer";

export interface CommentDraft { text: string; quote: string; }

export function PageComments({ pageId, quote, draft, onDraft, onClose }: { pageId: string; quote: string; draft?: CommentDraft; onDraft: (draft: CommentDraft | undefined) => void; onClose: () => void }) {
  const [comments, setComments] = useState<SpaceComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const writing = draft !== undefined;
  const text = draft?.text ?? "";
  const excerpt = draft?.quote ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What failed and how to run it again, for the error's Retry; it applies only while `error` is still that message.
  const [failed, setFailed] = useState<{ message: string; run: () => void } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let live = true;
    void bridge.invoke("space:comments", { pageId }).then(value => { if (live) { setComments(value); setLoaded(true); } }).catch(err => { if (live) { setError(err.message); setFailed({ message: err.message, run: () => setAttempt(n => n + 1) }); } });
    return () => { live = false; };
  }, [pageId, attempt]);
  useEffect(() => { if (writing) input.current?.focus(); }, [writing]);
  const start = () => onDraft({ text: "", quote });
  const post = async () => {
    if (busy || !text.trim()) return;
    setBusy(true); setError(null);
    try {
      const saved = await bridge.invoke("space:comment:add", { pageId, text, quote: excerpt });
      setComments(all => [...all, saved]); onDraft(undefined);
    } catch (err) { const message = (err as Error).message; setError(message); setFailed({ message, run: () => void post() }); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true); setError(null);
    try { await bridge.invoke("space:comment:delete", { pageId, id }); setComments(all => all.filter(comment => comment.id !== id)); }
    catch (err) { const message = (err as Error).message; setError(message); setFailed({ message, run: () => void remove(id) }); }
    finally { setBusy(false); }
  };
  return <aside className="space-comments" aria-label="Comments">
    <header><h2>Comments</h2><IconButton icon="close" size="md" label="Close comments" onClick={onClose} /></header>
    {error && <ErrorNotice className="space-comment-error" testId="page-comments-error" where="Notes · comments" message={error} onRetry={failed?.message === error && !busy ? () => { setError(null); failed.run(); } : undefined} context={{ pageId }} />}
    {writing ? <form className="space-comment-form" onSubmit={event => { event.preventDefault(); void post(); }}>
      {excerpt && <blockquote data-streamer-quote>{excerpt}</blockquote>}
      <SecretTextarea ref={input} rows={1} aria-label="Comment" placeholder="Add a comment…" maxLength={10_000} value={text} onChange={event => onDraft({ text: event.target.value, quote: excerpt })} disabled={busy} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); void post(); } }} />
      <div><button className="space-comment-discard" type="button" aria-label="Discard" title="Discard comment" onClick={() => onDraft(undefined)} disabled={busy}><Icon name="close" size={13} /></button><button className="space-comment-submit" aria-label="Post comment" title="Post comment" disabled={busy || !text.trim()}><Icon name="arrow-up" size={14} /></button></div>
    </form> : <button className="space-comment-start" aria-label="Add comment" disabled={!loaded} onClick={start}><span>Add a comment…</span><Icon name="arrow-up" size={14} /></button>}
    <div className="space-comments-scroll">
      {!loaded && !error ? <p role="status">Loading comments…</p> : !comments.length && !writing ? <div className="space-comments-empty"><Icon name="comment" size={20} /><p>No comments yet</p><p>Select text to add a comment</p>{quote && <button className="btn small" onClick={start}>Comment on selection</button>}</div> : comments.map(comment => <article className="space-comment" key={comment.id}>
        <div className="space-comment-author"><span className="space-avatar">Y</span><strong>You</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><IconButton icon="trash" label="Delete comment" disabled={busy} onClick={() => void remove(comment.id)} /></div>
        {comment.quote && <blockquote data-streamer-quote>{comment.quote}</blockquote>}<p>{comment.text}</p>
      </article>)}
    </div>

  </aside>;
}
