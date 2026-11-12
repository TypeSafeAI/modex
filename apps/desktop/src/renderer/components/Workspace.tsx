import { CanvasPanel } from "./CanvasPanel";
import { SecretInput, useStreamerMode } from "../streamer";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Markdown } from "./Markdown";
import type { ChangesSnapshot, Thread, ThreadItem } from "../../shared/types";
import { SubagentsPanel, subagentsOf } from "./SubagentsPanel";
import type { BrowserSnapshot } from "../../shared/browser";
import { bridge } from "../bridge";
import { ChangesPanel, FileIcon } from "./ChangesPanel";
import { Icon, type IconName } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { Menu, MenuItem } from "./ui/Menu";
import { BrowserToolsDialog } from "./BrowserToolsDialog";
import { ErrorNotice } from "./ui/ErrorNotice";
import "../workspace.css";

type Tab = { id: string; kind: "new" | "review" | "files" | "terminal" | "browser" | "canvas" | "subagents"; title: string; browser?: BrowserSnapshot };
const makeTab = (): Tab => ({ id: crypto.randomUUID(), kind: "new", title: "New tab" });
const tabIcon = (kind: Tab["kind"]): IconName => kind === "canvas" ? "grid" : kind === "review" ? "review" : kind === "files" ? "folder" : kind === "terminal" ? "terminal-box" : kind === "subagents" ? "agents" : "globe";
interface Props {
  thread: Thread; changes: ChangesSnapshot | null; onRefresh: () => void; onRevert: (path: string) => void;
  visible: boolean; onShow: () => void; onHide: () => void; suspended: boolean;
  terminal: ReactNode; onOpenTerminal: () => void; onHideTerminal: () => void; onFocusChat: () => void;
  /** The thread's transcript, for the Subagents tab. */
  items: ThreadItem[];
  /** Changes each time the title bar asks for the Subagents tab. */
  subagentsSignal: number;
}

export function Workspace({ thread, changes, onRefresh, onRevert, visible, onShow, onHide, suspended, terminal, onOpenTerminal, onHideTerminal, onFocusChat, items, subagentsSignal }: Props) {
  const streamerMode = useStreamerMode();
  const [tabs, setTabs] = useState<Tab[]>(() => [{ id: "review", kind: "review", title: "Review" }]);
  const [active, setActive] = useState(terminal ? "terminal" : "review");
  const [full, setFull] = useState(false);
  const [addMenu, setAddMenu] = useState(false);
  const [toolsMenu, setToolsMenu] = useState(false);
  const [terminalMenu, setTerminalMenu] = useState(false);
  const [pageMenu, setPageMenu] = useState(false);
  const [browserTools, setBrowserTools] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [browserNotice, setBrowserNotice] = useState("");
  const [address, setAddress] = useState("");
  const addressEdited = useRef(false);
  const addressTab = useRef(active);
  const [error, setError] = useState("");
  // The browser action behind `error`, for its Retry. It applies only while `error` is still that message.
  const [failed, setFailed] = useState<{ message: string; retry: () => void } | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const toolsRef = useRef<HTMLButtonElement>(null);
  const terminalRef = useRef<HTMLButtonElement>(null);
  const pageRef = useRef<HTMLButtonElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const guestHost = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLElement>(null);
  const tabsRef = useRef(tabs); tabsRef.current = tabs;
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0]!;
  const currentRef = useRef(current); currentRef.current = current;
  const activate = (tab: Tab) => { setActive(tab.id); setError(""); if (tab.kind === "terminal") onOpenTerminal(); else if (terminal) onHideTerminal(); };
  const newTab = useCallback((fullView = false) => {
    if (currentRef.current?.kind === "terminal") onHideTerminal();
    const tab = makeTab();
    setTabs((prev) => [...prev, tab]); setActive(tab.id); setFull(fullView); setAddMenu(false); setError(""); onShow();
    // A frame can arrive late (an inactive or busy window). By then the address may already have focus,
    // or the person may have moved on to type elsewhere: once focus has moved at all, leave it.
    let moved = false;
    const mark = () => { moved = true; };
    document.addEventListener("focusin", mark, true);
    requestAnimationFrame(() => {
      document.removeEventListener("focusin", mark, true);
      if (!moved) addressRef.current?.focus();
    });
  }, [onShow, onHideTerminal]);
  const openTool = (kind: "review" | "files" | "terminal" | "canvas" | "subagents") => {
    const existing = tabs.find((tab) => tab.kind === kind);
    const tab: Tab = existing ?? { id: kind === "canvas" ? crypto.randomUUID() : kind, kind, title: kind === "canvas" ? "Canvas" : kind === "review" ? "Review" : kind === "files" ? "Files" : kind === "subagents" ? "Subagents" : "Terminal" };
    if (!existing) setTabs((prev) => [...prev, tab]);
    activate(tab); onShow(); setToolsMenu(false);
  };
  const closeTab = (tab: Tab) => {
    void bridge.invoke("browser:command", { id: tab.id, action: "close" }).catch(() => {});
    const next = tabs.filter((t) => t.id !== tab.id);
    if (!next.length) next.push(makeTab());
    setTabs(next);
    const nextActive = active === tab.id ? next[Math.max(0, tabs.indexOf(tab) - 1)] ?? next[0]! : current;
    if (active === tab.id) activate(nextActive);
    requestAnimationFrame(() => document.getElementById(`workspace-tab-${nextActive.id}`)?.focus());
    if (tab.kind === "terminal") onHideTerminal();
  };
  useEffect(() => {
    if (terminal) {
      setTabs((prev) => prev.some((tab) => tab.kind === "terminal") ? prev : [...prev, { id: "terminal", kind: "terminal", title: "Terminal" }]);
      setActive("terminal");
    } else if (currentRef.current?.kind === "terminal") setActive("review");
  }, [Boolean(terminal)]);
  useEffect(() => {
    if (addressTab.current !== active) { addressTab.current = active; addressEdited.current = false; }
    // A loading-page snapshot can arrive while the next URL is being typed.
    if (!addressEdited.current) setAddress(current.browser?.url ?? "");
    setError("");
    setBrowserNotice("");
    if (current.kind === "new") addressRef.current?.focus();
  }, [active, current.browser?.url]);
  useEffect(() => () => {
    for (const tab of tabsRef.current) void bridge.invoke("browser:command", { id: tab.id, action: "close" }).catch(() => {});
  }, []);
  useLayoutEffect(() => {
    const sheet = container.current?.closest(".sheet");
    sheet?.classList.toggle("workspace-full", full && visible);
    return () => { sheet?.classList.remove("workspace-full"); };
  }, [full, visible]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (suspended || browserTools || e.defaultPrevented) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && ["b", "f"].includes(e.key.toLowerCase())) { e.preventDefault(); newTab(e.key.toLowerCase() === "f"); }
      else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "g") { e.preventDefault(); openTool("review"); }
      else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); openTool("files"); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l" && visible) { e.preventDefault(); if (!["new", "browser"].includes(current.kind)) newTab(full); else { addressRef.current?.focus(); addressRef.current?.select(); } }
      else if (e.key === "Escape" && full && !addMenu && !pageMenu && !toolsMenu && !terminalMenu) setFull(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  // Only a request made while this thread is shown opens the tab; the value it mounted with is not one.
  const seenSignal = useRef(subagentsSignal);
  useEffect(() => { if (subagentsSignal !== seenSignal.current) { seenSignal.current = subagentsSignal; openTool("subagents"); } }, [subagentsSignal]);
  useEffect(() => bridge.onWorkspaceShortcut?.((shortcut) => {
    if (suspended || browserTools) return;
    if (shortcut === "new" || shortcut === "full") newTab(shortcut === "full");
    else if (shortcut === "files" || shortcut === "review" || shortcut === "terminal") openTool(shortcut);
    else if (shortcut === "address") {
      if (!["new", "browser"].includes(current.kind)) newTab(full);
      else { onShow(); requestAnimationFrame(() => { addressRef.current?.focus(); addressRef.current?.select(); }); }
    }
    else if (shortcut === "hide") onHide();
    else if (shortcut === "escape") setFull(false);
  }));
  const browserCommand = async (action: "navigate" | "back" | "forward" | "reload", value?: string) => {
    const id = current.id;
    addressEdited.current = false;
    setError("");
    try {
      const snapshot = await bridge.invoke("browser:command", { id, action, url: value });
      if (snapshot) setTabs((prev) => prev.map((t) => t.id === id ? { ...t, kind: "browser", title: snapshot.title || "New tab", browser: snapshot } : t));
    } catch (error) {
      const message = (error as Error).message;
      setError(message);
      // A rejected address fails the same way again; the fix is a different address.
      setFailed(action === "navigate" ? null : { message, retry: () => void browserCommand(action, value) });
    }
  };
  const browserAction = async (action: "fill" | "external") => {
    const id = current.id;
    setPageMenu(false); setError(""); setBrowserNotice("");
    if (action === "fill") setSigningIn(true);
    try {
      if (action === "external") await bridge.invoke("browser:external", { id });
      else if (await bridge.invoke("browser:fillLogin", { id }) && currentRef.current.id === id) setBrowserNotice("Login filled. Review the fields, then sign in.");
    } catch (error) {
      if (currentRef.current.id !== id) return;
      const message = (error as Error).message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
      setError(message);
      setFailed({ message, retry: () => void browserAction(action) });
    }
    finally { setSigningIn(false); }
  };
  // Poll only the visible page. No page gets the app's preload or IPC authority.
  useEffect(() => {
    if (!visible || current.kind !== "browser") return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const snapshot = await bridge.invoke("browser:command", { id: current.id, action: "state" });
        if (live && snapshot) setTabs((prev) => prev.map((tab) => tab.id === snapshot.id ? { ...tab, title: snapshot.title || "New tab", browser: snapshot } : tab));
      } catch { /* The command path reports errors; closing a tab can race this read. */ }
      if (live) timer = setTimeout(poll, 500);
    };
    void poll();
    return () => { live = false; clearTimeout(timer); };
  }, [current.id, current.kind, visible]);
  useLayoutEffect(() => {
    const host = guestHost.current;
    const update = () => {
      const overlay = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-panel-resizing="true"]');
      const rect = host?.getBoundingClientRect();
      const show = visible && !suspended && !streamerMode && !overlay && current.kind === "browser" && !current.browser?.error && rect;
      void bridge.invoke("browser:show", { id: show ? current.id : null, fullView: full, ...(show ? { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}) }).catch(() => {});
    };
    update();
    const resize = new ResizeObserver(update);
    if (host) resize.observe(host);
    const mutations = new MutationObserver(update);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-panel-resizing"] });
    window.addEventListener("resize", update);
    return () => { resize.disconnect(); mutations.disconnect(); window.removeEventListener("resize", update); void bridge.invoke("browser:show", { id: null }).catch(() => {}); };
  }, [current.id, current.kind, current.browser?.error, visible, suspended, full, streamerMode]);
  const browserPage = current.kind === "new" || current.kind === "browser";
  return <aside ref={container} className="workspace" data-testid="workspace" hidden={!visible} aria-label="Side panel" data-full-view={full} data-page-kind={current.kind}>
    <header className="workspace-tabbar">
      <div className="workspace-tabs" role="tablist" aria-label="Workspace tabs">
        {tabs.map((tab) => <div key={tab.id} className={`workspace-tab${tab.id === current.id ? " selected" : ""}`}>
          <button role="tab" aria-selected={tab.id === current.id} id={`workspace-tab-${tab.id}`} aria-controls={`workspace-pane-${thread.id}`} tabIndex={tab.id === current.id ? 0 : -1} onClick={() => activate(tab)} onKeyDown={(e) => {
            const at = tabs.indexOf(tab);
            const next = e.key === "ArrowRight" ? tabs[(at + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(at + tabs.length - 1) % tabs.length] : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs.at(-1) : undefined;
            if (next) { e.preventDefault(); activate(next); const buttons = container.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]'); buttons?.[tabs.indexOf(next)]?.focus(); }
          }}><Icon name={tabIcon(tab.kind)} size={14} /><span>{tab.title}</span></button>
          <button className="workspace-tab-close" aria-label={`Close ${tab.title} tab`} onClick={() => closeTab(tab)}><Icon name="close" size={13} /></button>
        </div>)}
      </div>
      <span className="workspace-menu-anchor workspace-add-anchor">
        <IconButton ref={addRef} icon="plus" label="New tab" size="md" data-testid="workspace-add" aria-haspopup="menu" aria-expanded={addMenu} onClick={() => setAddMenu(!addMenu)} />
        <Menu open={addMenu} anchorRef={addRef} onClose={() => setAddMenu(false)} label="New tab" placement="bottom-end" className="workspace-new-menu" testId="workspace-new-menu">
          <MenuItem onClick={() => newTab()}><Icon name="plus" size={18} /><span>New tab</span><kbd>⇧⌘B</kbd></MenuItem>
          <MenuItem onClick={() => newTab(true)}><Icon name="expand" size={18} /><span>New tab in full view</span><kbd>⇧⌘F</kbd></MenuItem>
        </Menu>
      </span>
      <span className="spacer" />
      <IconButton icon="expand" label={full ? "Exit full view" : "Full view"} data-testid="workspace-full" aria-pressed={full} size="md" onClick={() => setFull(!full)} />
      <IconButton icon="tabs" label="Hide side panel" size="md" className="workspace-hide" onClick={onHide} />
    </header>
    <div className="workspace-pane" id={`workspace-pane-${thread.id}`} role="tabpanel" aria-labelledby={`workspace-tab-${current.id}`}>
      {tabs.filter(tab => tab.kind === "canvas").map(tab => <CanvasPanel key={tab.id} id={tab.id} thread={thread} visible={visible && current.id === tab.id} suspended={suspended} full={full} />)}
      {tabs.some((tab) => tab.kind === "review") && <div className="workspace-tool-pane" hidden={!visible || current.kind !== "review"}>
        <ChangesPanel visible={visible && current.kind === "review"} thread={thread} changes={changes} onRefresh={onRefresh} onRevert={onRevert} />
      </div>}
      {visible && current.kind === "files" && <FilesPanel key={thread.id} thread={thread} onShowChanges={() => openTool("review")} />}
      {visible && current.kind === "terminal" && terminal}
      {visible && current.kind === "subagents" && <SubagentsPanel items={items} />}
      {browserPage && <>
        <div className="workspace-navigation">
          <div className="workspace-history"><IconButton icon="arrow-left" label="Go back" size="md" disabled={!current.browser?.back} onClick={() => void browserCommand("back")} /><IconButton icon="arrow-right" label="Go forward" size="md" disabled={!current.browser?.forward} onClick={() => void browserCommand("forward")} /><span className="history-separator" /><IconButton icon="restart" label="Reload page" size="md" disabled={current.kind === "new"} onClick={() => void browserCommand("reload")} /></div>
          <form className="workspace-address-form" onSubmit={(e) => { e.preventDefault(); void browserCommand("navigate", address); }}><SecretInput ref={addressRef} data-testid="workspace-address" aria-label="Search or enter a URL" placeholder="Search or enter a URL" value={address} onChange={(e) => { addressEdited.current = true; setAddress(e.target.value); }} spellCheck={false} /></form>
          <IconButton icon="comment" label="Focus chat" className="workspace-circle" size="md" onClick={() => { setFull(false); onFocusChat(); }} />
          <IconButton icon="gear" label="Browser extensions and sign-in" className="workspace-circle" size="md" onClick={() => setBrowserTools(true)} />
          <span className="workspace-menu-anchor"><IconButton ref={pageRef} icon="more" label="Page options" className="workspace-circle" size="md" aria-haspopup="menu" aria-expanded={pageMenu} onClick={() => setPageMenu(!pageMenu)} /><Menu open={pageMenu} anchorRef={pageRef} onClose={() => setPageMenu(false)} label="Page options" placement="bottom-end"><MenuItem disabled={!current.browser?.url?.startsWith("https:") || signingIn} onClick={() => void browserAction("fill")}>Fill with 1Password</MenuItem><MenuItem disabled={!current.browser?.url} onClick={() => void browserAction("external")}>Open in system browser</MenuItem><MenuItem disabled={!current.browser?.url} onClick={() => { void bridge.invoke("clipboard:write", { text: current.browser?.url ?? "" }); setPageMenu(false); }}>Copy page URL</MenuItem><MenuItem onClick={() => { closeTab(current); setPageMenu(false); }}>Close tab</MenuItem></Menu></span>
        </div>
        {(error || current.browser?.error) && <ErrorNotice className="workspace-error" testId="workspace-error" where="Browser" message={error || current.browser?.error || ""}
          onRetry={error ? (failed?.message === error ? () => { setError(""); failed.retry(); } : undefined) : () => void browserCommand("reload")}
          retryLabel={error ? "Retry" : "Reload page"} context={{ threadId: thread.id, page: current.browser?.url }} />}
        {(signingIn || browserNotice) && <p className="hint pad" role="status">{signingIn ? "Waiting for 1Password…" : browserNotice}</p>}
        {current.kind === "browser" ? <div className="workspace-guest" data-testid="workspace-browser" ref={guestHost}>{streamerMode && <p className="streamer-guest-cover" data-testid="streamer-browser-cover">Browser content is covered while Streamer Mode is on.</p>}{!streamerMode && current.browser?.loading && <p className="hint pad" role="status">Loading page…</p>}</div> :
          <div className="workspace-start">
            <h2>Tools</h2>
            <div className="workspace-tools">
              <button onClick={() => openTool("review")}><Icon name="review" size={16} /><span>Review</span><kbd>⌃⇧G</kbd></button>
              <span className="workspace-menu-anchor workspace-terminal-tool"><button onClick={() => openTool("terminal")}><Icon name="terminal-box" size={16} /><span>Terminal</span><kbd>⌃`</kbd></button><IconButton ref={terminalRef} icon="more" label="Terminal options" aria-haspopup="menu" aria-expanded={terminalMenu} onClick={() => setTerminalMenu(!terminalMenu)} /><Menu open={terminalMenu} anchorRef={terminalRef} onClose={() => setTerminalMenu(false)} label="Terminal options" placement="bottom-end"><MenuItem onClick={() => { setTerminalMenu(false); openTool("terminal"); }}>Open terminal</MenuItem><MenuItem onClick={() => { setTerminalMenu(false); void bridge.invoke("shell:openTerminal", { path: thread.cwd }).catch((e: Error) => setError(e.message)); }}>Open external terminal</MenuItem></Menu></span>
              <button onClick={() => openTool("canvas")}><Icon name="grid" size={16} /><span>Canvas</span></button>
              {subagentsOf(items).length > 0 && <button data-testid="workspace-open-subagents" onClick={() => openTool("subagents")}><Icon name="agents" size={16} /><span>Subagents</span></button>}
              <button onClick={() => openTool("files")}><Icon name="files" size={16} /><span>Files</span><kbd>⌘P</kbd></button>
              <span className="workspace-menu-anchor"><button ref={toolsRef} aria-haspopup="menu" aria-expanded={toolsMenu} onClick={() => setToolsMenu(!toolsMenu)}><Icon name="grid" size={16} /><span>More tools...</span><Icon name="chevron-down" size={17} /></button><Menu open={toolsMenu} anchorRef={toolsRef} onClose={() => setToolsMenu(false)} label="More tools" placement="bottom-end"><MenuItem onClick={() => { setToolsMenu(false); void bridge.invoke("shell:openPath", { path: thread.cwd }).catch((e: Error) => setError(e.message)); }}>Open project folder</MenuItem><MenuItem onClick={() => { setToolsMenu(false); void bridge.invoke("shell:openTerminal", { path: thread.cwd }).catch((e: Error) => setError(e.message)); }}>Open external terminal</MenuItem></Menu></span>
            </div>
          </div>}
      </>}
    </div>
    {visible && browserTools && <BrowserToolsDialog onClose={() => setBrowserTools(false)} />}
  </aside>;
}

/** The folders and files directly inside each folder, built once from the flat listing. "" is the root. */
type FileIndex = Map<string, { dirs: string[]; files: string[] }>;
function indexFiles(paths: string[]): FileIndex {
  const index: FileIndex = new Map([["", { dirs: [], files: [] }]]);
  const seen = new Set<string>();
  for (const path of paths) {
    let parent = "";
    const parts = path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parent ? `${parent}/${parts[i]}` : parts[i]!;
      if (!seen.has(dir)) { seen.add(dir); index.get(parent)!.dirs.push(dir); index.set(dir, { dirs: [], files: [] }); }
      parent = dir;
    }
    index.get(parent)!.files.push(path);
  }
  return index;
}
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const ancestors = (path: string) => path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"));
/** Source lines are drawn in blocks the browser can skip while they are off screen. */
const BLOCK = 200;
/** Above this size a Markdown file opens as source: rendering it would stall the pane. */
const RENDER_LIMIT = 400_000;

/** One folder's rows. Only open folders have their children in the page, so a large repository stays cheap. */
function FileTree({ index, dir, depth, open, onToggle, onOpen, selected, focus }: { index: FileIndex; dir: string; depth: number; open: Set<string>; onToggle(dir: string): void; onOpen(path: string): void; selected: string; focus?: string }) {
  const node = index.get(dir);
  if (!node) return null;
  return <ul className="file-tree" role={depth ? "group" : "tree"} aria-label={depth ? undefined : "Files"}>
    {node.dirs.map((d) => <li key={d} role="none">
      <button type="button" role="treeitem" aria-expanded={open.has(d)} className={`file-tree-row${focus === d ? " focus" : ""}`} data-dir={d} style={{ paddingLeft: 8 + depth * 17 }} onClick={() => onToggle(d)}><Icon name={open.has(d) ? "chevron-down" : "chevron-right"} size={12} /><span>{baseName(d)}</span></button>
      {open.has(d) && <FileTree index={index} dir={d} depth={depth + 1} open={open} onToggle={onToggle} onOpen={onOpen} selected={selected} focus={focus} />}
    </li>)}
    {node.files.map((f) => <li key={f} role="none">
      <button type="button" role="treeitem" className={`file-tree-row file${selected === f ? " selected" : ""}`} aria-label={`Open ${f}`} title={f} style={{ paddingLeft: 8 + depth * 17 }} onClick={() => onOpen(f)}><FileIcon path={f} /><span>{baseName(f)}</span></button>
    </li>)}
  </ul>;
}

function FilesPanel({ thread, onShowChanges }: { thread: Thread; onShowChanges(): void }) {
  const [listing, setListing] = useState<{ paths: string[]; truncated: boolean } | null>(null);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ path: string; text: string; error?: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  // The crumb whose folder list is showing: "" is the root, otherwise a folder path.
  const [crumb, setCrumb] = useState<string | null>(null);
  const [source, setSource] = useState(false);
  const [copied, setCopied] = useState(false);
  const pop = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void bridge.invoke("files:list", { threadId: thread.id }).then((value) => { if (live) { setListing(value); setError(""); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [thread.id, revision]);
  useEffect(() => {
    if (!selected) return;
    let live = true;
    setResult(null);
    void bridge.invoke("files:read", { threadId: thread.id, path: selected }).then((text) => { if (live) setResult({ path: selected, text }); }, (e: Error) => { if (live) setResult({ path: selected, text: "", error: e.message }); });
    return () => { live = false; };
  }, [thread.id, selected, revision]);
  useEffect(() => {
    if (crumb === null) return;
    const away = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest(".file-crumbs, .file-crumb-pop")) setCrumb(null); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setCrumb(null); } };
    document.addEventListener("pointerdown", away); document.addEventListener("keydown", key, true);
    pop.current?.querySelector(".file-tree-row.focus")?.scrollIntoView({ block: "nearest" });
    return () => { document.removeEventListener("pointerdown", away); document.removeEventListener("keydown", key, true); };
  }, [crumb]);
  const index = useMemo(() => indexFiles(listing?.paths ?? []), [listing]);
  const matches = useMemo(() => { const q = filter.trim().toLowerCase(); return q ? (listing?.paths ?? []).filter((p) => p.toLowerCase().includes(q)).slice(0, 300) : null; }, [listing, filter]);
  const toggle = (dir: string) => setOpen((current) => { const next = new Set(current); if (next.has(dir)) next.delete(dir); else next.add(dir); return next; });
  const openFile = (path: string) => { setSelected(path); setCrumb(null); setSource(false); setFilter(""); };
  const showCrumb = (dir: string) => {
    if (crumb === dir) { setCrumb(null); return; }
    setOpen((current) => new Set([...current, ...ancestors(`${dir}/x`).filter(Boolean)]));
    setCrumb(dir);
  };
  const markdown = /\.(md|mdx|markdown)$/i.test(selected);
  const rendered = markdown && !source && Boolean(result) && !result!.error && result!.text.length <= RENDER_LIMIT;
  const lines = useMemo(() => result && !result.error && !rendered ? result.text.split("\n") : [], [result, rendered]);
  const copy = () => { if (!result || result.error) return; void bridge.invoke("clipboard:write", { text: result.text }).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }, (e: Error) => setError(e.message)); };
  const root = baseName(thread.cwd.replace(/[\\/]+$/, "").replace(/\\/g, "/")) || "Project";
  const dirs = selected ? ancestors(selected) : [];
  return <section className="workspace-files">
    <header className="file-bar">
      <nav className="file-crumbs" aria-label="File path">
        <button type="button" aria-expanded={crumb === ""} onClick={() => showCrumb("")}>{root}</button>
        {dirs.map((d) => <span key={d}><Icon name="chevron-right" size={11} /><button type="button" aria-expanded={crumb === d} onClick={() => showCrumb(d)}>{baseName(d)}</button></span>)}
        {selected && <span><Icon name="chevron-right" size={11} /><strong title={selected}>{baseName(selected)}</strong></span>}
      </nav>
      <span className="spacer" />
      <button type="button" className="file-pill" onClick={onShowChanges}><Icon name="diff-color" size={15} />Show changes</button>
      {markdown && <button type="button" className="file-pill" data-testid="file-view-source" aria-pressed={source} onClick={() => setSource((value) => !value)}><Icon name="file" size={15} />{source ? "View rendered" : "View source"}</button>}
      {selected && <button type="button" className="file-pill" onClick={() => void bridge.invoke("shell:openPath", { path: `${thread.cwd}/${selected}` }).catch((e: Error) => setError(e.message))}><Icon name="external" size={15} />Open</button>}
      {selected && <IconButton icon={copied ? "check" : "copy"} label={copied ? "Copied" : "Copy file contents"} size="md" className="file-round" onClick={copy} />}
      <IconButton icon="restart" label="Refresh files" size="md" className="file-round" onClick={() => setRevision((n) => n + 1)} />
      {crumb !== null && <div ref={pop} className="file-crumb-pop" data-testid="file-crumb-pop">
        <FileTree index={index} dir="" depth={0} open={open} onToggle={toggle} onOpen={openFile} selected={selected} focus={crumb || undefined} />
      </div>}
    </header>
    {error && <ErrorNotice className="workspace-error" testId="files-error" where="Files · list" message={error} onRetry={() => setRevision((n) => n + 1)} context={{ threadId: thread.id, cwd: thread.cwd }} />}
    <div className="file-body">
      {!selected ? <div className="file-browse">
        <label className="review-filter"><Icon name="search" size={13} /><SecretInput autoFocus aria-label="Find a file" placeholder="Filter files..." value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        {!listing && !error && <p className="hint pad">Loading files…</p>}
        {matches ? matches.length ? matches.map((p) => <button key={p} className="file-tree-row file" aria-label={`Open ${p}`} title={p} onClick={() => openFile(p)}><FileIcon path={p} /><span>{p}</span></button>) : <p className="hint pad">No matching files.</p>
          : listing && <FileTree index={index} dir="" depth={0} open={open} onToggle={toggle} onOpen={openFile} selected={selected} />}
        {listing?.truncated && <p className="hint pad">Showing the first 5,000 files.</p>}
      </div>
        : !result ? <p className="hint pad">Loading file…</p>
        : result.error ? <ErrorNotice className="workspace-error" testId="file-read-error" where="Files · read" message={result.error} onRetry={() => setRevision((n) => n + 1)} context={{ threadId: thread.id, cwd: thread.cwd, path: selected }} />
        : rendered ? <div className="file-rendered" data-testid="workspace-file-content"><Markdown text={result.text} /></div>
        : <pre className="workspace-file-content" data-testid="workspace-file-content">{Array.from({ length: Math.ceil(lines.length / BLOCK) }, (_, block) => <div key={block} className="file-block" style={{ containIntrinsicSize: `auto ${Math.min(BLOCK, lines.length - block * BLOCK) * 22}px` }}>{lines.slice(block * BLOCK, (block + 1) * BLOCK).map((line, i) => <div key={i}><span className="line-number">{block * BLOCK + i + 1}</span><code>{line || " "}</code></div>)}</div>)}</pre>}
    </div>
  </section>;
}
