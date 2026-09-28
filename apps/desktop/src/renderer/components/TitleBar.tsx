import { useEffect, useRef, useState } from "react";
import type { Thread } from "../../shared/types";
import { shortenHome, tailPath } from "./ThreadView";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "./ui/Menu";
import { Tooltip } from "./ui/Tooltip";

interface Props {
  thread: Thread | null;
  onRename: (title: string) => void;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  showChanges: boolean;
  onToggleChanges: () => void;
  changedCount: number;
  showTerminal: boolean;
  onToggleTerminal: () => void;
  onOpenPath: (path: string) => void;
  onOpenTerminal: (path: string) => void;
  onDelete: (thread: Thread) => void;
  platform: string;
}

/** Width of the Changes panel; while it is open the thread's actions sit at the main pane's right edge. */
const CHANGES_W = 420;

/**
 * The 42 px window titlebar (a drag region). Left, over the rail and sidebar: space for the traffic
 * lights, back/forward through selected threads, and the sidebar toggle. Right, over the thread: its
 * title (double-click to rename) and the thread's status and Changes controls.
 */
export function TitleBar({ thread, onRename, canBack, canForward, onBack, onForward, sidebarOpen, onToggleSidebar, showChanges, onToggleChanges, changedCount, showTerminal, onToggleTerminal, onOpenPath, onOpenTerminal, onDelete, platform }: Props) {
  const [renameSignal, setRenameSignal] = useState(0);
  const inset = thread && showChanges ? CHANGES_W : 0;
  return (
    <header className={`titlebar drag${sidebarOpen ? "" : " sidebar-closed"}`} data-testid="titlebar" style={{ ["--changes-w" as string]: inset ? "var(--changes-panel-w, 420px)" : "0px" }}>
      <div className="titlebar-nav">
        <IconButton icon="arrow-left" label="Back" size="md" data-testid="nav-back" disabled={!canBack} onClick={onBack} />
        <IconButton icon="arrow-right" label="Forward" size="md" data-testid="nav-forward" disabled={!canForward} onClick={onForward} />
        <IconButton icon="sidebar" label={sidebarOpen ? "Hide sidebar" : "Show sidebar"} size="md" data-testid="sidebar-toggle" aria-pressed={sidebarOpen} onClick={onToggleSidebar} />
      </div>
      {thread && (
        <div className="titlebar-main">
          <ThreadTitle key={thread.id} title={thread.title} onRename={onRename} renameSignal={renameSignal} />
          <span className="spacer" />
          <div className="titlebar-actions">
            <IconButton icon="terminal" label={showTerminal ? "Hide terminal" : "Show terminal"} shortcut="⌃`" size="md" className={showTerminal ? "on" : undefined} data-testid="terminal-toggle" aria-pressed={showTerminal} onClick={onToggleTerminal} />
            <ThreadMenu thread={thread} platform={platform} onRename={() => setRenameSignal((n) => n + 1)} onOpenPath={onOpenPath} onOpenTerminal={onOpenTerminal} onDelete={onDelete} />
            <Tooltip label={showChanges ? "Hide changes" : "Show changes"} shortcut="⌘J">
              <button className={`icon-btn md changes-toggle${showChanges ? " on" : ""}`} data-testid="changes-toggle" aria-label="Changes" aria-pressed={showChanges} onClick={onToggleChanges}>
                <Icon name="changes" size={16} />
                {changedCount > 0 && <span className="count-badge" data-testid="changes-count">{changedCount}</span>}
              </button>
            </Tooltip>
          </div>
        </div>
      )}
    </header>
  );
}

/** The thread's ⋯ menu: rename, where it runs (open, copy), and delete. */
function ThreadMenu({ thread, platform, onRename, onOpenPath, onOpenTerminal, onDelete }: { thread: Thread; platform: string; onRename: () => void; onOpenPath: (p: string) => void; onOpenTerminal: (p: string) => void; onDelete: (t: Thread) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <span className="composer-menu">
      <IconButton ref={trigger} icon="more" label="Thread actions" size="md" data-testid="thread-menu-toggle" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={trigger} label="Thread actions" placement="bottom-end" testId="thread-actions" className="thread-actions">
        <MenuLabel><span data-testid="thread-menu-path" title={thread.cwd}>{thread.worktree ? `⑂ ${thread.worktree.branch} · ` : ""}{tailPath(shortenHome(thread.cwd))}</span></MenuLabel>
        <MenuItem data-testid="action-rename" onClick={pick(onRename)}>Rename</MenuItem>
        <MenuItem data-testid="action-open-folder" onClick={pick(() => onOpenPath(thread.cwd))}>{platform === "darwin" ? "Open in Finder" : "Open folder"}</MenuItem>
        <MenuItem data-testid="action-open-terminal" onClick={pick(() => onOpenTerminal(thread.cwd))}>Open terminal here</MenuItem>
        <MenuItem data-testid="action-copy-path" onClick={pick(() => void navigator.clipboard.writeText(thread.cwd))}>Copy path</MenuItem>
        <MenuSeparator />
        <MenuItem data-testid="action-delete" className="danger" onClick={pick(() => onDelete(thread))}>Delete thread</MenuItem>
      </Menu>
    </span>
  );
}

/** Reads as text; double-click (or Enter while focused, or ⋯ → Rename) to edit. Enter/blur saves, Escape cancels, blank is refused. */
function ThreadTitle({ title, onRename, renameSignal }: { title: string; onRename: (t: string) => void; renameSignal: number }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renameSignal > 0) setEditing(true); }, [renameSignal]);
  useEffect(() => { if (!editing) setDraft(title); }, [title, editing]);
  useEffect(() => { if (editing) { input.current?.focus(); input.current?.select(); } }, [editing]);

  const commit = () => {
    const t = draft.trim();
    setEditing(false);
    if (t && t !== title) onRename(t);
    else setDraft(title);
  };
  return (
    <input
      ref={input}
      className={`title-text${editing ? " editing" : ""}`}
      data-testid="thread-title"
      aria-label="Thread title"
      title={editing ? undefined : `${title} — double-click to rename`}
      readOnly={!editing}
      value={draft}
      spellCheck={false}
      onDoubleClick={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => editing && commit()}
      onKeyDown={(e) => {
        if (!editing) {
          if (e.key === "Enter") { e.preventDefault(); setEditing(true); }
          return;
        }
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); setDraft(title); setEditing(false); }
      }}
    />
  );
}
