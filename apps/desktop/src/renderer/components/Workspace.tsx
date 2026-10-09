import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { ChangesSnapshot, Thread } from "../../shared/types";
import type { BrowserSnapshot } from "../../shared/browser";
import { bridge } from "../bridge";
import { ChangesPanel, FileIcon } from "./ChangesPanel";
import { Icon, type IconName } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { Menu, MenuItem } from "./ui/Menu";
import { BrowserToolsDialog } from "./BrowserToolsDialog";
import "../workspace.css";

type Tab = { id: string; kind: "new" | "review" | "files" | "terminal" | "browser"; title: string; browser?: BrowserSnapshot };
const makeTab = (): Tab => ({ id: crypto.randomUUID(), kind: "new", title: "New tab" });
const tabIcon = (kind: Tab["kind"]): IconName => kind === "review" ? "review" : kind === "files" ? "folder" : kind === "terminal" ? "terminal-box" : "globe";
interface Props {
  thread: Thread; changes: ChangesSnapshot | null; onRefresh: () => void; onRevert: (path: string) => void;
  visible: boolean; onShow: () => void; onHide: () => void; suspended: boolean;
  terminal: ReactNode; onOpenTerminal: () => void; onHideTerminal: () => void; onFocusChat: () => void;
}

export function Workspace({ thread, changes, onRefresh, onRevert, visible, onShow, onHide, suspended, terminal, onOpenTerminal, onHideTerminal, onFocusChat }: Props) {
  const [tabs, setTabs] = useState<Tab[]>(() => [makeTab(), { id: "review", kind: "review", title: "Review" }]);
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
    requestAnimationFrame(() => addressRef.current?.focus());
  }, [onShow, onHideTerminal]);
  const openTool = (kind: "review" | "files" | "terminal") => {
    const existing = tabs.find((tab) => tab.kind === kind);
    const tab: Tab = existing ?? { id: kind, kind, title: kind === "review" ? "Review" : kind === "files" ? "Files" : "Terminal" };
    if (!existing) setTabs((prev) => [...prev, tab]);
    activate(tab); onShow(); setToolsMenu(false);
  };
  const closeTab = (tab: Tab) => {
    void bridge.invoke("browser:command", { id: tab.id, action: "close" }).catch(() => {});
    const next = tabs.filter((t) => t.id !== tab.id);
    if (!next.length) next.push(makeTab());
    setTabs(next);
    if (active === tab.id) activate(next[Math.max(0, tabs.indexOf(tab) - 1)] ?? next[0]!);
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
  useEffect(() => bridge.onWorkspaceShortcut?.((shortcut) => {
    if (suspended) return;
    if (shortcut === "new" || shortcut === "full") newTab(shortcut === "full");
    else if (shortcut === "files" || shortcut === "review" || shortcut === "terminal") openTool(shortcut);
    else if (shortcut === "address") { addressRef.current?.focus(); addressRef.current?.select(); }
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
    } catch (error) { setError((error as Error).message); }
  };
  const browserAction = async (action: "fill" | "external") => {
    const id = current.id;
    setPageMenu(false); setError(""); setBrowserNotice("");
    if (action === "fill") setSigningIn(true);
    try {
      if (action === "external") await bridge.invoke("browser:external", { id });
      else if (await bridge.invoke("browser:fillLogin", { id }) && currentRef.current.id === id) setBrowserNotice("Login filled. Review the fields, then sign in.");
    } catch (error) { if (currentRef.current.id === id) setError((error as Error).message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "")); }
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
      const overlay = document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], .streamer-shield');
      const rect = host?.getBoundingClientRect();
      const show = visible && !suspended && !overlay && current.kind === "browser" && !current.browser?.error && rect;
      void bridge.invoke("browser:show", { id: show ? current.id : null, fullView: full, ...(show ? { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : {}) }).catch(() => {});
    };
    update();
    const resize = new ResizeObserver(update);
    if (host) resize.observe(host);
    const mutations = new MutationObserver(update);
    mutations.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    return () => { resize.disconnect(); mutations.disconnect(); window.removeEventListener("resize", update); void bridge.invoke("browser:show", { id: null }).catch(() => {}); };
  }, [current.id, current.kind, current.browser?.error, visible, suspended, full]);
  const browserPage = current.kind === "new" || current.kind === "browser";
  return <aside ref={container} className="workspace" data-testid="workspace" hidden={!visible} aria-label="Workspace" data-full-view={full} data-page-kind={current.kind}>
    <header className="workspace-tabbar">
      <div className="workspace-tabs" role="tablist" aria-label="Workspace tabs">
        {tabs.map((tab) => <div key={tab.id} className={`workspace-tab${tab.id === current.id ? " selected" : ""}`}>
          <button role="tab" aria-selected={tab.id === current.id} aria-controls={`workspace-pane-${thread.id}`} tabIndex={tab.id === current.id ? 0 : -1} onClick={() => activate(tab)} onKeyDown={(e) => {
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
      <IconButton icon="tabs" label="Hide workspace" size="md" className="workspace-hide" onClick={onHide} />
    </header>
    <div className="workspace-pane" id={`workspace-pane-${thread.id}`} role="tabpanel" aria-label={current.title}>
      {visible && current.kind === "review" && <ChangesPanel thread={thread} changes={changes} onRefresh={onRefresh} onRevert={onRevert} />}
      {visible && current.kind === "files" && <FilesPanel key={thread.id} thread={thread} />}
      {visible && current.kind === "terminal" && terminal}
      {browserPage && <>
        <div className="workspace-navigation">
          <div className="workspace-history"><IconButton icon="arrow-left" label="Go back" size="md" disabled={!current.browser?.back} onClick={() => void browserCommand("back")} /><IconButton icon="arrow-right" label="Go forward" size="md" disabled={!current.browser?.forward} onClick={() => void browserCommand("forward")} /><span className="history-separator" /><IconButton icon="restart" label="Reload page" size="md" disabled={current.kind === "new"} onClick={() => void browserCommand("reload")} /></div>
          <form className="workspace-address-form" onSubmit={(e) => { e.preventDefault(); void browserCommand("navigate", address); }}><input ref={addressRef} data-testid="workspace-address" aria-label="Search or enter a URL" placeholder="Search or enter a URL" value={address} onChange={(e) => { addressEdited.current = true; setAddress(e.target.value); }} spellCheck={false} /></form>
          <IconButton icon="comment" label="Focus chat" className="workspace-circle" size="md" onClick={() => { setFull(false); onFocusChat(); }} />
          <IconButton icon="gear" label="Browser extensions and sign-in" className="workspace-circle" size="md" onClick={() => setBrowserTools(true)} />
          <span className="workspace-menu-anchor"><IconButton ref={pageRef} icon="more" label="Page options" className="workspace-circle" size="md" aria-haspopup="menu" aria-expanded={pageMenu} onClick={() => setPageMenu(!pageMenu)} /><Menu open={pageMenu} anchorRef={pageRef} onClose={() => setPageMenu(false)} label="Page options" placement="bottom-end"><MenuItem disabled={!current.browser?.url?.startsWith("https:") || signingIn} onClick={() => void browserAction("fill")}>Fill with 1Password</MenuItem><MenuItem disabled={!current.browser?.url} onClick={() => void browserAction("external")}>Open in system browser</MenuItem><MenuItem disabled={!current.browser?.url} onClick={() => { void bridge.invoke("clipboard:write", { text: current.browser?.url ?? "" }); setPageMenu(false); }}>Copy page URL</MenuItem><MenuItem onClick={() => { closeTab(current); setPageMenu(false); }}>Close tab</MenuItem></Menu></span>
        </div>
        {(error || current.browser?.error) && <p className="workspace-error" role="alert">{error || current.browser?.error}</p>}
        {(signingIn || browserNotice) && <p className="hint pad" role="status">{signingIn ? "Waiting for 1Password…" : browserNotice}</p>}
        {current.kind === "browser" ? <div className="workspace-guest" data-testid="workspace-browser" ref={guestHost}>{current.browser?.loading && <p className="hint pad" role="status">Loading page…</p>}</div> :
          <div className="workspace-start">
            <h2>Tools</h2>
            <div className="workspace-tools">
              <button onClick={() => openTool("review")}><Icon name="review" size={16} /><span>Review</span><kbd>⌃⇧G</kbd></button>
              <span className="workspace-menu-anchor workspace-terminal-tool"><button onClick={() => openTool("terminal")}><Icon name="terminal-box" size={16} /><span>Terminal</span><kbd>⌃`</kbd></button><IconButton ref={terminalRef} icon="more" label="Terminal options" aria-haspopup="menu" aria-expanded={terminalMenu} onClick={() => setTerminalMenu(!terminalMenu)} /><Menu open={terminalMenu} anchorRef={terminalRef} onClose={() => setTerminalMenu(false)} label="Terminal options" placement="bottom-end"><MenuItem onClick={() => { setTerminalMenu(false); openTool("terminal"); }}>Open terminal</MenuItem><MenuItem onClick={() => { setTerminalMenu(false); void bridge.invoke("shell:openTerminal", { path: thread.cwd }).catch((e: Error) => setError(e.message)); }}>Open external terminal</MenuItem></Menu></span>
              <button onClick={() => openTool("files")}><Icon name="files" size={16} /><span>Files</span><kbd>⌘P</kbd></button>
              <span className="workspace-menu-anchor"><button ref={toolsRef} aria-haspopup="menu" aria-expanded={toolsMenu} onClick={() => setToolsMenu(!toolsMenu)}><Icon name="grid" size={16} /><span>More tools...</span><Icon name="chevron-down" size={17} /></button><Menu open={toolsMenu} anchorRef={toolsRef} onClose={() => setToolsMenu(false)} label="More tools" placement="bottom-end"><MenuItem onClick={() => { setToolsMenu(false); void bridge.invoke("shell:openPath", { path: thread.cwd }).catch((e: Error) => setError(e.message)); }}>Open project folder</MenuItem><MenuItem onClick={() => { setToolsMenu(false); void bridge.invoke("shell:openTerminal", { path: thread.cwd }).catch((e: Error) => setError(e.message)); }}>Open external terminal</MenuItem></Menu></span>
            </div>
            <h2 className="workspace-suggested-title">Suggested</h2>
            <button className="workspace-suggestion" onClick={() => void browserCommand("navigate", "https://workspace.google.com/gmail/")}><span className="google-mark" aria-hidden="true">G</span><span>Gmail: Secure, AI-Powered Email for Everyone | Google Workspace</span></button>
          </div>}
      </>}
    </div>
    {visible && browserTools && <BrowserToolsDialog onClose={() => setBrowserTools(false)} />}
  </aside>;
}

function FilesPanel({ thread }: { thread: Thread }) {
  const [listing, setListing] = useState<{ paths: string[]; truncated: boolean } | null>(null);
  const [selected, setSelected] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ path: string; text: string; error?: string } | null>(null);
  const [revision, setRevision] = useState(0);
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
  const paths = (listing?.paths ?? []).filter((p) => p.toLowerCase().includes(filter.toLowerCase()));
  return <section className="workspace-files">
    <header className="review-toolbar"><span>Files</span><span className="spacer" /><IconButton icon="restart" label="Refresh files" onClick={() => setRevision((n) => n + 1)} /></header>
    {error && <p className="workspace-error" role="alert">{error}</p>}
    <div className="review-body">
      <div className="review-diff"><div className="review-file-heading">{selected || "Select a file"}</div>{selected && (!result ? <p className="hint pad">Loading file…</p> : result.error ? <p className="workspace-error" role="alert">{result.error}</p> : <pre className="workspace-file-content" data-testid="workspace-file-content">{result.text.split("\n").map((line, i) => <div key={i}><span className="line-number">{i + 1}</span><code>{line || " "}</code></div>)}</pre>)}</div>
      <aside className="review-tree"><label className="review-filter"><Icon name="search" size={13} /><input autoFocus aria-label="Find a file" placeholder="Filter files..." value={filter} onChange={(e) => setFilter(e.target.value)} /></label>
        {!listing && !error && <p className="hint pad">Loading files…</p>}{listing && !paths.length && <p className="hint pad">No matching files.</p>}
        {paths.map((p) => <button key={p} className={`review-file-select workspace-file${selected === p ? " selected" : ""}`} aria-label={`Open ${p}`} title={p} onClick={() => setSelected(p)}><FileIcon path={p} /><span>{p}</span></button>)}
        {listing?.truncated && <p className="hint pad">Showing the first 5,000 files.</p>}
      </aside>
    </div>
  </section>;
}
