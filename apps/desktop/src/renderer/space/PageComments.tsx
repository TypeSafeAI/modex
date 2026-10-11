import { useEffect, useRef, useState } from "react";
import type { SpaceComment } from "../../shared/space";
import { bridge } from "../bridge";
import { Icon } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";

export interface CommentDraft { text: string; quote: string; }

export function PageComments({ pageId, quote, draft, onDraft, onClose }: { pageId: string; quote: string; draft?: CommentDraft; onDraft: (draft: CommentDraft | undefined) => void; onClose: () => void }) {
  const [comments, setComments] = useState<SpaceComment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const writing = draft !== undefined;
  const text = draft?.text ?? "";
  const excerpt = draft?.quote ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let live = true;
    void bridge.invoke("space:comments", { pageId }).then(value => { if (live) { setComments(value); setLoaded(true); } }).catch(err => { if (live) setError(err.message); });
    return () => { live = false; };
  }, [pageId]);
  useEffect(() => { if (writing) input.current?.focus(); }, [writing]);
  const start = () => onDraft({ text: "", quote });
  const post = async () => {
    if (busy || !text.trim()) return;
    setBusy(true); setError(null);
    try {
      const saved = await bridge.invoke("space:comment:add", { pageId, text, quote: excerpt });
      setComments(all => [...all, saved]); onDraft(undefined);
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const remove = async (id: string) => {
    setBusy(true); setError(null);
    try { await bridge.invoke("space:comment:delete", { pageId, id }); setComments(all => all.filter(comment => comment.id !== id)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <aside className="space-comments" aria-label="Comments">
    <header><h2>Comments</h2><IconButton icon="close" size="md" label="Close comments" onClick={onClose} /></header>
    {error && <p className="space-comment-error" role="alert">{error}</p>}
    <div className="space-comments-scroll">
      {!loaded && !error ? <p role="status">Loading comments…</p> : !comments.length && !writing ? <div className="space-comments-empty"><Icon name="comment" size={20} /><p>No comments yet</p><p>Select text to add a comment</p>{quote && <button className="btn small" onClick={start}>Comment on selection</button>}</div> : comments.map(comment => <article className="space-comment" key={comment.id}>
        <div className="space-comment-author"><span className="space-avatar">Y</span><strong>You</strong><time dateTime={comment.createdAt}>{new Date(comment.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time><IconButton icon="trash" label="Delete comment" disabled={busy} onClick={() => void remove(comment.id)} /></div>
        {comment.quote && <blockquote>{comment.quote}</blockquote>}<p>{comment.text}</p>
      </article>)}
    </div>
    {writing ? <form className="space-comment-form" onSubmit={event => { event.preventDefault(); void post(); }}>
      {excerpt && <blockquote>{excerpt}</blockquote>}
      <textarea ref={input} aria-label="Comment" placeholder="Write a comment…" maxLength={10_000} value={text} onChange={event => onDraft({ text: event.target.value, quote: excerpt })} disabled={busy} />
      <div><span>Only on this Mac</span><button className="btn small ghost" type="button" onClick={() => onDraft(undefined)} disabled={busy}>Discard</button><button className="btn small primary" disabled={busy || !text.trim()}>Post comment</button></div>
    </form> : <footer><IconButton icon="comment" label="Add comment" size="lg" disabled={!loaded} onClick={start} /></footer>}
  </aside>;
}
