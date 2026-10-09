import { useEffect, useState } from "react";
import type { Project } from "../../shared/types";
import { bridge } from "../bridge";

export function PagesMaintenance({ active }: { active: boolean }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [pending, setPending] = useState<{ id: string; enabled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!active) return; void bridge.invoke("state:get", undefined).then(s => setProjects(s.projects)).catch(err => setError(err.message)); }, [active]);
  const save = async (id: string, enabled: boolean) => {
    setPending({ id, enabled }); setError(null);
    try { const updated = await bridge.invoke("project:pages", { projectId: id, enabled }); setProjects(all => all.map(p => p.id === id ? updated : p)); }
    catch (err) { setError((err as Error).message); }
    finally { setPending(null); }
  };
  return <details className="pages-maintenance"><summary>Agent notes</summary>
    <p>Allow a project's agents to read and maintain all notes in this Space. Chat and plan turns stay read-only. Changes are saved in version history.</p>
    {!projects.length && <p>Add a project in Home to enable notes access.</p>}
    {projects.map(p => <label key={p.id}><input type="checkbox" aria-label={`Manage notes for ${p.name}`} checked={pending?.id === p.id ? pending.enabled : p.pagesMaintenance === true} disabled={pending !== null} onChange={e => void save(p.id, e.target.checked)} /><span>{p.name}</span></label>)}
    {error && <p role="alert">{error}</p>}
  </details>;
}
