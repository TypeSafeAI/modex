import { SecretInput } from "../streamer";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SpacePage } from "../../shared/space";
import { pageTitle } from "../../shared/space";
import { importMarkdownPage } from "../../shared/space-markdown";
import { bridge } from "../bridge";
import { Icon } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../components/ui/Menu";
import { PagesMaintenance } from "./PagesMaintenance";
import { PageHistory } from "./PageHistory";
import { KnowledgeView } from "./KnowledgeView";
import { BlockEditor } from "./BlockEditor";
import { PageComments, type CommentDraft } from "./PageComments";
import { BLOCK_COMMANDS } from "./markdown";
import { useSpace } from "./useSpace";
import { restartDrafts } from "../restart-drafts";
import "./space.css";

type View = "all" | "pages" | "favorites" | "trash" | "knowledge" | "sites" | "images";
const TEMPLATES = [
  { title: "Blank page", description: "Make room for an idea", icon: "file" as const, markdown: "" },
  { title: "Project brief", description: "From a thought to a plan", icon: "review" as const, markdown: "## The idea\n\nWhat are we making, and why does it matter?\n\n## What success looks like\n\n- [ ] Define the outcome\n- [ ] Build the first version\n- [ ] Share what we learned\n\n## Notes\n\nStart collecting the details here." },
  { title: "Meeting notes", description: "Keep the useful parts", icon: "comment" as const, markdown: "## On the agenda\n\n- What should we discuss?\n\n## Decisions\n\nWhat did we agree on?\n\n## Next steps\n\n- [ ] Add an action and an owner" },
];

export function SpaceView({ sidebarOpen, active, openPage, onOpenChat, chatOpen = false }: { sidebarOpen: boolean; active: boolean; openPage?: { id: string }; onOpenChat?: (prompt?: string) => void; chatOpen?: boolean }) {
  const space = useSpace(active);
  const [history, setHistory] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>("pages");
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const [wide, setWide] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const importing = useRef(0);
  useLayoutEffect(() => restartDrafts.register("space-actions", async () => {
    if (importing.current || creating) throw new Error("Wait for the current Space action to finish before restarting.");
  }), [creating]);
  const [searching, setSearching] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [quote, setQuote] = useState("");
  const [commentDrafts, setCommentDrafts] = useState<Record<string, CommentDraft>>({});
  const commentDraftsRef = useRef(commentDrafts); commentDraftsRef.current = commentDrafts;
  useEffect(() => restartDrafts.register("page-comments", async () => {
    if (Object.values(commentDraftsRef.current).some(draft => draft.text.length > 0)) throw new Error("Post or discard your draft comments before restarting.");
  }), []);
  const [insertOpen, setInsertOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [maintenance, setMaintenance] = useState(false);
  const [insertRequest, setInsertRequest] = useState<{ source: string; nonce: number }>();
  const insertTrigger = useRef<HTMLButtonElement>(null);
  const shareTrigger = useRef<HTMLButtonElement>(null);
  const optionsTrigger = useRef<HTMLButtonElement>(null);
  const commentsTrigger = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const focusCreatedTitle = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!selected || focusCreatedTitle.current !== selected) return;
    focusCreatedTitle.current = null;
    titleInput.current?.focus();
    titleInput.current?.select();
  }, [selected]);
  const importInput = useRef<HTMLInputElement>(null);
  const page = space.pages.find(p => p.id === selected && !p.trashedAt);
  useEffect(() => {
    if (selected && space.pages.some(p => p.id === selected && p.trashedAt)) {
      setSelected(null); setView("trash"); setQuery(""); setNotice("This note is in Trash. Restore it to open it.");
    }
  }, [selected, space.pages]);
  const live = space.pages.filter(p => !p.trashedAt);
  const visible = space.pages.filter(p => view === "trash" ? !!p.trashedAt : !p.trashedAt && (view !== "favorites" || p.favorite))
    .filter(p => view === "images" ? /!\[[^\]]*\]\(https?:\/\//i.test(p.markdown) : view === "sites" ? /(?<!!)\[[^\]]+\]\(https?:\/\//i.test(p.markdown) : true)
    .filter(p => `${p.title}\n${p.markdown}`.toLowerCase().includes(query.toLowerCase()));
  const run = async (operation: () => Promise<unknown>) => {
    try { restartDrafts.assertOpen(); setActionError(null); await operation(); } catch (err) { setActionError((err as Error).message); }
  };
  const open = (id: string) => { if (view === "knowledge") setView("pages"); setSelected(id); setMenu(false); setNotice(null); setQuote(""); setHistory(false); };
  useEffect(() => { if (openPage) { setView("pages"); setQuery(""); open(openPage.id); void space.refresh(); } }, [openPage]);
  const create = async (title = "", markdown = "", parentId: string | null = null) => {
    if (creating) return;
    setCreating(true);
    await run(async () => {
      const result = await space.create({ title, markdown, parentId });
      focusCreatedTitle.current = result.id;
      setView("pages"); setQuery(""); open(result.id);
    });
    setCreating(false);
  };
  useEffect(() => {
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      if (restartDrafts.frozen) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n" && !(event.target as HTMLElement).closest(".space-chat")) { event.preventDefault(); void create(); }
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
  const insertBlock = (source: string) => { setInsertOpen(false); setInsertRequest({ source, nonce: Date.now() }); };
  const closeComments = () => { setCommentsOpen(false); commentsTrigger.current?.focus(); };
  const ask = (instruction?: string) => onOpenChat?.(instruction && page ? `${instruction}\n\nSpace page: ${pageTitle(page)}\n\n${page.markdown}` : undefined);
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
      <div className="space-sidebar-title"><strong>Space</strong><span className="spacer" /><span className="space-sidebar-options"><IconButton ref={optionsTrigger} icon="more" label="Space options" size="md" aria-expanded={optionsOpen} aria-haspopup="menu" onClick={() => setOptionsOpen(value => !value)} /><Menu open={optionsOpen} onClose={() => setOptionsOpen(false)} anchorRef={optionsTrigger} label="Space options" placement="bottom-end"><MenuItem onClick={() => { selectView("favorites"); setOptionsOpen(false); }}>Favorites</MenuItem><MenuItem onClick={() => { selectView("knowledge"); setOptionsOpen(false); }}>Knowledge base</MenuItem><MenuItem onClick={() => { setMaintenance(value => !value); setOptionsOpen(false); }}>Agent notes</MenuItem><MenuItem onClick={() => { importInput.current?.click(); setOptionsOpen(false); }}>Import Markdown</MenuItem></Menu></span><IconButton icon="search" label="Search pages" size="md" aria-pressed={searching} onClick={() => { setSearching(value => !value); setQuery(""); }} /></div>
      <button className="space-new-page" disabled={!space.loaded || creating} onClick={() => void create()}><Icon name="review" />New page</button>
      {searching && <label className="space-search"><Icon name="search" /><SecretInput autoFocus type="search" aria-label="Search pages" placeholder="Search pages" value={query} onChange={e => { setQuery(e.target.value); setSelected(null); }} onKeyDown={event => { if (event.key === "Escape") { setSearching(false); setQuery(""); } }} /></label>}
      <nav className="space-views" aria-label="Page collections">
        <button aria-label="All pages" aria-current={!page && view === "all" ? "page" : undefined} onClick={() => selectView("all")}><Icon name="library" />All</button>
        <button aria-current={!page && view === "pages" ? "page" : undefined} onClick={() => selectView("pages")}><Icon name="page" />Pages</button>
        <button aria-current={!page && view === "sites" ? "page" : undefined} onClick={() => selectView("sites")}><Icon name="grid" />Sites</button>
        <button aria-current={!page && view === "images" ? "page" : undefined} onClick={() => selectView("images")}><Icon name="image" />Images</button>
      </nav>
      <div className="space-tree">
        <div className="space-tree-label">{query ? "Search results" : view === "trash" ? "Trash" : view === "favorites" ? "Favorites" : "Recents"}</div>
        {(view === "pages" || view === "all") && !query ? <PageTree pages={live} parentId={null} selected={selected} onSelect={open} /> : visible.map(p => <button className="space-tree-page" key={p.id} onClick={() => view === "trash" ? undefined : open(p.id)} disabled={view === "trash"} aria-label={`Open ${pageTitle(p)}`}><Icon name="page" /><span>{pageTitle(p)}</span></button>)}
        {space.loaded && !visible.length && <p className="space-tree-empty">{query ? "No matching pages" : view === "favorites" ? "Star a page to keep it close." : view === "trash" ? "Nothing in the trash." : "Your next idea starts here."}</p>}
        <div className="space-tree-label space-collections-label">Spaces</div>
        <button className="space-knowledge-link space-tree-page" aria-label="Knowledge base" aria-current={view === "knowledge" ? "page" : undefined} onClick={() => selectView("knowledge")}><Icon name="files" /><span>Knowledge base</span></button>
      </div>
      <div className="space-sidebar-footer">
        <button aria-current={view === "trash" ? "page" : undefined} onClick={() => selectView("trash")}><Icon name="trash" />Trash</button>
      </div>
    </aside>}
    <div className="space-pages-panel" hidden={view === "knowledge"}>
    <main className={`space-main${wide ? " space-wide" : ""}`}>
      <header className="space-topbar">
        {page ? <>
          <span className="space-page-menu"><button ref={trigger} className="space-page-pill" aria-label="Page actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="page" /><span>{pageTitle(page)}</span><Icon name="chevron-down" size={12} /></button>
            <Menu open={menu} onClose={() => setMenu(false)} anchorRef={trigger} label="Page actions" placement="bottom-end">
              {ancestors.map(parent => <MenuItem key={parent.id} onClick={pick(() => open(parent.id))}>Open {pageTitle(parent)}</MenuItem>)}
              <MenuItem onClick={pick(() => { titleInput.current?.focus(); titleInput.current?.select(); })}>Rename</MenuItem>
              <MenuItem onClick={pick(() => void create("", "", page.id))}>Add subpage</MenuItem>
              <MenuItem onClick={pick(() => void create(`${pageTitle(page)} (copy)`, page.markdown, page.parentId))}>Duplicate page</MenuItem>
              <MenuSeparator />
              <MenuItem onClick={pick(() => void run(async () => { await bridge.invoke("clipboard:write", { text: exportText(page) }); setNotice("Markdown copied"); }))}>Copy Markdown</MenuItem>
              <MenuItem onClick={pick(() => download(page))}>Export Markdown</MenuItem>
              <MenuItem onClick={pick(() => void run(async () => { await space.flush(); await bridge.invoke("knowledge:copy", { pageId: page.id }); setNotice("Page copied to your knowledge base"); }))}>Copy to knowledge base</MenuItem>
              <MenuItem onClick={pick(() => importInput.current?.click())}>Import Markdown</MenuItem>
              <MenuItem onClick={pick(() => setHistory(true))}>Version history</MenuItem>
              <MenuItem onClick={pick(() => setWide(!wide))}>{wide ? "Standard width" : "Full width"}</MenuItem>
              <MenuSeparator />
              <MenuItem className="danger" onClick={pick(() => void run(async () => { await space.trash(page.id, true); setSelected(null); setNotice("Page moved to trash"); }))}>Move to trash</MenuItem>
            </Menu>
          </span>
          <div className="space-tools">
            <IconButton icon="star" label={page.favorite ? "Remove from favorites" : "Add to favorites"} size="md" aria-pressed={page.favorite} className={page.favorite ? "space-starred" : ""} onClick={() => space.edit(page.id, { favorite: !page.favorite })} />
            <IconButton icon="image" label="Insert image" size="md" onClick={() => insertBlock("![Image description](https://)")} />
            <IconButton icon="grid" label="Visualize page" size="md" disabled={!onOpenChat} onClick={() => ask("Create an interactive visualization of this page.")} />
            <span className="space-insert-anchor"><IconButton ref={insertTrigger} icon="plus" label="Insert" size="md" aria-expanded={insertOpen} aria-haspopup="menu" onClick={() => setInsertOpen(value => !value)} />
              <Menu open={insertOpen} onClose={() => setInsertOpen(false)} anchorRef={insertTrigger} label="Insert into page" placement="bottom-start" className="space-insert-menu">
                <MenuLabel>Generate</MenuLabel><MenuItem disabled={!onOpenChat} onClick={() => { setInsertOpen(false); ask("Create an interactive visualization of this page."); }}><Icon name="grid" /><span>Visualize</span><small>Create an interactive visualization</small></MenuItem>
                <MenuLabel>Create</MenuLabel><MenuItem onClick={() => { setInsertOpen(false); void create("", "", page.id); }}><Icon name="page" /><span>Page</span><small>Create a page inside this one</small></MenuItem>
                <MenuLabel>Media</MenuLabel><MenuItem onClick={() => insertBlock("![Image description](https://)")}><Icon name="image" /><span>Image</span><small>Add an image by URL</small></MenuItem>
                <MenuLabel>Basic</MenuLabel>{BLOCK_COMMANDS.filter(command => command.name !== "Image").map(command => <MenuItem key={command.name} onClick={() => insertBlock(command.source)}><span className="space-insert-symbol">{command.symbol}</span><span>{command.name}</span></MenuItem>)}
              </Menu>
            </span>
          </div>
          <span className="spacer" />
          <span role="status" aria-label="Save status" className={`space-save${space.error ? " failed" : ""}`}>{space.error ? "Not saved" : space.saving ? "Saving…" : "Saved locally"}</span>
          <IconButton icon="history" label="Version history" size="lg" className="space-round-action" aria-pressed={history} onClick={() => setHistory(value => !value)} />
          <IconButton ref={commentsTrigger} icon="comment" label="Comments" size="lg" className="space-round-action" aria-pressed={commentsOpen} onClick={() => setCommentsOpen(value => !value)} />
          <span className="space-share-anchor"><button ref={shareTrigger} className="space-share" aria-haspopup="menu" aria-expanded={shareOpen} onClick={() => setShareOpen(value => !value)}><span className="space-avatar"><Icon name="laptop" size={13} /></span>Share</button>
            <Menu open={shareOpen} onClose={() => setShareOpen(false)} anchorRef={shareTrigger} label="Share page" placement="bottom-end"><MenuLabel>Share a copy · saved on this Mac</MenuLabel><MenuItem onClick={() => { setShareOpen(false); void run(async () => { await space.flush(); await bridge.invoke("clipboard:write", { text: exportText(page) }); setNotice("Markdown copied"); }); }}>Copy Markdown</MenuItem><MenuItem onClick={() => { setShareOpen(false); download(page); }}>Export Markdown</MenuItem></Menu>
          </span>
        </> : <button className="btn small space-new" disabled={!space.loaded || creating} onClick={() => void create()}><Icon name="plus" size={14} /> Create page</button>}
      </header>
      {maintenance && <PagesMaintenance active={active} />}
      {(space.error || actionError) && <div className="space-error" role="alert"><span>{actionError ?? space.error}</span>{space.error && <><button className="btn small" onClick={() => void run(space.retry)}>Retry</button><button className="btn small" onClick={() => void run(space.preserveDrafts)}>Save drafts as copies and reload</button></>}{actionError && <button className="btn small" onClick={() => setActionError(null)}>Dismiss</button>}</div>}
      {notice && <div className="space-notice" role="status">{notice}</div>}
      <div className="space-page-body">
      {!space.loaded ? <div className="space-loading" role="status">{space.error ? "Could not load Space." : "Opening Space…"}</div> : page ? <div className="space-document-scroll" key={page.id}>
        <article className="space-document" onMouseUp={() => { const selection = window.getSelection(); if (selection?.toString().trim()) setQuote(selection.toString().slice(0, 2000)); }} onSelect={event => { if (event.target instanceof HTMLTextAreaElement) setQuote(event.target.value.slice(event.target.selectionStart, event.target.selectionEnd).slice(0, 2000)); }}>
          <SecretInput ref={titleInput} className="space-title" aria-label="Page title" placeholder="Untitled page" maxLength={200} value={page.title} onChange={e => space.edit(page.id, { title: e.target.value })} />
          {history && <PageHistory key={page.id} page={page} flush={space.flush} refresh={space.refresh} onClose={() => setHistory(false)} />}
          <BlockEditor key={page.id} markdown={page.markdown} insertRequest={insertRequest} onChange={markdown => space.edit(page.id, { markdown })} />
          {live.filter(p => p.parentId === page.id).length > 0 && <div className="space-subpages"><span>IN THIS PAGE</span>{live.filter(p => p.parentId === page.id).map(p => <button key={p.id} onClick={() => open(p.id)}><Icon name="file" />{pageTitle(p)}<Icon name="arrow-right" /></button>)}</div>}
        </article>
      </div> : <div className="space-overview">
        <div className="space-overview-heading"><h1>{query ? "Search" : view === "trash" ? "Trash" : view === "favorites" ? "Favorites" : view === "sites" ? "Sites" : view === "images" ? "Images" : "Your pages"}</h1><p>{view === "trash" ? "Restore a page to pick up where you left off." : query ? `Pages matching “${query}”` : view === "sites" ? "Pages with links to websites." : view === "images" ? "Pages with images." : view === "favorites" ? "The pages you come back to, all in one place." : "Notes, plans, and ideas, saved on this Mac."}</p></div>
        {(view === "pages" || view === "all") && !query && <div className="space-templates">{TEMPLATES.map(template => <button key={template.title} disabled={creating} onClick={() => void create(template.markdown ? template.title : "", template.markdown)}><Icon name={template.icon} size={22} /><strong>{template.title}</strong><span>{template.description}</span><Icon name="arrow-right" size={14} /></button>)}</div>}
        <div className="space-list-heading"><h2>{query ? "Results" : view === "trash" ? "Deleted pages" : view === "favorites" ? "Favorites" : "Your pages"}</h2><span>{visible.length} {visible.length === 1 ? "page" : "pages"}</span></div>
        {visible.length ? <div className="space-page-list">{[...visible].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(p => <div key={p.id} className="space-page-list-row">
          <button onClick={() => open(p.id)} disabled={view === "trash"}><Icon name="file" size={18} /><span><strong>{pageTitle(p)}</strong><small>{p.parentId ? pageTitle(space.pages.find(parent => parent.id === p.parentId) ?? { title: "Space" }) : "Private page"}</small></span>{p.favorite && <Icon name="star" size={13} />}<time>{new Date(p.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></button>
          {view === "trash" && <button className="btn small" aria-label={`Restore ${pageTitle(p)}`} onClick={() => void run(() => space.trash(p.id, false))}>Restore</button>}
        </div>)}</div> : <div className="space-list-empty"><Icon name={view === "trash" ? "trash" : "file"} size={26} /><p>{query ? "No pages found. Try another word." : view === "favorites" ? "Add a page to favorites with the star in its toolbar." : view === "trash" ? "No deleted pages." : "Start a page. See where it takes you."}</p></div>}
      </div>}
      {page && commentsOpen && <PageComments key={`comments:${page.id}`} pageId={page.id} quote={quote} draft={commentDrafts[page.id]} onDraft={draft => setCommentDrafts(current => { const next = { ...current }; if (draft) next[page.id] = draft; else delete next[page.id]; return next; })} onClose={closeComments} />}
      </div>
      {onOpenChat && !chatOpen && !(page && commentsOpen) && <button className="space-chat-launcher" aria-label="Open chat" onClick={() => ask()}><Icon name="comment" size={18} /><span>Ask anything</span><Icon name="plus" size={18} /></button>}
    </main>
    </div>
    {view === "knowledge" && <KnowledgeView active={active && !chatOpen} onPages={() => selectView("pages")} />}
    <SecretInput ref={importInput} type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" aria-label="Import Markdown file" hidden onChange={event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file || restartDrafts.frozen) return;
      importing.current++;
      void run(async () => {
        if (file.size > 1_000_000) throw new Error("Choose a Markdown file smaller than 1 MB.");
        const markdown = await file.text();
        // This already-started import vetoes preparation. Keep its text until
        // main acknowledges cancellation, then finish the requested import.
        await restartDrafts.waitUntilOpen();
        const imported = importMarkdownPage(markdown, file.name);
        await create(imported.title, imported.markdown);
      }).finally(() => { importing.current--; });
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
      <button className="space-tree-page" aria-label={`Open ${pageTitle(page)}`} aria-current={selected === page.id ? "page" : undefined} onClick={() => onSelect(page.id)}><Icon name="page" size={15} /><span>{pageTitle(page)}</span>{page.favorite && <Icon name="star" size={11} />}</button>
    </div>{children && !collapsed.has(page.id) && <PageTree pages={pages} parentId={page.id} selected={selected} onSelect={onSelect} depth={depth + 1} />}</li>;
  })}</ul>;
}
