import { useEffect, useState } from "react";
import type { SpacePage, SpacePageVersion } from "../../shared/space";
import { bridge } from "../bridge";

export function PageHistory({ page, flush, refresh, onClose }: { page: SpacePage; flush(): Promise<void>; refresh(): Promise<void>; onClose(): void }) {
  const [versions, setVersions] = useState<SpacePageVersion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { let alive = true; void bridge.invoke("space:history", { id: page.id }).then(v => { if (alive) setVersions(v.reverse()); }).catch(err => { if (alive) setError(err.message); }); return () => { alive = false; }; }, [page.id, page.revision]);
  const restore = async (version: number) => {
    setBusy(true); setError(null);
    try { await flush(); await bridge.invoke("space:revert", { id: page.id, revision: page.revision, version }); await refresh(); onClose(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="pages-history" aria-label="Version history">
    <div><strong>Version history</strong><button className="btn small" disabled={busy} onClick={onClose}>Close history</button></div>
    {error && <p role="alert">{error}</p>}
    {versions.map(v => <details key={v.page.revision}><summary>Revision {v.page.revision} · {v.actor.startsWith("thread:") ? "Agent" : v.actor === "human" ? "You" : "Imported"} · {v.summary}</summary>
      <p>{new Date(v.page.updatedAt).toLocaleString()} · {v.page.title || "Untitled page"}</p><pre>{v.page.markdown}</pre>
      {v.page.revision !== page.revision && <button className="btn small" disabled={busy} onClick={() => void restore(v.page.revision)}>Restore revision {v.page.revision}</button>}
    </details>)}
  </section>;
}
