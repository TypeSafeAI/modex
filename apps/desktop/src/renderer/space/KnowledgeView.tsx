import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { knowledgeBusy, type KnowledgeState } from "../../shared/knowledge";
import type { Project } from "../../shared/types";
import { bridge } from "../bridge";
import { Icon } from "../components/ui/Icon";
import "./knowledge.css";

export function KnowledgeView({ active, onPages }: { active: boolean; onPages: () => void }) {
  const [state, setState] = useState<KnowledgeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewError, setViewError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [saving, setSaving] = useState<{ id: string; enabled: boolean } | null>(null);
  const operation = useRef(false);
  const canvas = useRef<HTMLDivElement>(null);
  const busy = working || (state ? knowledgeBusy(state) : false);
  const ready = state?.status === "ready";
  const folderName = state?.folder?.split(/[\\/]/).filter(Boolean).at(-1);

  useEffect(() => {
    let alive = true;
    void bridge.invoke("state:get", undefined).then(value => { if (alive) setProjects(value.projects); }).catch(err => { if (alive) setError((err as Error).message); });
    return () => { alive = false; };
  }, [active]);
  const maintain = async (projectId: string, enabled: boolean) => {
    setSaving({ id: projectId, enabled }); setError(null);
    try {
      const updated = await bridge.invoke("project:knowledge", { projectId, enabled });
      setProjects(current => current.map(p => p.id === projectId ? updated : p));
    } catch (err) { setError((err as Error).message); }
    finally { setSaving(null); }
  };

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      if (operation.current) return;
      try { const next = await bridge.invoke("knowledge:state", undefined); if (alive && !operation.current) setState(next); }
      catch (err) { if (alive) setError((err as Error).message); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const run = async (channel: "knowledge:choose" | "knowledge:install" | "knowledge:start" | "knowledge:stop") => {
    if (operation.current) return;
    operation.current = true; setWorking(true); setError(null); setViewError(null);
    setState(current => current && ({ ...current, status: channel === "knowledge:install" ? "installing" : channel === "knowledge:start" ? "starting" : channel === "knowledge:stop" ? "stopping" : current.status }));
    try { setState(await bridge.invoke(channel, undefined)); }
    catch (err) {
      setError((err as Error).message);
      try { setState(await bridge.invoke("knowledge:state", undefined)); } catch { /* Keep the original error. */ }
    } finally { operation.current = false; setWorking(false); }
  };

  useLayoutEffect(() => {
    let alive = true;
    const update = async () => {
      const rect = canvas.current?.getBoundingClientRect();
      const overlay = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], .streamer-shield');
      const bounds = active && ready && !overlay && rect && rect.width > 0 && rect.height > 0
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
      try {
        const result = await bridge.invoke("knowledge:show", { bounds });
        if (alive) setViewError(result?.error ?? null);
      } catch (err) { if (alive) setViewError((err as Error).message); }
    };
    void update();
    const resize = new ResizeObserver(() => void update());
    if (canvas.current) resize.observe(canvas.current);
    const mutations = new MutationObserver(() => void update());
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    const timer = setInterval(() => void update(), 1500);
    return () => { alive = false; clearInterval(timer); resize.disconnect(); mutations.disconnect(); window.removeEventListener("resize", update); void bridge.invoke("knowledge:show", {}).catch(() => {}); };
  }, [active, ready, state?.url]);

  const extra = async (channel: "knowledge:external" | "knowledge:reload") => {
    try { setError(null); setViewError(null); await bridge.invoke(channel, undefined); }
    catch (err) { setError((err as Error).message); }
  };
  return <main className="space-main knowledge-main" aria-label="Knowledge base">
    <header className="space-topbar knowledge-topbar">
      <div className="space-breadcrumb"><button onClick={onPages}>Space</button><Icon name="chevron-right" size={12} /><span>Knowledge base</span></div>
      <span className="spacer" />
      <span className={`knowledge-status${ready ? " ready" : ""}`} role="status">{state?.status === "installing" ? "Installing…" : state?.status === "starting" ? "Opening…" : state?.status === "stopping" ? "Stopping…" : ready ? (state?.external ? "Connected locally" : "Running locally") : "Local knowledge"}</span>
      {ready && <><button className="btn small" aria-label="Reload knowledge base" onClick={() => void extra("knowledge:reload")}><Icon name="restart" size={14} /></button><button className="btn small" aria-label="Open knowledge base in browser" onClick={() => void extra("knowledge:external")}><Icon name="globe" size={14} /></button><button className="btn small" disabled={busy} title={state?.external ? "Disconnect from this server and leave it running" : "Stop the server started by Modex"} onClick={() => void run("knowledge:stop")}>{state?.external ? "Disconnect" : "Stop"}</button></>}
    </header>
    <details className="knowledge-maintenance">
      <summary>Agent maintenance</summary>
      <p>Agents can search your selected knowledge folder. Enable a project to save verified decisions, fixes, and procedures automatically. Chat and plan mode stay read-only. Changes include a page link and appear in its history.</p>
      {!projects.length && <p>Add a project in Home to enable automatic maintenance.</p>}
      {projects.map(project => <label key={project.id}><input type="checkbox" aria-label={`Maintain knowledge for ${project.name}`} checked={saving?.id === project.id ? saving.enabled : project.knowledgeMaintenance === true} disabled={saving !== null} onChange={e => void maintain(project.id, e.target.checked)} /><span>{project.name}</span></label>)}
    </details>
    {(error || state?.error || viewError) && <div className="space-error" role="alert"><span>{error ?? state?.error ?? viewError}</span>{ready && <button className="btn small" onClick={() => void extra("knowledge:reload")}>Retry</button>}</div>}
    {ready ? <div ref={canvas} className="knowledge-canvas" data-testid="knowledge-canvas" aria-label="Open Knowledge editor" /> : <div className="knowledge-setup">
      <div className="knowledge-intro"><span className="space-eyebrow">SPACE / KNOWLEDGE</span><div className="knowledge-emblem"><Icon name="space" size={34} /></div><h1>Give your knowledge a home.</h1><p>Bring your notes, docs, and decisions together.<br />Explore them with Open Knowledge, right here in Space.</p></div>
      <section className="knowledge-folder" aria-label="Knowledge folder">
        <div className="knowledge-folder-icon"><Icon name="folder" size={23} /></div>
        <div><strong data-testid="knowledge-folder">{folderName ?? "Your folder. Your knowledge."}</strong><p title={state?.folder ?? undefined}>{state?.folder ?? "Choose a folder of Markdown files, or start with an empty one."}</p></div>
        <button className="btn small" disabled={busy || !state} aria-label="Choose knowledge folder" onClick={() => void run("knowledge:choose")}>{state?.folder ? "Change folder" : "Choose folder"}</button>
      </section>
      <div className="knowledge-launch">
        {state?.installed ? <button className="btn primary" disabled={busy || !state.folder} onClick={() => void run("knowledge:start")}>{state.status === "starting" ? "Opening knowledge base…" : "Open knowledge base"}<Icon name="arrow-right" size={16} /></button> : <button className="btn primary" disabled={busy || !state} onClick={() => void run("knowledge:install")}>{state?.status === "installing" ? "Installing Open Knowledge…" : "Install Open Knowledge"}<Icon name="download" size={16} /></button>}
        <p>{state?.installed ? "Your files stay in the folder you choose. Opening creates local Open Knowledge settings there." : "One-time download · Requires Node.js 24+ and Git. Installs a separate local companion."}</p>
      </div>
      <div className="knowledge-features"><div><Icon name="file" size={19} /><strong>Write naturally</strong><span>Rich Markdown pages, ready for your next idea.</span></div><div><Icon name="search" size={19} /><strong>Find the connection</strong><span>Search your docs and follow links between them.</span></div><div><Icon name="laptop" size={19} /><strong>Keep it yours</strong><span>Local files you can open with your own tools.</span></div></div>
      <p className="knowledge-footnote">Already writing in Space? Use <strong>Page actions → Copy to knowledge base</strong> to bring a page here.</p>
    </div>}
  </main>;
}
