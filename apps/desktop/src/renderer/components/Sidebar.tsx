import { BrandMark } from "./BrandMark";
import { ActiveAgents, type ActiveAgent } from "./ActiveAgents";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AppState, PullRequestSummary, Thread, ThreadContext } from "../../shared/types";
import { bridge } from "../bridge";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { Menu, MenuItem } from "./ui/Menu";

interface Props {
  state: AppState;
  selected: string | null;
  onSelect: (threadId: string) => void;
  /** The project an open draft belongs to; its row is highlighted like a selection. */
  draftProjectId?: string;
  onAddProject: () => void;
  /** "New chat": a thread in the current project (the selected thread's, else the first). */
  onNewChat: () => void;
  onNewThread: (projectId: string, worktree?: boolean) => void;
  onDeleteThread: (thread: Thread) => void;
  onRemoveProject: (projectId: string) => void;
  /** Threads holding unsent composer text; their rows carry a small pen glyph. */
  unsent?: Record<string, string>;
  agents?: ActiveAgent[];
}

/** Threads shown per project before "Show more". */
export const THREADS_PER_PROJECT = 5;

export function Sidebar({ state, selected, onSelect, draftProjectId, onAddProject, onNewChat, onNewThread, onDeleteThread, onRemoveProject, unsent, agents = [] }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [retiredOpen, setRetiredOpen] = useState<Record<string, boolean>>({});
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();

  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  const groups = state.projects.map((p) => {
    const mine = state.threads.filter((t) => t.projectId === p.id);
    // Finished tasks (PR merged, worktree removed) leave the working list; they stay reachable below it.
    const all = mine.filter((t) => !t.retired);
    const retired = mine.filter((t) => t.retired && (!q || t.title.toLowerCase().includes(q)));
    return { project: p, all, retired, matches: q ? all.filter((t) => t.title.toLowerCase().includes(q)) : all };
  });
  const noMatches = q && groups.every((g) => g.matches.length === 0 && g.retired.length === 0);

  return (
    <aside className="sidebar" data-testid="sidebar">
      <header className="sidebar-head">
        <h1 className="sidebar-title" data-testid="sidebar-title"><BrandMark />Modex</h1>
        <span className="spacer" />
        <IconButton icon="search" label="Search threads" size="md" data-testid="search-toggle" aria-pressed={searching} onClick={() => (searching ? closeSearch() : setSearching(true))} />
      </header>
      {searching && (
        <div className="sidebar-search">
          <Icon name="search" size={14} />
          <input
            autoFocus
            data-testid="thread-search"
            aria-label="Search threads"
            placeholder="Search threads"
            value={query}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && closeSearch()}
          />
        </div>
      )}
      <button className="side-row new-chat" data-testid="new-chat" title="New chat (⌘N)" onClick={onNewChat} disabled={state.projects.length === 0}>
        <Icon name="compose" className="side-row-icon" />
        <span className="side-row-label">New chat</span>
      </button>

      <ActiveAgents agents={agents} onSelect={onSelect} />
      <div className="section-label">
        <span>Projects</span>
        <span className="spacer" />
        <IconButton icon="plus" label="Open project…" data-testid="add-project" onClick={onAddProject} />
      </div>
      <nav className="projects" aria-label="Projects">
        {state.projects.length === 0 && <p className="side-hint">No projects yet. Open a folder to start a thread.</p>}
        {noMatches && <p className="side-hint" data-testid="search-empty">No threads match “{query.trim()}”.</p>}
        {groups.map(({ project: p, all, retired, matches }) => {
          if (q && matches.length === 0 && retired.length === 0) return null;
          const isCollapsed = !q && collapsed[p.id];
          const selectedIndex = matches.findIndex((t) => t.id === selected);
          const showAll = Boolean(q) || expanded[p.id] || selectedIndex >= THREADS_PER_PROJECT;
          const visible = showAll ? matches : matches.slice(0, THREADS_PER_PROJECT);
          const busy = all.some((t) => t.status === "running" || t.status === "waiting");
          return (
            <section key={p.id} className="project" data-testid="project" data-project-id={p.id}>
              <div className={`side-row project-row${p.id === draftProjectId ? " selected" : ""}`} title={p.path} data-draft={p.id === draftProjectId ? "true" : undefined}>
                <button className="project-toggle" data-testid="project-toggle" aria-expanded={!isCollapsed} onClick={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))}>
                  <Icon name="folder" className="side-row-icon" />
                  <span className="side-row-label" data-testid="project-name">{p.name}</span>
                </button>
                {isCollapsed && busy && <span className="row-status running" title="A thread in this project is working" />}
                <span className="row-actions">
                  <IconButton icon="plus" label="New chat" shortcut="⌘N" reveal data-testid="project-new-thread" onClick={() => onNewThread(p.id)} />
                  <IconButton icon="branch" label="New chat in a git worktree" shortcut="⇧⌘N" reveal data-testid="project-new-worktree-thread" onClick={() => onNewThread(p.id, true)} />
                  <RowMenu label="Project actions" testId="project-menu">
                    <MenuItem data-testid="project-remove" className="danger" onClick={() => onRemoveProject(p.id)}>Remove project</MenuItem>
                  </RowMenu>
                </span>
              </div>
              {!isCollapsed && (
                <ul className="threads">
                  {all.length === 0 && <li className="side-hint small">No threads</li>}
                  {visible.map((t) => <ThreadRow key={t.id} thread={t} selected={t.id === selected} unsent={Boolean(unsent?.[t.id])}
                    onSelect={() => onSelect(t.id)} onDelete={() => onDeleteThread(t)} />)}
                  {!q && matches.length > THREADS_PER_PROJECT && selectedIndex < THREADS_PER_PROJECT && (
                    <li>
                      <button className="side-row show-more" data-testid="show-more" aria-expanded={Boolean(expanded[p.id])} onClick={() => setExpanded((x) => ({ ...x, [p.id]: !x[p.id] }))}>
                        <span className="side-row-label">{expanded[p.id] ? "Show less" : "Show more"}</span>
                      </button>
                    </li>
                  )}
                  {retired.length > 0 && (
                    <li>
                      <button className="side-row show-more" data-testid="retired-toggle" aria-expanded={Boolean(q) || Boolean(retiredOpen[p.id]) || retired.some((t) => t.id === selected)} onClick={() => setRetiredOpen((x) => ({ ...x, [p.id]: !x[p.id] }))}>
                        <span className="side-row-label">Finished ({retired.length})</span>
                      </button>
                    </li>
                  )}
                  {(q || retiredOpen[p.id] || retired.some((t) => t.id === selected)) && retired.map((t) => (
                    <ThreadRow key={t.id} thread={t} selected={t.id === selected} unsent={Boolean(unsent?.[t.id])} onSelect={() => onSelect(t.id)} onDelete={() => onDeleteThread(t)} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </nav>
    </aside>
  );
}

function ThreadRow({ thread: t, selected, unsent, onSelect, onDelete }: {
  thread: Thread; selected: boolean; unsent: boolean; onSelect: () => void; onDelete: () => void;
}) {
  const [context, setContext] = useState<ThreadContext | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    let pending = false;
    const refresh = async () => {
      // A finished task has no checkout left to read.
      if (pending || t.retired || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const result = await bridge.invoke("thread:context", { threadId: t.id });
        if (active) { setContext(result); setFailed(false); }
      } catch { if (active) { setContext(null); setFailed(true); } }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const reconnect = bridge.onReconnect?.(() => { setContext(null); void refresh(); });
    return () => { active = false; clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); reconnect?.(); };
  }, [t.id, t.cwd, t.status, t.retired]);

  const provider = t.backend === "claude" ? "Claude Code" : t.backend === "codex" ? "Codex" : "Mock";
  const model = t.model || "Default model";
  const pr = context?.pullRequest;
  const prLabel = t.retired ? `#${t.retired.pr} Merged` : pr ? pullRequestLabel(pr) : failed ? "PR unavailable" : "Loading…";
  const prTitle = pr && "number" in pr ? `${prLabel} · ${pr.title}` : pr && "detail" in pr ? pr.detail : "Reading checkout and pull request status";
  const branch = t.retired ? "Worktree removed" : context ? context.isRepo ? context.branch ?? "Detached HEAD" : "Local folder" : failed ? "Status unavailable" : "Checking branch…";
  return (
    <li className={`side-row thread-row${selected ? " selected" : ""}`} data-testid="thread-row" data-thread-id={t.id} data-status={t.status} aria-current={selected ? "true" : undefined}>
      <button className="thread-main" title={t.title} aria-label={t.title} aria-describedby={`thread-provider-${t.id}`} onClick={onSelect}>
        <span className="side-row-label" data-testid="thread-row-title">{t.title}</span>
        <span id={`thread-provider-${t.id}`} className="thread-provider-line" title={`${t.auto ? "Auto · " : ""}${provider} · ${model}${t.effort ? ` · ${t.effort}` : ""}`}>
          <span data-testid="thread-row-provider">{provider}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="thread-row-model">{t.auto ? `Auto · ${model}` : model}</span>
        </span>
      </button>
      <div className="thread-context-line">
        <span className="thread-branch" title={`${t.worktree ? "Worktree" : "Checkout"} · ${branch}`}>
          <Icon name="branch" size={11} /><span data-testid="thread-row-branch">{branch}</span>
        </span>
        {t.retired
          ? <a className="thread-pr" data-testid="thread-row-pr" data-state="merged" title="Pull request merged; worktree and branch removed" href={t.retired.url} target="_blank" rel="noreferrer">{prLabel}</a>
          : pr && "url" in pr
          ? <a className="thread-pr" data-testid="thread-row-pr" data-state={pr.state} title={prTitle} href={pr.url} target="_blank" rel="noreferrer">{prLabel}</a>
          : <span className="thread-pr" data-testid="thread-row-pr" title={prTitle}>{prLabel}</span>}
      </div>
      <span className="row-meta">
        {unsent && !selected && <span className="row-glyph unsent" data-testid="thread-row-unsent" title="Unsent message"><Icon name="compose" size={14} /></span>}
        <RowStatus status={t.status} />
        {t.worktree && <span className="row-glyph" data-testid="thread-row-worktree" title={`Worktree · ${t.worktree.branch}`}><Icon name="branch" size={14} /></span>}
      </span>
      <span className="row-actions">
        <RowMenu label="Thread actions" testId="thread-menu">
          <MenuItem data-testid="thread-delete" className="danger" onClick={onDelete}>Delete thread</MenuItem>
        </RowMenu>
      </span>
    </li>
  );
}

function pullRequestLabel(pr: PullRequestSummary): string {
  if ("number" in pr) return `#${pr.number} ${pr.state[0]!.toUpperCase()}${pr.state.slice(1)}`;
  return { none: "No PR", "no-remote": "No GitHub remote", detached: "No branch PR", disabled: "PR offline", unavailable: "PR unavailable" }[pr.state];
}

/** Right-hand status on a thread row: a spinning ring while working, a dot when it needs you or failed. */
function RowStatus({ status }: { status: Thread["status"] }) {
  if (status === "idle") return null;
  const title = status === "running" ? "Working" : status === "waiting" ? "Needs approval" : "Error";
  return <span className={`row-status ${status}`} data-testid="thread-row-status" title={title} />;
}

/** A hover "⋯" button on a sidebar row that opens a small command menu. */
function RowMenu({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <span className="row-menu" onClick={(e) => e.stopPropagation()}>
      <IconButton ref={trigger} icon="more" label={label} reveal data-testid={testId} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} />
      <Menu open={open} onClose={() => setOpen(false)} anchorRef={trigger} label={label} placement="bottom-end">
        <span className="menu-close-on-select" onClick={() => setOpen(false)}>{children}</span>
      </Menu>
    </span>
  );
}
