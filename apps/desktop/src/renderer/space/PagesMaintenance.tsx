import { SecretInput } from "../streamer";
import { useEffect, useState } from "react";
import type { Project } from "../../shared/types";
import { bridge } from "../bridge";
import { ErrorNotice } from "../components/ui/ErrorNotice";

export function PagesMaintenance({ active }: { active: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [pending, setPending] = useState<{ id: string; enabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What failed and how to run it again, for the error's Retry; it applies only while `error` is still that message.
  const [failed, setFailed] = useState<{ message: string; run: () => void } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => { if (!active) return; void bridge.invoke("state:get", undefined).then(s => setProjects(s.projects)).catch(err => { setError(err.message); setFailed({ message: err.message, run: () => setAttempt(n => n + 1) }); }); }, [active, attempt]);
  const save = async (id: string, enabled: boolean) => {
    setPending({ id, enabled }); setError(null);
    try { const updated = await bridge.invoke("project:pages", { projectId: id, enabled }); setProjects(all => all.map(p => p.id === id ? updated : p)); }
    catch (err) { const message = (err as Error).message; setError(message); setFailed({ message, run: () => void save(id, enabled) }); }
    finally { setPending(null); }
  };
  return <details className="pages-maintenance" open><summary>Agent notes</summary>
    <p>Allow a project's agents to read and maintain all notes in this Space. Chat and plan turns stay read-only. Changes are saved in version history.</p>
    {!projects.length && <p>Add a project in Home to enable notes access.</p>}
    {projects.map(p => <label key={p.id}><SecretInput type="checkbox" aria-label={`Manage notes for ${p.name}`} checked={pending?.id === p.id ? pending.enabled : p.pagesMaintenance === true} disabled={pending !== null} onChange={e => void save(p.id, e.target.checked)} /><span>{p.name}</span></label>)}
    {error && <ErrorNotice testId="pages-maintenance-error" where="Notes · agent access" message={error} onRetry={failed?.message === error && pending === null ? () => { setError(null); failed.run(); } : undefined} />}
  </details>;
}
