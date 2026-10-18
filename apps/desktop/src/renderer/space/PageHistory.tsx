import { useEffect, useState } from "react";
import type { SpacePage, SpacePageVersion } from "../../shared/space";
import { bridge } from "../bridge";
import { ErrorNotice } from "../components/ui/ErrorNotice";

export function PageHistory({ page, flush, refresh, onClose }: { page: SpacePage; flush(): Promise<void>; refresh(): Promise<void>; onClose(): void }) {
  const [versions, setVersions] = useState<SpacePageVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What failed and how to run it again, for the error's Retry; it applies only while `error` is still that message.
  const [failed, setFailed] = useState<{ message: string; run: () => void } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { let alive = true; void bridge.invoke("space:history", { id: page.id }).then(v => { if (alive) setVersions(v.reverse()); }).catch(err => { if (alive) { setError(err.message); setFailed({ message: err.message, run: () => setAttempt(n => n + 1) }); } }); return () => { alive = false; }; }, [page.id, page.revision, attempt]);
  const restore = async (version: number) => {
    setBusy(true); setError(null);
    try { await flush(); await bridge.invoke("space:revert", { id: page.id, revision: page.revision, version }); await refresh(); onClose(); }
    catch (err) { const message = (err as Error).message; setError(message); setFailed({ message, run: () => void restore(version) }); }
    finally { setBusy(false); }
  };
  return <section className="pages-history" aria-label="Version history">
    <div><strong>Version history</strong><button className="btn small" disabled={busy} onClick={onClose}>Close history</button></div>
    {error && <ErrorNotice testId="page-history-error" where="Notes · version history" message={error} onRetry={failed?.message === error && !busy ? () => { setError(null); failed.run(); } : undefined} context={{ pageId: page.id, revision: page.revision }} />}
    {versions.map(v => <details key={v.page.revision}><summary>Revision {v.page.revision} · {v.actor.startsWith("thread:") ? "Agent" : v.actor === "human" ? "You" : v.actor === "external" ? "Outside Modex" : "Imported"} · {v.summary}</summary>
      <p>{new Date(v.page.updatedAt).toLocaleString()} · {v.page.title || "Untitled page"}</p><pre>{v.page.markdown}</pre>
      {v.page.revision !== page.revision && <button className="btn small" disabled={busy} onClick={() => void restore(v.page.revision)}>Restore revision {v.page.revision}</button>}
    </details>)}
  </section>;
}
