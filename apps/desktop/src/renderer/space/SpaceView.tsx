import { useEffect, useRef, useState } from "react";
import type { SpacePage } from "../../shared/space";
import { pageTitle } from "../../shared/space";
import { importMarkdownPage } from "../../shared/space-markdown";
import { bridge } from "../bridge";
import { Icon } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "../components/ui/Menu";
import { KnowledgeView } from "./KnowledgeView";
import { BlockEditor } from "./BlockEditor";
import { useSpace } from "./useSpace";
import "./space.css";

type View = "pages" | "favorites" | "trash" | "knowledge";
const TEMPLATES = [
  { title: "Blank page", description: "Make room for an idea", icon: "file" as const, markdown: "" },
  { title: "Project brief", description: "From a thought to a plan", icon: "review" as const, markdown: "## The idea\n\nWhat are we making, and why does it matter?\n\n## What success looks like\n\n- [ ] Define the outcome\n- [ ] Build the first version\n- [ ] Share what we learned\n\n## Notes\n\nStart collecting the details here." },
  { title: "Meeting notes", description: "Keep the useful parts", icon: "comment" as const, markdown: "## On the agenda\n\n- What should we discuss?\n\n## Decisions\n\nWhat did we agree on?\n\n## Next steps\n\n- [ ] Add an action and an owner" },
];

export function SpaceView({ sidebarOpen, active }: { sidebarOpen: boolean; active: boolean }) {
  const space = useSpace();
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>("pages");
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const [wide, setWide] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const page = space.pages.find(p => p.id === selected && !p.trashedAt);
  const live = space.pages.filter(p => !p.trashedAt);
  const visible = space.pages.filter(p => view === "trash" ? !!p.trashedAt : !p.trashedAt && (view !== "favorites" || p.favorite))
    .filter(p => `${p.title}\n${p.markdown}`.toLowerCase().includes(query.toLowerCase()));
  const run = async (operation: () => Promise<unknown>) => {
    try { setActionError(null); await operation(); } catch (err) { setActionError((err as Error).message); }
  };
  const open = (id: string) => { if (view === "knowledge") setView("pages"); setSelected(id); setMenu(false); setNotice(null); };
  const create = async (title = "", markdown = "", parentId: string | null = null) => {
    if (creating) return;
    setCreating(true);
    await run(async () => {
      const result = await space.create({ title, markdown, parentId });
      setView("pages"); setQuery(""); open(result.id);
      requestAnimationFrame(() => { titleInput.current?.focus(); titleInput.current?.select(); });
    });
    setCreating(false);
  };
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") { event.preventDefault(); void create(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active, creating]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(null), 3500); return () => clearTimeout(timer); }, [notice]);

  const selectView = (value: View) => { setView(value); setQuery(""); setSelected(null); };
  const exportText = (p: SpacePage) => `# ${pageTitle(p)}\n\n${p.markdown}\n`;
  const download = (p: SpacePage) => void run(async () => {
    await space.flush();
    if (await bridge.invoke("space:export", { pageId: p.id })) setNotice("Markdown exported");
  });
  const pick = (fn: () => void) => () => { setMenu(false); fn(); };
  const ancestors: SpacePage[] = [];
  let parentId = page?.parentId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = live.find(p => p.id === parentId);
    if (!parent) break;
    ancestors.unshift(parent); parentId = parent.parentId;
  }

  return <div className="space-surface" data-testid="space" hidden={!active} inert={space.busy} aria-busy={space.busy}>
    {sidebarOpen && <aside className="space-sidebar" aria-label="Space pages">
      <div className="space-sidebar-title"><span className="space-mark"><Icon name="space" size={20} /></span><strong>Space</strong><span className="spacer" /><IconButton icon="plus" label="New page" size="md" disabled={!space.loaded || creating} onClick={() => void create()} /></div>
      <p className="space-sidebar-caption">Your ideas, kept together.</p>
      <label className="space-search"><Icon name="search" /><input type="search" aria-label="Search pages" placeholder="Search your pages" value={query} onChange={e => { setQuery(e.target.value); setSelected(null); }} /></label>
      <nav className="space-views" aria-label="Page collections">
        <button aria-label="All pages" aria-current={view === "pages" ? "page" : undefined} onClick={() => selectView("pages")}><Icon name="space" />All pages<span>{live.length}</span></button>
        <button aria-label="Favorites" aria-current={view === "favorites" ? "page" : undefined} onClick={() => selectView("favorites")}><Icon name="star" />Favorites<span>{live.filter(p => p.favorite).length || ""}</span></button>
        <button aria-label="Knowledge base" aria-current={view === "knowledge" ? "page" : undefined} onClick={() => selectView("knowledge")}><Icon name="files" />Knowledge base</button>
      </nav>
      <div className="space-tree-label">{query ? "SEARCH RESULTS" : view === "trash" ? "TRASH" : view === "favorites" ? "FAVORITES" : "PAGES"}</div>
      <div className="space-tree">
        {view === "pages" && !query ? <PageTree pages={live} parentId={null} selected={selected} onSelect={open} /> : visible.map(p => <button className="space-tree-page" key={p.id} onClick={() => view === "trash" ? undefined : open(p.id)} disabled={view === "trash"} aria-label={`Open ${pageTitle(p)}`}><Icon name="file" /><span>{pageTitle(p)}</span></button>)}
        {space.loaded && !visible.length && <p className="space-tree-empty">{query ? "No matching pages" : view === "favorites" ? "Star a page to keep it close." : view === "trash" ? "Nothing in the trash." : "Your next idea starts here."}</p>}
      </div>
      <div className="space-sidebar-footer">
        <button onClick={() => importInput.current?.click()} disabled={!space.loaded}><Icon name="download" />Import Markdown</button>
        <button aria-current={view === "trash" ? "page" : undefined} onClick={() => selectView("trash")}><Icon name="trash" />Trash</button>
        <span><Icon name="laptop" size={13} /> Saved on this Mac</span>
      </div>
    </aside>}
    <div className="space-pages-panel" hidden={view === "knowledge"}>
    <main className={`space-main${wide ? " space-wide" : ""}`}>
      <header className="space-topbar">
        <div className="space-breadcrumb"><button onClick={() => selectView("pages")}>Space</button>{ancestors.map(p => <span key={p.id}><Icon name="chevron-right" size={12} /><button onClick={() => open(p.id)}>{pageTitle(p)}</button></span>)}{page && <><Icon name="chevron-right" size={12} /><span className="space-current-title">{pageTitle(page)}</span></>}</div>
        <span className="spacer" />
        {page ? <>
          <span role="status" aria-label="Save status" className={`space-save${space.error ? " failed" : ""}`}>{space.error ? "Not saved" : space.saving ? "Saving…" : "Saved locally"}</span>
          <IconButton icon="star" label={page.favorite ? "Remove from favorites" : "Add to favorites"} size="md" aria-pressed={page.favorite} className={page.favorite ? "space-starred" : ""} onClick={() => space.edit(page.id, { favorite: !page.favorite })} />
          <span className="space-page-menu"><IconButton ref={trigger} icon="more" label="Page actions" size="md" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)} />
            <Menu open={menu} onClose={() => setMenu(false)} anchorRef={trigger} label="Page actions" placement="bottom-end">
              <MenuItem onClick={pick(() => { titleInput.current?.focus(); titleInput.current?.select(); })}>Rename</MenuItem>
              <MenuItem onClick={pick(() => void create("", "", page.id))}>Add subpage</MenuItem>
              <MenuItem onClick={pick(() => void create(`${pageTitle(page)} (copy)`, page.markdown, page.parentId))}>Duplicate page</MenuItem>
              <MenuSeparator />
              <MenuItem onClick={pick(() => void run(async () => { await bridge.invoke("clipboard:write", { text: exportText(page) }); setNotice("Markdown copied"); }))}>Copy Markdown</MenuItem>
              <MenuItem onClick={pick(() => download(page))}>Export Markdown</MenuItem>
              <MenuItem onClick={pick(() => void run(async () => { await space.flush(); await bridge.invoke("knowledge:copy", { pageId: page.id }); setNotice("Page copied to your knowledge base"); }))}>Copy to knowledge base</MenuItem>
              <MenuItem onClick={pick(() => importInput.current?.click())}>Import Markdown</MenuItem>
              <MenuItem onClick={pick(() => setWide(!wide))}>{wide ? "Standard width" : "Full width"}</MenuItem>
              <MenuSeparator />
              <MenuItem className="danger" onClick={pick(() => void run(async () => { await space.trash(page.id, true); setSelected(null); setNotice("Page moved to trash"); }))}>Move to trash</MenuItem>
            </Menu>
          </span>
        </> : <button className="btn small space-new" disabled={!space.loaded || creating} onClick={() => void create()}><Icon name="plus" size={14} /> Create page</button>}
      </header>
      {(space.error || actionError) && <div className="space-error" role="alert"><span>{actionError ?? space.error}</span>{space.error && <button className="btn small" onClick={() => void run(space.retry)}>Retry</button>}{actionError && <button className="btn small" onClick={() => setActionError(null)}>Dismiss</button>}</div>}
      {notice && <div className="space-notice" role="status">{notice}</div>}
      {!space.loaded ? <div className="space-loading" role="status">{space.error ? "Could not load Space." : "Opening Space…"}</div> : page ? <div className="space-document-scroll" key={page.id}>
        <article className="space-document">
          <div className="space-page-emblem"><Icon name="file" size={32} /></div>
          <input ref={titleInput} className="space-title" aria-label="Page title" placeholder="Untitled page" maxLength={200} value={page.title} onChange={e => space.edit(page.id, { title: e.target.value })} />
          <div className="space-document-meta"><span>Private page</span><span>·</span><span>{new Date(page.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span></div>
          <BlockEditor key={page.id} markdown={page.markdown} onChange={markdown => space.edit(page.id, { markdown })} />
          {live.filter(p => p.parentId === page.id).length > 0 && <div className="space-subpages"><span>IN THIS PAGE</span>{live.filter(p => p.parentId === page.id).map(p => <button key={p.id} onClick={() => open(p.id)}><Icon name="file" />{pageTitle(p)}<Icon name="arrow-right" /></button>)}</div>}
          <footer className="space-document-footer"><span>{page.markdown.trim() ? page.markdown.trim().split(/\s+/).length : 0} words</span><button onClick={() => void create("", "", page.id)}><Icon name="plus" size={13} /> Add subpage</button></footer>
        </article>
      </div> : <div className="space-overview">
        <div className="space-overview-heading"><span className="space-eyebrow">YOUR SPACE</span><h1>{query ? "Find a thought." : view === "trash" ? "Room for second thoughts." : view === "favorites" ? "Keep it close." : "A place for the thinking."}</h1><p>{view === "trash" ? "Pages stay here until you’re ready to bring them back." : query ? `Pages matching “${query}”` : view === "favorites" ? "The pages you come back to, all in one place." : "Notes, plans, and the ideas in between. Make them yours."}</p></div>
        {view === "pages" && !query && <div className="space-templates">{TEMPLATES.map(template => <button key={template.title} disabled={creating} onClick={() => void create(template.markdown ? template.title : "", template.markdown)}><Icon name={template.icon} size={22} /><strong>{template.title}</strong><span>{template.description}</span><Icon name="arrow-right" size={14} /></button>)}</div>}
        <div className="space-list-heading"><h2>{query ? "Results" : view === "trash" ? "Deleted pages" : view === "favorites" ? "Favorites" : "Your pages"}</h2><span>{visible.length} {visible.length === 1 ? "page" : "pages"}</span></div>
        {visible.length ? <div className="space-page-list">{[...visible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(p => <div key={p.id} className="space-page-list-row">
          <button onClick={() => open(p.id)} disabled={view === "trash"}><Icon name="file" size={18} /><span><strong>{pageTitle(p)}</strong><small>{p.parentId ? pageTitle(space.pages.find(parent => parent.id === p.parentId) ?? { title: "Space" }) : "Private page"}</small></span>{p.favorite && <Icon name="star" size={13} />}<time>{new Date(p.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></button>
          {view === "trash" && <button className="btn small" aria-label={`Restore ${pageTitle(p)}`} onClick={() => void run(() => space.trash(p.id, false))}>Restore</button>}
        </div>)}</div> : <div className="space-list-empty"><Icon name={view === "trash" ? "trash" : "file"} size={26} /><p>{query ? "No pages found. Try another word." : view === "favorites" ? "Add a page to favorites with the star in its toolbar." : view === "trash" ? "No deleted pages." : "Start a page. See where it takes you."}</p></div>}
      </div>}
    </main>
    </div>
    {view === "knowledge" && <KnowledgeView active={active} onPages={() => selectView("pages")} />}
    <input ref={importInput} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" aria-label="Import Markdown file" hidden onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file) return;
      void run(async () => {
        if (file.size > 1_000_000) throw new Error("Choose a Markdown file smaller than 1 MB.");
        const markdown = await file.text();
        const imported = importMarkdownPage(markdown, file.name);
        await create(imported.title, imported.markdown);
      });
    }} />
  </div>;
}

function PageTree({ pages, parentId, selected, onSelect, depth = 0 }: { pages: SpacePage[]; parentId: string | null; selected: string | null; onSelect: (id: string) => void; depth?: number }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  if (depth > 30) return null;
  return <ul>{pages.filter(p => p.parentId === parentId).map(page => {
    const children = pages.some(p => p.parentId === page.id);
    return <li key={page.id}><div className={`space-tree-row${selected === page.id ? " selected" : ""}`}>
      {children ? <button className="space-tree-toggle" aria-label={`${collapsed.has(page.id) ? "Expand" : "Collapse"} ${pageTitle(page)}`} aria-expanded={!collapsed.has(page.id)} onClick={() => setCollapsed(current => { const next = new Set(current); if (next.has(page.id)) next.delete(page.id); else next.add(page.id); return next; })}><Icon name={collapsed.has(page.id) ? "chevron-right" : "chevron-down"} size={12} /></button> : <span className="space-tree-leaf" />}
      <button className="space-tree-page" aria-label={`Open ${pageTitle(page)}`} aria-current={selected === page.id ? "page" : undefined} onClick={() => onSelect(page.id)}><Icon name="file" size={15} /><span>{pageTitle(page)}</span>{page.favorite && <Icon name="star" size={11} />}</button>
    </div>{children && !collapsed.has(page.id) && <PageTree pages={pages} parentId={page.id} selected={selected} onSelect={onSelect} depth={depth + 1} />}</li>;
  })}</ul>;
}
