import { useEffect, useRef, useState } from "react";
import type { NativePlugin, PluginAction, PluginContext, PluginDetail, PluginInventory, PluginSourceInventory } from "../../shared/plugins";
import type { Project } from "../../shared/types";
import { bridge } from "../bridge";
import { SecretInput, SecretTextarea, useRedact } from "../streamer";
import "./plugins.css";

export interface PluginsViewProps {
  projects: Project[];
  onUseForImages?: (plugin: NativePlugin, context: PluginContext) => void | Promise<void>;
}
export function PluginsView({ projects, onUseForImages }: PluginsViewProps) {
  const [context, setContext] = useState<PluginContext>({ runtime: "claude", account: "cli", scope: "user" });
  const [tab, setTab] = useState<"installed" | "discover" | "sources">("installed");
  const [inventory, setInventory] = useState<PluginInventory | null>(null);
  const [sources, setSources] = useState<PluginSourceInventory | null>(null);
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [query, setQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [componentFilter, setComponentFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [source, setSource] = useState("");
  const [configuration, setConfiguration] = useState("{}");
  const [configOpen, setConfigOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const sequence = useRef(0);
  const detailsSequence = useRef(0);
  const redact = useRedact();
  const refresh = async () => {
    const seq = ++sequence.current;
    setLoading(true); setError(null);
    try {
      if (tab === "sources") {
        const result = await bridge.invoke("plugins:sources", { context });
        if (sequence.current === seq) setSources(result);
      } else {
        const result = await bridge.invoke("plugins:list", { context, available: tab === "discover" });
        if (sequence.current === seq) setInventory(result);
      }
    } catch (err) { if (sequence.current === seq) setError((err as Error).message); }
    finally { if (sequence.current === seq) setLoading(false); }
  };
  useEffect(() => {
    setInventory(null); setSources(null); setDetail(null); setNotice(null); setConfigOpen(false); setConfiguration("{}");
    ++detailsSequence.current;
    void refresh();
    return () => { ++sequence.current; ++detailsSequence.current; };
  }, [context.runtime, context.scope, context.projectId, tab]);
  useEffect(() => {
    const onFocus = () => { if (!busy) void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [context.runtime, context.scope, context.projectId, tab, busy]);
  const run = async (operation: () => Promise<unknown>, message: string) => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await operation(); setNotice(message); await refresh(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const open = async (plugin: NativePlugin) => {
    const seq = ++detailsSequence.current;
    setDetail(null); setConfigOpen(false); setConfiguration("{}"); setError(null);
    try { const result = await bridge.invoke("plugins:details", { context, id: plugin.id }); if (detailsSequence.current === seq) setDetail(result); }
    catch (err) { if (detailsSequence.current === seq) setError((err as Error).message); }
  };
  const mutate = (plugin: NativePlugin, action: PluginAction) => void run(async () => {
    await bridge.invoke("plugins:mutate", { context, action, id: plugin.id });
    setDetail(null);
  }, "Native plugin change completed. Start a new chat to use the updated installation.");
  const importLocal = async () => {
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { const result = await bridge.invoke("plugins:importLocal", { context }); setNotice(result.message); await refresh(); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  const availableActions = inventory?.capabilities.actions ?? [];
  const filtered = (inventory?.plugins ?? []).filter(plugin => (tab === "discover" || plugin.installed) && `${plugin.name} ${plugin.description ?? ""} ${plugin.marketplace ?? ""}`.toLowerCase().includes(query.toLowerCase())).filter(plugin => !sourceFilter || plugin.marketplace === sourceFilter).filter(plugin => !componentFilter || (plugin.components ?? []).includes(componentFilter)).filter(plugin => !stateFilter || (stateFilter === "available" ? !plugin.installed : stateFilter === "disabled" ? plugin.installed && plugin.enabled === false : plugin.installed));
  const stale = tab === "sources" ? sources : inventory;
  return <section className="plugins-view" aria-label="Plugins">
    <header className="plugins-header"><div><p className="plugins-eyebrow">NATIVE EXTENSIONS</p><h1>Plugins</h1><p>Manage the skills and tools your runtime brings to each turn.</p></div><button disabled={loading || busy} onClick={() => void refresh()}>{loading ? "Refreshing…" : "Refresh"}</button></header>
    <div className="plugins-context">
      <label>Runtime<select aria-label="Plugin runtime" value={context.runtime} disabled={busy} onChange={e => setContext({ ...context, runtime: e.target.value as PluginContext["runtime"], scope: "user" })}><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
      <label>Account<select aria-label="Plugin account" value="cli" disabled><option value="cli">Shared CLI identity</option></select></label>
      <label>Project<select aria-label="Plugin project" value={context.projectId ?? ""} disabled={busy} onChange={e => setContext({ ...context, projectId: e.target.value || undefined, scope: e.target.value ? context.scope : "user" })}><option value="">No project</option>{projects.map(project => <option key={project.id} value={project.id}>{redact(project.name)}</option>)}</select></label>
      <label>Scope<select aria-label="Plugin scope" value={context.scope} disabled={busy || context.runtime === "codex"} onChange={e => setContext({ ...context, scope: e.target.value as PluginContext["scope"] })}><option value="user">User</option><option value="project" disabled={!context.projectId}>Project</option><option value="local" disabled={!context.projectId}>Local</option></select></label>
    </div>
    <p className="plugins-context-note">Native plugins use the runtime’s existing CLI identity and installation. Modex account sign-in does not create a separate plugin home.{context.runtime === "codex" ? " Codex exposes user scope only." : ""}</p>
    <nav className="plugins-tabs" aria-label="Plugin views">{(["installed", "discover", "sources"] as const).map(value => <button key={value} aria-current={tab === value ? "page" : undefined} disabled={busy} onClick={() => setTab(value)}>{value[0]!.toUpperCase() + value.slice(1)}</button>)}</nav>
    {error && <div className="plugins-error" role="alert">{redact(error)}</div>}
    {notice && <div className="plugins-notice" role="status">{redact(notice)}</div>}
    {stale?.stale && <p className="plugins-notice" role="status">Showing cached inventory from {new Date(stale.fetchedAt).toLocaleString()}. {redact(stale.error ?? "Native runtime unavailable.")}</p>}
    {tab === "sources" ? <div className="plugins-sources">
      <form onSubmit={e => { e.preventDefault(); void run(async () => { await bridge.invoke("plugins:source:mutate", { context, action: "add", source }); setSource(""); }, "Marketplace added."); }}><label htmlFor="plugin-source">Add a marketplace</label><div><SecretInput id="plugin-source" required value={source} onChange={e => setSource(e.target.value)} placeholder="owner/repository or https://…" disabled={busy} /><button disabled={busy || !source.trim() || !sources?.actions?.includes("add")}>Add source</button></div></form>
      <div className="plugins-local-import"><button disabled={busy || !sources?.actions?.includes("add")} onClick={() => void importLocal()}>Import local…</button><p>Import a marketplace or plugin folder into <strong>{context.runtime === "claude" ? "Claude Code" : "Codex"} / shared CLI identity / {context.scope} scope</strong>{context.projectId ? ` for ${redact(projects.find(project => project.id === context.projectId)?.name ?? context.projectId)}` : ""}. Packages are copied into Modex’s local sources. Choose Install in Discover to enable a plugin.</p></div><p>Sources are managed by the selected native CLI. Interactive authentication remains in that CLI.</p>
      {sources?.sources.map(item => <article className="plugin-source" key={item.name}><div><h2>{redact(item.name)}</h2><p>{redact(item.source ?? "Native marketplace")}</p></div><div className="plugin-actions"><button disabled={busy || !sources?.actions?.includes("update")} onClick={() => void run(() => bridge.invoke("plugins:source:mutate", { context, action: "update", source: item.name }), "Marketplace refreshed.")}>Refresh source</button><button disabled={busy || !sources?.actions?.includes("remove")} onClick={() => void run(() => bridge.invoke("plugins:source:mutate", { context, action: "remove", source: item.name }), "Marketplace removed.")}>Remove source</button></div></article>)}
      {!loading && sources?.sources.length === 0 && <p className="plugins-empty">No marketplaces configured for this runtime.</p>}
    </div> : <>
      <label className="plugins-search">Search plugins<SecretInput type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Name, skill, or marketplace" /></label>
      <div className="plugins-context" aria-label="Plugin filters">
        <label>Source<select aria-label="Filter plugins by source" value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}><option value="">All sources</option>{[...new Set((inventory?.plugins ?? []).flatMap(p => p.marketplace ? [p.marketplace] : []))].map(name => <option key={name} value={name}>{redact(name)}</option>)}</select></label>
        <label>Components<select aria-label="Filter plugin components" value={componentFilter} onChange={e => setComponentFilter(e.target.value)}><option value="">All components</option>{[...new Set((inventory?.plugins ?? []).flatMap(p => p.components ?? []))].map(kind => <option key={kind} value={kind}>{kind}</option>)}</select></label>
        <label>State<select aria-label="Filter plugin state" value={stateFilter} onChange={e => setStateFilter(e.target.value)}><option value="">All states</option><option value="installed">Installed</option><option value="disabled">Disabled</option>{tab === "discover" && <option value="available">Available</option>}</select></label>
      </div>
      <div className="plugins-layout"><div className="plugins-list">{filtered.map(plugin => <article className={`plugin-card${detail?.plugin.id === plugin.id ? " is-selected" : ""}`} key={`${plugin.id}:${plugin.scope ?? ""}`}>
        <button className="plugin-open" onClick={() => void open(plugin)}><span className="plugin-card-heading"><strong>{redact(plugin.name)}</strong><span>{plugin.installed ? plugin.enabled === false ? "Disabled" : "Installed" : "Available"}</span></span><span>{redact(plugin.description ?? plugin.id)}</span><small>{redact([plugin.marketplace, plugin.version, plugin.scope].filter(Boolean).join(" · "))}</small></button>
        <div className="plugin-actions">{!plugin.installed && <button disabled={busy || !availableActions.includes("install")} onClick={() => mutate(plugin, "install")}>Install</button>}{plugin.installed && <><button disabled={busy || !availableActions.includes("update")} title={!availableActions.includes("update") ? "Not supported by this native CLI" : undefined} onClick={() => mutate(plugin, "update")}>Update</button><button disabled={busy || !availableActions.includes(plugin.enabled === false ? "enable" : "disable")} title="Availability depends on the native CLI" onClick={() => mutate(plugin, plugin.enabled === false ? "enable" : "disable")}>{plugin.enabled === false ? "Enable" : "Disable"}</button><button disabled={busy || !availableActions.includes("remove")} onClick={() => mutate(plugin, "remove")}>Remove</button></>}</div>
      </article>)}{!loading && inventory && filtered.length === 0 && <div className="plugins-empty"><h2>{query ? "No matching plugins" : tab === "installed" ? "No plugins installed in this scope" : "No plugins available"}</h2><p>{tab === "installed" ? "Browse Discover or add a marketplace in Sources." : "Add or refresh a marketplace in Sources."}</p></div>}{loading && !inventory && <p role="status">Loading native plugins…</p>}</div>
      {detail && <aside className="plugin-details" aria-label={`${detail.plugin.name} details`}><div className="plugin-detail-heading"><h2>{redact(detail.plugin.name)}</h2><button aria-label="Close plugin details" onClick={() => { ++detailsSequence.current; setDetail(null); }}>Close</button></div><pre>{redact(detail.text)}</pre>{detail.notes.map((note, index) => <p key={index} className="plugins-context-note">{redact(note)}</p>)}{detail.skills.map((skill, index) => <details key={`${skill.name}:${index}`} open><summary>{redact(skill.name)}</summary><pre className="plugin-skill-text">{redact(skill.text)}</pre></details>)}
        {detail.plugin.installed && <div className="plugin-actions"><button disabled={busy || !availableActions.includes("configure")} title={!availableActions.includes("configure") ? "Configuration is not exposed by this native CLI" : undefined} onClick={() => setConfigOpen(value => !value)}>Configure</button>{onUseForImages && <button disabled={busy || detail.plugin.enabled === false} onClick={() => void run(async () => { await onUseForImages(detail.plugin, context); }, "Plugin selected for Images.")}>Use for Images</button>}</div>}
        {configOpen && <form className="plugin-config" onSubmit={e => { e.preventDefault(); void run(async () => { const values: unknown = JSON.parse(configuration); if (!values || typeof values !== "object" || Array.isArray(values) || Object.values(values).some(value => typeof value !== "string")) throw new Error("Enter a JSON object with string values."); await bridge.invoke("plugins:mutate", { context, action: "configure", id: detail.plugin.id, values: values as Record<string, string> }); setConfiguration("{}"); setConfigOpen(false); }, "Native configuration saved."); }}><p>Set native plugin options as JSON string values. Omitted options keep their values. Configuration follows the native plugin’s own storage scope.</p>{detail.configuration !== undefined && <pre>{redact(JSON.stringify(detail.configuration, null, 2))}</pre>}<label>Option values<SecretTextarea aria-label="Plugin option values" value={configuration} onChange={e => setConfiguration(e.target.value)} spellCheck={false} /></label><button disabled={busy}>Save configuration</button></form>}
      </aside>}</div>
      {inventory?.capabilities.notes.map(note => <p key={note} className="plugins-context-note">{note}</p>)}
    </>}
  </section>;
}
