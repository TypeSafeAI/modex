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
import { useNotesTree } from "./useNotesTree";
import { NotesTreeView, type NotesTreeActions } from "./NotesTree";
import { FilePreview } from "./FilePreview";
import type { NotesFile } from "../../shared/notes";
import { restartDrafts } from "../restart-drafts";
import "./space.css";

type View = "all" | "pages" | "favorites" | "trash" | "knowledge" | "sites" | "images";
const TEMPLATES = [
  { title: "Your guide to pages", description: "Get started with pages", icon: "guide" as const, markdown: "## A place for your ideas\n\nWrite notes, plan a project, or start from a template. Your pages are saved locally as Markdown.\n\n## Make it yours\n\n- [ ] Click a block to edit it\n- [ ] Select text to format, comment, or ask for a change\n- [ ] Use Insert to add a heading, list, image, or table\n\n## Work with your agent\n\nUse Generate or Visualize to describe what you need, then continue in chat. Use the page menu to export Markdown or copy a page into your knowledge base." },
  { title: "Feedback tracker", description: "Turn feedback into next steps", icon: "compose" as const, markdown: "## Feedback\n\n| Feedback | Next step | Status |\n| --- | --- | --- |\n| What did you hear? | What will you do? | Open |\n\n## Follow up\n\n- [ ] Review new feedback\n- [ ] Share what changed" },
  { title: "To-do list", description: "Keep your priorities in view", icon: "checklist" as const, markdown: "## Today\n\n### Top priorities\n\n- [ ] Run propulsion test\n- [ ] Verify course calculations\n- [ ] Inspect fuel tanks\n\n## If time allows\n\n- [ ] Inspect radiation shields\n- [ ] Test communication systems\n- [ ] Write status report" },
  { title: "Weekly update", description: "Share progress and next steps", icon: "page" as const, markdown: "## This week\n\nWhat moved forward?\n\n## Next week\n\n- [ ] Set the next priority\n\n## Blockers\n\nWhere do you need help?" },
  { title: "Meeting notes", description: "Keep the useful parts", icon: "comment" as const, markdown: "## On the agenda\n\n- What should we discuss?\n\n## Decisions\n\nWhat did we agree on?\n\n## Next steps\n\n- [ ] Add an action and an owner" },
  { title: "Project brief", description: "From a thought to a plan", icon: "review" as const, markdown: "## The idea\n\nWhat are we making, and why does it matter?\n\n## What success looks like\n\n- [ ] Define the outcome\n- [ ] Build the first version\n- [ ] Share what we learned\n\n## Notes\n\nStart collecting the details here." },
  { title: "Blank page", description: "Make room for an idea", icon: "file" as const, markdown: "" },
];

export function SpaceView({ sidebarOpen, active, openPage, openProject, onOpenChat, chatOpen = false, onKnowledgeReadyChange }: { onKnowledgeReadyChange?: (ready: boolean) => void; sidebarOpen: boolean; active: boolean; openPage?: { id: string }; openProject?: { projectId: string; nonce: number }; onOpenChat?: (prompt?: string) => void; chatOpen?: boolean }) {
  const space = useSpace(active);
  const notes = useNotesTree(active);
  const [newWorkspace, setNewWorkspace] = useState(0);
  const [focusNode, setFocusNode] = useState<string>();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewing = previewId ? notes.tree?.nodes.find((n): n is NotesFile => n.id === previewId && n.kind === "file") : undefined;
  // When the knowledge base is the notes folder, a page is already in it: offer Open, not Copy.
  const [knowledgeNotes, setKnowledgeNotes] = useState<string | null>(null);
  const [history, setHistory] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [view, setView] = useState<View>("pages");
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const [gridView, setGridView] = useState(false);
  const [sort, setSort] = useState<"updated" | "name" | "created">("updated");
  const [sortOpen, setSortOpen] = useState(false);
  const sortTrigger = useRef<HTMLButtonElement>(null);
  const [newOpen, setNewOpen] = useState(false);
  const newTrigger = useRef<HTMLButtonElement>(null);
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
  const [generationDrafts, setGenerationDrafts] = useState<Record<string, { kind: "write" | "visualize"; prompt: string }>>({});
  const [chatDrafts, setChatDrafts] = useState<Record<string, string>>({});
  const requestDrafts = useRef({ generationDrafts, chatDrafts });
  requestDrafts.current = { generationDrafts, chatDrafts };
  useEffect(() => restartDrafts.register("page-requests", async () => {
    const { generationDrafts, chatDrafts } = requestDrafts.current;
    if (Object.values(generationDrafts).some(draft => draft.prompt.trim()) || Object.values(chatDrafts).some(text => text.trim())) {
      throw new Error("Continue or discard your page requests before restarting.");
    }
  }), []);
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
  const generation = page ? generationDrafts[page.id]?.kind : undefined;
  const generationPrompt = page ? generationDrafts[page.id]?.prompt ?? "" : "";
  const chatDraftKey = page?.id ?? "overview";
  const chatDraft = chatDrafts[chatDraftKey] ?? "";
  const setChatDraft = (text: string) => setChatDrafts(current => ({ ...current, [chatDraftKey]: text }));
  const clearGeneration = () => { if (page) setGenerationDrafts(current => { const next = { ...current }; delete next[page.id]; return next; }); };
  const live = space.pages.filter(p => !p.trashedAt);
  const comparePages = (a: SpacePage, b: SpacePage) => sort === "name" ? pageTitle(a).localeCompare(pageTitle(b)) : sort === "created" ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt);
  const visible = space.pages.filter(p => view === "trash" ? !!p.trashedAt : !p.trashedAt && (view !== "favorites" || p.favorite))
    .filter(p => view === "images" ? /!\[[^\]]*\]\(https?:\/\//i.test(p.markdown) : view === "sites" ? /(?<!!)\[[^\]]+\]\(https?:\/\//i.test(p.markdown) : true)
    .filter(p => `${p.title}\n${p.markdown}`.toLowerCase().includes(query.toLowerCase()));
  const run = async (operation: () => Promise<unknown>) => {
    try { restartDrafts.assertOpen(); setActionError(null); await operation(); } catch (err) { setActionError((err as Error).message); }
  };
  const open = (id: string) => { if (selected && selected !== id) void space.settle(selected); if (view === "knowledge") setView("pages"); setSelected(id); setMenu(false); setNotice(null); setQuote(""); setHistory(false); };
  useEffect(() => { if (openPage) { setView("pages"); setQuery(""); open(openPage.id); void space.refresh(); } }, [openPage]);
  // "Open notes" from the chat sidebar: show that project in the tree, made the first time.
  useEffect(() => {
    if (!openProject) return;
    void run(async () => {
      const node = await bridge.invoke("project:notes", { projectId: openProject.projectId });
      setView("pages"); setQuery(""); setSelected(null);
      await notes.refresh();
      setFocusNode(node.id);
    });
  }, [openProject]);
  const create = async (title = "", markdown = "", parentId: string | null = null, containerId?: string) => {
    if (creating) return;
    setCreating(true);
    await run(async () => {
      const result = await space.create({ title, markdown, parentId, ...(containerId ? { containerId } : {}) });
      void notes.refresh();
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
  const tree = (action: () => Promise<unknown>) => run(() => notes.act(action));
  const treeActions: NotesTreeActions = {
    openPage: id => { setView("pages"); setQuery(""); open(id); },
    createPage: containerId => create("", "", null, containerId),
    createFolder: (parentId, name) => tree(() => bridge.invoke("notes:folder:create", { parentId, name })),
    createProject: (workspaceId, name) => tree(() => bridge.invoke("notes:project:create", { workspaceId, name })),
    createWorkspace: name => tree(() => bridge.invoke("notes:workspace:create", { name })),
    rename: (id, name) => tree(async () => { await space.flush(); await bridge.invoke("notes:rename", { id, name }); await space.refresh(); }),
    move: (id, targetId) => tree(async () => { await space.flush(); await bridge.invoke("notes:move", { ids: [id], targetId }); await space.refresh(); }),
    remove: id => tree(() => bridge.invoke("notes:delete", { id })),
    reveal: id => run(() => bridge.invoke("notes:reveal", { id })),
    openFile: id => run(() => bridge.invoke("notes:open", { id })),
    previewFile: id => setPreviewId(id),
    importFiles: (containerId, paths) => tree(async () => {
      const result = await bridge.invoke("notes:import", { targetId: containerId, ...(paths ? { paths } : {}) });
      await space.refresh();
      if (result.errors.length) throw new Error(`${result.imported ? `Imported ${result.imported}. ` : ""}${result.errors.join("; ")}`);
      if (result.imported) setNotice(`Imported ${result.imported} ${result.imported === 1 ? "file" : "files"}`);
    }),
  };
  const exportText = (p: SpacePage) => `# ${pageTitle(p)}\n\n${p.markdown}\n`;
  const download = (p: SpacePage) => void run(async () => {
    await space.flush();
    if (await bridge.invoke("space:export", { pageId: p.id })) setNotice("Markdown exported");
  });
  const pick = (fn: () => void) => () => { setMenu(false); fn(); };
  useEffect(() => {
    if (!menu) return;
    let alive = true;
    void bridge.invoke("knowledge:state", undefined).then(state => { if (alive) setKnowledgeNotes(state.folder && state.folder === state.notesFolder ? state.folder : null); }, () => { if (alive) setKnowledgeNotes(null); });
    return () => { alive = false; };
  }, [menu]);
  /** The page's file, relative to the notes folder (a folder note is Folder/Folder.md). */
  const pagePath = (id: string): string | undefined => {
    const node = notes.tree?.nodes.find(n => n.id === id || (n.kind === "folder" && n.noteId === id));
    return node?.kind === "folder" ? `${node.rel}/${node.rel.split("/").at(-1)}.md` : node?.rel;
  };
  const insertBlock = (source: string) => { setInsertOpen(false); setInsertRequest({ source, nonce: Date.now() }); };
  const beginGeneration = (kind: "write" | "visualize") => {
    setInsertOpen(false);
    if (page) setGenerationDrafts(current => ({ ...current, [page.id]: { kind, prompt: current[page.id]?.prompt ?? "" } }));
  };
  const closeComments = () => { setCommentsOpen(false); commentsTrigger.current?.focus(); };
  const ask = (instruction?: string) => onOpenChat?.(instruction && page ? `${instruction}\n\nSpace page: ${pageTitle(page)}\n\n${page.markdown}` : instruction);
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
    {previewing && <FilePreview file={previewing} onClose={() => setPreviewId(null)} onOpen={() => void treeActions.openFile(previewing.id)} onReveal={() => void treeActions.reveal(previewing.id)} />}
    {sidebarOpen && <aside className="space-sidebar" aria-label="Space pages">
      <div className="space-sidebar-title"><strong>Space</strong><span className="spacer" /><span className="space-sidebar-options"><IconButton ref={optionsTrigger} icon="more" label="Space options" size="md" aria-expanded={optionsOpen} aria-haspopup="menu" onClick={() => setOptionsOpen(value => !value)} /><Menu open={optionsOpen} onClose={() => setOptionsOpen(false)} anchorRef={optionsTrigger} label="Space options" placement="bottom-end"><MenuItem onClick={() => { selectView("favorites"); setOptionsOpen(false); }}>Favorites</MenuItem><MenuItem onClick={() => { selectView("knowledge"); setOptionsOpen(false); }}>Knowledge base</MenuItem><MenuItem onClick={() => { setMaintenance(value => !value); setOptionsOpen(false); }}>Agent notes</MenuItem><MenuItem onClick={() => { importInput.current?.click(); setOptionsOpen(false); }}><Icon name="file" />Import Markdown</MenuItem>{notes.tree && <MenuItem onClick={() => { setView("pages"); setQuery(""); setNewWorkspace(n => n + 1); setOptionsOpen(false); }}><Icon name="grid" />New workspace</MenuItem>}</Menu></span><IconButton icon="search" label="Search pages" size="md" aria-pressed={searching} onClick={() => { setSearching(value => !value); setQuery(""); }} /></div>
      <button className="space-new-page" disabled={!space.loaded || creating} onClick={() => void create()}><Icon name="review" />New page</button>
      {searching && <label className="space-search"><Icon name="search" /><SecretInput autoFocus type="search" aria-label="Search pages" placeholder="Search pages" value={query} onChange={e => { setQuery(e.target.value); setSelected(null); }} onKeyDown={event => { if (event.key === "Escape") { setSearching(false); setQuery(""); } }} /></label>}
      <nav className="space-views" aria-label="Page collections">
        <button aria-label="All pages" aria-current={!page && view === "all" ? "page" : undefined} onClick={() => selectView("all")}><Icon name="library" />All</button>
        <button aria-current={!page && view === "pages" ? "page" : undefined} onClick={() => selectView("pages")}><Icon name="page" />Pages</button>
        <button aria-current={!page && view === "sites" ? "page" : undefined} onClick={() => selectView("sites")}><Icon name="grid" />Sites</button>
        <button aria-current={!page && view === "images" ? "page" : undefined} onClick={() => selectView("images")}><Icon name="image" />Images</button>
      </nav>
      <div className="space-tree">
        <div className="space-tree-label">{query ? "Search results" : view === "trash" ? "Trash" : view === "favorites" ? "Favorites" : notes.tree ? "Workspaces" : "Recents"}</div>
        {(view === "pages" || view === "all") && !query ? (notes.tree ? <NotesTreeView tree={notes.tree} pages={live} selected={selected} actions={treeActions} newWorkspace={newWorkspace} focusId={focusNode} /> : <PageTree pages={live} parentId={null} selected={selected} onSelect={open} />) : visible.map(p => <button className="space-tree-page" key={p.id} onClick={() => view === "trash" ? undefined : open(p.id)} disabled={view === "trash"} aria-label={`Open ${pageTitle(p)}`}><Icon name="page" /><span>{pageTitle(p)}</span></button>)}
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
      <header className={`space-topbar${!page ? " space-overview-topbar" : ""}`}>
        {page ? <>
          <span className="space-page-menu"><button ref={trigger} className="space-page-pill" aria-label="Page actions" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}><Icon name="page" /><span>{pageTitle(page)}</span><Icon name="chevron-down" size={12} /></button>
            <Menu open={menu} onClose={() => setMenu(false)} anchorRef={trigger} label="Page actions" placement="bottom-end" className="space-actions-menu">
              <MenuItem onClick={pick(() => setSelected(null))}><Icon name="list" />Show pages</MenuItem>
              <MenuSeparator />
              <MenuItem onClick={pick(() => setShareOpen(true))}><Icon name="arrow-up" />Share</MenuItem>
              <MenuItem onClick={pick(() => space.edit(page.id, { favorite: !page.favorite }))}><Icon name="star" />{page.favorite ? "Remove from favorites" : "Add to favorites"}</MenuItem>
              {ancestors.map(parent => <MenuItem key={parent.id} onClick={pick(() => open(parent.id))}>Open {pageTitle(parent)}</MenuItem>)}
              <MenuItem onClick={pick(() => { titleInput.current?.focus(); titleInput.current?.select(); })}><Icon name="compose" />Rename</MenuItem>
              <MenuItem onClick={pick(() => void create("", "", page.id))}><Icon name="plus" />Add subpage</MenuItem>
              <MenuItem onClick={pick(() => void create(`${pageTitle(page)} (copy)`, page.markdown, page.parentId))}><Icon name="space" />Duplicate page</MenuItem>
              <MenuSeparator />
              <MenuItem onClick={pick(() => void run(async () => { await bridge.invoke("clipboard:write", { text: exportText(page) }); setNotice("Markdown copied"); }))}><Icon name="space" />Copy Markdown</MenuItem>
              <MenuItem onClick={pick(() => download(page))}><Icon name="download" />Export Markdown</MenuItem>
              {knowledgeNotes
                ? <MenuItem onClick={pick(() => void run(async () => { await space.flush(); await space.settle(page.id); await notes.refresh(); const path = pagePath(page.id); if (!path) throw new Error("This page is not in the notes folder yet."); await bridge.invoke("knowledge:open", { folder: knowledgeNotes, path }); }))}><Icon name="folder" />Open in knowledge base</MenuItem>
                : <MenuItem onClick={pick(() => void run(async () => { await space.flush(); await bridge.invoke("knowledge:copy", { pageId: page.id }); setNotice("Page copied to your knowledge base"); }))}><Icon name="folder" />Copy to knowledge base</MenuItem>}
              <MenuItem onClick={pick(() => importInput.current?.click())}><Icon name="file" />Import Markdown</MenuItem>
              <MenuItem onClick={pick(() => setHistory(true))}><Icon name="history" />Version history</MenuItem>
              <MenuItem onClick={pick(() => setWide(!wide))}>{wide ? "Standard width" : "Full width"}</MenuItem>
              <MenuSeparator />
              <MenuItem className="danger" onClick={pick(() => void run(async () => { await space.trash(page.id, true); setSelected(null); setNotice("Page moved to trash"); }))}><Icon name="trash" />Move to trash</MenuItem>
            </Menu>
          </span>
          <div className="space-tools">
            <IconButton icon="sparkle" label="Generate page content" size="md" disabled={!onOpenChat} onClick={() => beginGeneration("write")} />
            <IconButton icon="image" label="Insert image" size="md" onClick={() => insertBlock("![Image description](https://)")} />
            <IconButton icon="shapes" label="Visualize page" size="md" disabled={!onOpenChat} onClick={() => beginGeneration("visualize")} />
            <span className="space-insert-anchor"><IconButton ref={insertTrigger} icon="insert-square" label="Insert" size="md" aria-expanded={insertOpen} aria-haspopup="menu" onClick={() => setInsertOpen(value => !value)} />
              <Menu open={insertOpen} onClose={() => setInsertOpen(false)} anchorRef={insertTrigger} label="Insert into page" fitViewport placement="bottom-start" className="space-insert-menu">
                <MenuLabel>Generate</MenuLabel><MenuItem disabled={!onOpenChat} onClick={() => beginGeneration("write")}><Icon name="sparkle" /><span>Generate</span><small>Describe what you want to write</small></MenuItem><MenuItem disabled={!onOpenChat} onClick={() => beginGeneration("visualize")}><Icon name="shapes" /><span>Visualize</span><small>Create an interactive visualization</small></MenuItem>
                <MenuLabel>Create</MenuLabel><MenuItem onClick={() => { setInsertOpen(false); void create("", "", page.id); }}><Icon name="page" /><span>Page</span><small>Create a page inside this one</small></MenuItem>
                <MenuLabel>Media</MenuLabel><MenuItem onClick={() => insertBlock("![Image description](https://)")}><Icon name="image" /><span>Image</span><small>Add an image by URL</small></MenuItem>
                <MenuLabel>Basic</MenuLabel>{BLOCK_COMMANDS.filter(command => command.name !== "Image").map(command => <MenuItem key={command.name} onClick={() => insertBlock(command.source)}><span className="space-insert-symbol">{command.symbol}</span><span>{command.name}</span><kbd>{command.source.split("\n")[0]?.trim() || "Aa"}</kbd></MenuItem>)}
              </Menu>
            </span>
          </div>
          <span className="spacer" />
          <span role="status" aria-label="Save status" className={`space-save${space.error ? " failed" : ""}`}>{space.error ? "Not saved" : space.saving ? "Saving…" : "Saved locally"}</span>
          <IconButton icon="history" label="Version history" size="lg" className="space-round-action" aria-pressed={history} onClick={() => setHistory(value => !value)} />
          <IconButton ref={commentsTrigger} icon="comment" label="Comments" size="lg" className="space-round-action" aria-pressed={commentsOpen} onClick={() => setCommentsOpen(value => !value)} />
          <span className="space-share-anchor"><button ref={shareTrigger} className="space-share" aria-haspopup="menu" aria-expanded={shareOpen} onClick={() => setShareOpen(value => !value)}><span className="space-avatar"><Icon name="laptop" size={13} /></span>Share</button>
            <Menu open={shareOpen} onClose={() => setShareOpen(false)} anchorRef={shareTrigger} label="Share page" placement="bottom-end"><MenuLabel>Share a copy · saved on this Mac</MenuLabel><MenuItem onClick={() => { setShareOpen(false); void run(async () => { await space.flush(); await bridge.invoke("clipboard:write", { text: exportText(page) }); setNotice("Markdown copied"); }); }}><Icon name="space" />Copy Markdown</MenuItem><MenuItem onClick={() => { setShareOpen(false); download(page); }}><Icon name="download" />Export Markdown</MenuItem></Menu>
          </span>
        </> : <button className="btn small space-new" disabled={!space.loaded || creating} onClick={() => void create()}><Icon name="plus" size={14} /> Create page</button>}
      </header>
      {maintenance && <PagesMaintenance active={active} />}
      {(space.error || actionError) && <div className="space-error" role="alert"><span>{actionError ?? space.error}</span>{space.error && <><button className="btn small" onClick={() => void run(space.retry)}>Retry</button><button className="btn small" onClick={() => void run(space.preserveDrafts)}>Save drafts as copies and reload</button></>}{actionError && <button className="btn small" onClick={() => setActionError(null)}>Dismiss</button>}</div>}
      {notice && <div className="space-notice" role="status">{notice}</div>}
      <div className="space-page-body">
      {!space.loaded ? <div className="space-loading" role="status">{space.error ? "Could not load Space." : "Opening Space…"}</div> : page ? <div className="space-document-scroll" key={page.id}>
        <article className="space-document" onMouseUp={() => { const selection = window.getSelection(); if (selection?.toString().trim()) setQuote(selection.toString().slice(0, 2000)); }} onSelect={event => { if (event.target instanceof HTMLTextAreaElement) setQuote(event.target.value.slice(event.target.selectionStart, event.target.selectionEnd).slice(0, 2000)); }}>
          <SecretInput ref={titleInput} className="space-title" aria-label="Page title" placeholder="Untitled page" maxLength={200} value={page.title} onChange={e => space.edit(page.id, { title: e.target.value })} onBlur={() => void space.settle(page.id)} />
          {history && <PageHistory key={page.id} page={page} flush={space.flush} refresh={space.refresh} onClose={() => setHistory(false)} />}
          <BlockEditor key={page.id} markdown={page.markdown} insertRequest={insertRequest} generation={generation && <section className={`space-generation space-generation-${generation}`} aria-label={generation === "write" ? "Generate page content" : "Visualize page content"}>
            <IconButton icon="close" label="Cancel generation" onClick={() => clearGeneration()} />
            {generation === "visualize" ? <Icon name="shapes" size={18} /> : <div className="space-generation-lines" aria-hidden="true"><i /><i /><i /></div>}
            <form onSubmit={event => { event.preventDefault(); if (!generationPrompt.trim()) return; ask(`${generation === "visualize" ? "Create an interactive visualization for this page" : "Write content for this page"}: ${generationPrompt}`); clearGeneration(); }}>
              <SecretInput autoFocus aria-label={generation === "write" ? "What would you like to write?" : "Describe a visualization"} placeholder={generation === "write" ? "What would you like to write?" : "Describe a visualization"} value={generationPrompt} onChange={event => { const prompt = event.target.value; setGenerationDrafts(current => ({ ...current, [page.id]: { kind: generation!, prompt } })); }} />
              <button aria-label="Continue in chat" title="Continue in chat" disabled={!generationPrompt.trim()}><Icon name="arrow-up" size={16} /></button>
            </form>
          </section>} onAsk={onOpenChat ? instruction => ask(instruction) : undefined} onComment={selectedQuote => { const quote = selectedQuote.slice(0, 2000); setQuote(quote); setCommentDrafts(current => { const existing = current[page.id]; return { ...current, [page.id]: existing?.text ? existing : { text: "", quote } }; }); setCommentsOpen(true); }} onChange={markdown => space.edit(page.id, { markdown })} />

          {live.filter(p => p.parentId === page.id).length > 0 && <div className="space-subpages"><span>IN THIS PAGE</span>{live.filter(p => p.parentId === page.id).map(p => <button key={p.id} onClick={() => open(p.id)}><Icon name="file" />{pageTitle(p)}<Icon name="arrow-right" /></button>)}</div>}
        </article>
      </div> : <div className="space-overview">
        <div className="space-overview-heading"><h1>{view === "trash" ? "Trash" : view === "favorites" ? "Favorites" : view === "sites" ? "Sites" : view === "images" ? "Images" : "All"}</h1><label className="space-overview-search"><Icon name="search" size={14} /><SecretInput type="search" aria-label="Find pages" placeholder="Search" value={query} onChange={event => setQuery(event.target.value)} /></label><span className="space-new-anchor"><button ref={newTrigger} className="space-overview-new" disabled={creating} aria-haspopup="menu" aria-expanded={newOpen} onClick={() => setNewOpen(value => !value)}>New<Icon name="chevron-down" size={13} /></button><Menu open={newOpen} onClose={() => setNewOpen(false)} anchorRef={newTrigger} label="New page" placement="bottom-end"><MenuItem onClick={() => { setNewOpen(false); void create(); }}><Icon name="page" />Blank page</MenuItem><MenuItem onClick={() => { setNewOpen(false); importInput.current?.click(); }}><Icon name="file" />Import Markdown</MenuItem></Menu></span></div>
        <nav className="space-overview-tabs" aria-label="Page filters"><button aria-current={view === "pages" ? "page" : undefined} onClick={() => selectView("pages")}>Suggested</button><button aria-current={view === "favorites" ? "page" : undefined} onClick={() => selectView("favorites")}>Favorites</button><button aria-current={view === "all" ? "page" : undefined} onClick={() => selectView("all")}>Your items</button><span className="spacer" /><span className="space-sort-anchor"><IconButton ref={sortTrigger} icon="sort" label="Sort pages" aria-haspopup="menu" aria-expanded={sortOpen} onClick={() => setSortOpen(value => !value)} /><Menu open={sortOpen} onClose={() => setSortOpen(false)} anchorRef={sortTrigger} label="Sort pages" placement="bottom-end"><MenuLabel>Sort by</MenuLabel>{([ ["updated", "Last activity"], ["name", "Name"], ["created", "Date created"] ] as const).map(([value, label]) => <MenuItem key={value} checkable selected={sort === value} onClick={() => { setSort(value); setSortOpen(false); }}>{label}</MenuItem>)}</Menu></span><span className="space-view-divider" /><IconButton icon="grid" label="Grid view" aria-pressed={gridView} onClick={() => setGridView(true)} /><IconButton icon="list" label="List view" aria-pressed={!gridView} onClick={() => setGridView(false)} /></nav>
        {(view === "pages" || view === "all") && !query && <div className="space-template-heading"><h2>Create pages in Space</h2><p>Choose a template to start working with your agent</p></div>}
        {(view === "pages" || view === "all") && !query && <div className="space-templates">{TEMPLATES.map(template => <button key={template.title} className={template.icon === "guide" ? "space-template-guide" : undefined} disabled={creating} onClick={() => void create(template.markdown ? template.title : "", template.markdown)}><Icon name={template.icon} size={22} /><strong>{template.title}</strong><span>{template.description}</span><Icon name="arrow-right" size={14} /></button>)}</div>}
        {!gridView && <div className="space-list-heading"><span>Name</span><span>Source</span><span>Last activity</span></div>}
        {visible.length ? <div className={`space-page-list${gridView ? " space-page-grid" : ""}`}>{[...visible].sort(comparePages).map(p => <div key={p.id} className="space-page-list-row">
          <button onClick={() => open(p.id)} disabled={view === "trash"}><span className="space-list-name"><span className="space-list-icon"><Icon name="page" size={18} /></span><strong>{pageTitle(p)}</strong>{p.favorite && <Icon name="star" size={13} />}</span><small className="space-page-source">{p.parentId ? pageTitle(space.pages.find(parent => parent.id === p.parentId) ?? { title: "Space" }) : "Local"}</small><time dateTime={p.updatedAt}>{new Date(p.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</time></button>
          {view === "trash" && <button className="btn small" aria-label={`Restore ${pageTitle(p)}`} onClick={() => void run(() => space.trash(p.id, false))}>Restore</button>}
        </div>)}</div> : <div className="space-list-empty"><Icon name={view === "trash" ? "trash" : "file"} size={26} /><p>{query ? "No pages found. Try another word." : view === "favorites" ? "Add a page to favorites from its page actions menu." : view === "trash" ? "No deleted pages." : "Start a page. See where it takes you."}</p></div>}
      </div>}
      {page && commentsOpen && <PageComments key={`comments:${page.id}`} pageId={page.id} quote={quote} draft={commentDrafts[page.id]} onDraft={draft => setCommentDrafts(current => { const next = { ...current }; if (draft) next[page.id] = draft; else delete next[page.id]; return next; })} onClose={closeComments} />}
      </div>
      {onOpenChat && !chatOpen && <form className="space-chat-launcher" onSubmit={event => { event.preventDefault(); if (chatDraft.trim()) { ask(chatDraft.trim()); setChatDraft(""); } else ask(); }}>
        <button type="button" aria-label="Open chat" title="Open chat and attachments" onClick={() => ask()}><Icon name="plus" size={16} /></button>
        <SecretInput aria-label={page ? "Work with this page" : "Ask anything"} placeholder={page ? "Work with this page…" : "Ask anything"} value={chatDraft} onChange={event => setChatDraft(event.target.value)} />
        {chatDraft && <button type="button" aria-label="Discard page request" onClick={() => setChatDraft("")}><Icon name="close" size={14} /></button>}
        <button className="space-chat-send" aria-label="Continue page request in chat" title="Continue in chat"><Icon name="arrow-up" size={15} /></button>
      </form>}
    </main>
    </div>
    {view === "knowledge" && <KnowledgeView onReadyChange={onKnowledgeReadyChange} active={active && !chatOpen} onPages={() => selectView("pages")} />}
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
