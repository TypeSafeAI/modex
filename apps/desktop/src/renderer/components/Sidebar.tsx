import { SecretInput } from "../streamer";
import { BrandMark } from "./BrandMark";
import { ActiveAgents, type ActiveAgent } from "./ActiveAgents";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AppState, PullRequestSummary, Thread, ThreadContext } from "../../shared/types";
import { bridge } from "../bridge";
import { Icon } from "./ui/Icon";
import { IconButton } from "./ui/IconButton";
import { Menu, MenuItem, MenuLabel } from "./ui/Menu";
import { createPortal } from "react-dom";
import { uiScale } from "../ui-scale";
import { ThreadDetails, useThreadDetails } from "./ThreadDetails";

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
  /** Puts a thread away (true) or brings it back (false). */
  onArchiveThread: (thread: Thread, archived: boolean) => void;
  onRemoveProject: (projectId: string) => void;
  /** Threads holding unsent composer text; their rows carry a small pen glyph. */
  unsent?: Record<string, string>;
  agents?: ActiveAgent[];
  /** Notes workspaces and the projects in each; with more than one, projects are grouped under them. */
  workspaces?: { id: string; name: string; order: number; isDefault: boolean; modexProjectIds: string[] }[];
  /** Opens the project's notes in Space. */
  onOpenNotes?: (projectId: string) => void;
  onMoveToWorkspace?: (projectId: string, workspaceId: string) => void;
  /** Makes a notes workspace with this name and moves the project into it. */
  onMoveToNewWorkspace?: (projectId: string, name: string) => void;
}

/** Threads shown per project before "Show more". */
export const THREADS_PER_PROJECT = 5;

export function Sidebar({ state, selected, onSelect, draftProjectId, onAddProject, onNewChat, onNewThread, onDeleteThread, onArchiveThread, onRemoveProject, unsent, agents = [], workspaces, onOpenNotes, onMoveToWorkspace, onMoveToNewWorkspace }: Props) {
  /** The project whose "Move to new workspace" name field is open, and what is typed in it. */
  const [naming, setNaming] = useState<{ projectId: string; value: string } | null>(null);
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState<Record<string, boolean>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [retiredOpen, setRetiredOpen] = useState<Record<string, boolean>>({});
  const [archivedOpen, setArchivedOpen] = useState<Record<string, boolean>>({});
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [activeOnly, setActiveOnly] = useState(false);
  // How the list is organized and ordered: this window's choice, kept in local storage.
  const [organize, setOrganize] = useState<"project" | "list">(() => stored("modex.sidebar.organize", ["project", "list"]));
  const [sortBy, setSortBy] = useState<"updated" | "created">(() => stored("modex.sidebar.sort", ["updated", "created"]));
  const [listMenu, setListMenu] = useState(false);
  const listMenuRef = useRef<HTMLButtonElement>(null);
  const choose = <T extends string>(key: string, set: (value: T) => void, value: T) => { set(value); try { localStorage.setItem(key, value); } catch { /* This session only. */ } };
  const byOrder = (a: Thread, b: Thread) => sortBy === "created" ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt);
  const q = query.trim().toLowerCase();

  const closeSearch = () => {
    setSearching(false);
    setQuery("");
  };

  const groups = state.projects.map((p) => {
    const mine = state.threads.filter((t) => t.projectId === p.id && (!activeOnly || t.status === "running" || t.status === "waiting"));
    const matchesQuery = (t: Thread) => !q || t.title.toLowerCase().includes(q);
    // Archived threads leave the working list on every device; they stay reachable below it.
    const archived = mine.filter((t) => t.archived && matchesQuery(t));
    const working = mine.filter((t) => !t.archived);
    // Finished tasks (PR merged, worktree removed) leave the working list; they stay reachable below it.
    const all = working.filter((t) => !t.retired);
    const retired = working.filter((t) => t.retired && matchesQuery(t));
    if (sortBy === "created") all.sort(byOrder);
    return { project: p, all, retired, archived, matches: q ? all.filter(matchesQuery) : all };
  });
  const noMatches = q && groups.every((g) => g.matches.length === 0 && g.retired.length === 0 && g.archived.length === 0);
  // A search or the active-only filter hides a project with nothing to show.
  const shown = (g: (typeof groups)[number]) => !((q || activeOnly) && g.matches.length === 0 && g.retired.length === 0 && g.archived.length === 0);
  // With one workspace the list stays as it always was; with several, each workspace heads its projects.
  const ordered = [...(workspaces ?? [])].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  const grouped = ordered.length > 1;
  const homeOf = (projectId: string) => ordered.find(w => w.modexProjectIds.includes(projectId)) ?? ordered.find(w => w.isDefault) ?? ordered[0];

  return (
    <aside className="sidebar" data-testid="sidebar">
      <header className="sidebar-head">
        <h1 className="sidebar-title" data-testid="sidebar-title"><BrandMark />Modex</h1>
        <span className="spacer" />
        <IconButton icon="bell" label="Show active chats" size="md" aria-pressed={activeOnly} onClick={() => setActiveOnly(value => !value)} />
        <IconButton icon="search" label="Search threads" size="md" data-testid="search-toggle" aria-pressed={searching} onClick={() => (searching ? closeSearch() : setSearching(true))} />
      </header>
      {searching && (
        <div className="sidebar-search">
          <Icon name="search" size={14} />
          <SecretInput
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
      <button className={`side-row active-chats${activeOnly ? " selected" : ""}`} aria-pressed={activeOnly} onClick={() => setActiveOnly(value => !value)}><span className="personal-dot" /><span>Active work</span></button>

      <ActiveAgents agents={agents} onSelect={onSelect} />
      <div className="section-label">
        <button className="projects-toggle" aria-expanded={projectsOpen} onClick={() => setProjectsOpen(value => !value)}>Projects<Icon name={projectsOpen ? "chevron-down" : "chevron-right"} size={12} /></button>
        <span className="spacer" />
        <span className="composer-menu">
          <IconButton ref={listMenuRef} icon="more" label="Organize and sort" data-testid="sidebar-organize" aria-haspopup="menu" aria-expanded={listMenu} onClick={() => setListMenu(value => !value)} />
          <Menu open={listMenu} onClose={() => setListMenu(false)} anchorRef={listMenuRef} label="Organize and sort" placement="bottom-start">
            <MenuLabel>Organize sidebar</MenuLabel>
            <MenuItem checkable selected={organize === "project"} onClick={() => { choose("modex.sidebar.organize", setOrganize, "project"); setListMenu(false); }}>By project</MenuItem>
            <MenuItem checkable selected={organize === "list"} data-testid="sidebar-one-list" onClick={() => { choose("modex.sidebar.organize", setOrganize, "list"); setListMenu(false); }}>In one list</MenuItem>
            <MenuLabel>Sort chats by</MenuLabel>
            <MenuItem checkable selected={sortBy === "updated"} onClick={() => { choose("modex.sidebar.sort", setSortBy, "updated"); setListMenu(false); }}>Last updated</MenuItem>
            <MenuItem checkable selected={sortBy === "created"} onClick={() => { choose("modex.sidebar.sort", setSortBy, "created"); setListMenu(false); }}>Date created</MenuItem>
          </Menu>
        </span>
        <IconButton icon="plus" label="Create project…" data-testid="add-project" onClick={onAddProject} />
      </div>
      {organize === "list" && projectsOpen && <nav className="projects one-list" aria-label="Chats" data-testid="sidebar-recents">
        <ul className="threads">
          {groups.flatMap(g => g.matches.map(t => ({ t, name: g.project.name }))).sort((a, b) => byOrder(a.t, b.t)).map(({ t, name }) => <ThreadRow key={t.id} thread={t} projectName={name} compact={state.settings.theme === "graphite"} selected={t.id === selected} unsent={Boolean(unsent?.[t.id])}
            onSelect={() => onSelect(t.id)} onDelete={() => onDeleteThread(t)} onArchive={() => onArchiveThread(t, true)} />)}
        </ul>
        {state.projects.length === 0 && <p className="side-hint">No projects</p>}
        {noMatches && <p className="side-hint" data-testid="search-empty">No threads match “{query.trim()}”.</p>}
      </nav>}
      <nav className="projects" aria-label="Projects" hidden={!projectsOpen || organize === "list"}>
        {activeOnly && groups.every(group => !group.matches.length) && <p className="side-hint">No active chats.</p>}
        {state.projects.length === 0 && <p className="side-hint">No projects yet. Open a folder to start a thread.</p>}
        {noMatches && <p className="side-hint" data-testid="search-empty">No threads match “{query.trim()}”.</p>}
        {(grouped ? ordered : [undefined]).map(workspace => {
          const members = groups.filter(group => !workspace || homeOf(group.project.id)?.id === workspace.id);
          // A workspace whose projects are all filtered out shows no empty header.
          if (workspace && !members.some(shown)) return null;
          const folded = workspace ? Boolean(workspaceCollapsed[workspace.id]) && !q : false;
          const projects = folded ? [] : members.map(renderProject);
          if (!workspace) return projects;
          return <section key={workspace.id} className="workspace-group" data-testid="workspace-group" aria-label={workspace.name}>
            <button className="side-row workspace-toggle" data-testid="workspace-toggle" aria-expanded={!folded} onClick={() => setWorkspaceCollapsed(c => ({ ...c, [workspace.id]: !c[workspace.id] }))}>
              <Icon name={folded ? "chevron-right" : "chevron-down"} size={12} className="side-row-icon" />
              <span className="side-row-label">{workspace.name}</span>
            </button>
            {projects}
          </section>;
        })}
      </nav>
    </aside>
  );

  function renderProject(group: (typeof groups)[number]) {
          if (!shown(group)) return null;
          const { project: p, all, retired, archived, matches } = group;
          const isCollapsed = !q && collapsed[p.id];
          const selectedIndex = matches.findIndex((t) => t.id === selected);
          const showAll = Boolean(q) || expanded[p.id] || selectedIndex >= THREADS_PER_PROJECT;
          const visible = showAll ? matches : matches.slice(0, THREADS_PER_PROJECT);
          const busy = all.some((t) => t.status === "running" || t.status === "waiting");
          return (
            <section key={p.id} className="project" data-testid="project" data-project-id={p.id}>
              <ProjectRowShell className={`side-row project-row${p.id === draftProjectId ? " selected" : ""}`} draft={p.id === draftProjectId} name={p.name} path={p.path} projectId={p.id} chats={all.length} compact={state.settings.theme === "graphite"}>
                <button className="project-toggle" data-testid="project-toggle" aria-expanded={!isCollapsed} onClick={() => setCollapsed((c) => ({ ...c, [p.id]: !c[p.id] }))}>
                  <Icon name="folder-open" className="side-row-icon" />
                  <span className="side-row-label" data-testid="project-name">{p.name}</span>
                </button>
                {isCollapsed && busy && <span className="row-status running" title="A thread in this project is working" />}
                <span className="row-actions">
                  <IconButton icon="branch" label="New chat in a git worktree" shortcut="⇧⌘N" reveal data-testid="project-new-worktree-thread" onClick={() => onNewThread(p.id, true)} />
                  <RowMenu label="Project actions" testId="project-menu">
                    <MenuItem data-testid="project-reveal" onClick={() => void bridge.invoke("shell:openPath", { path: p.path }).catch(() => {})}><Icon name="folder-open" />{bridge.platform === "darwin" ? "Reveal in Finder" : "Open folder"}</MenuItem>
                    {onOpenNotes && <MenuItem data-testid="project-notes" onClick={() => onOpenNotes(p.id)}><Icon name="page" />Open notes</MenuItem>}
                    {grouped && onMoveToWorkspace && ordered.filter(w => w.id !== homeOf(p.id)?.id).map(w => <MenuItem key={w.id} onClick={() => onMoveToWorkspace(p.id, w.id)}>Move to {w.name}</MenuItem>)}
                    {onMoveToNewWorkspace && <MenuItem data-testid="project-new-workspace" onClick={() => setNaming({ projectId: p.id, value: "" })}>Move to new workspace…</MenuItem>}
                    <MenuItem data-testid="project-remove" className="danger" onClick={() => onRemoveProject(p.id)}><Icon name="close" />Remove project</MenuItem>
                  </RowMenu>
                  <IconButton icon="compose" label="New chat" shortcut="⌘N" reveal data-testid="project-new-thread" onClick={() => onNewThread(p.id)} />
                </span>
              </ProjectRowShell>
              {naming?.projectId === p.id && (
                <div className="sidebar-search workspace-name">
                  <Icon name="grid" size={14} />
                  {/* Enter makes the workspace and moves the project; Escape or leaving the field makes nothing. */}
                  <SecretInput
                    autoFocus
                    aria-label="New workspace name"
                    placeholder="Workspace name"
                    value={naming.value}
                    spellCheck={false}
                    onChange={(e) => setNaming({ projectId: p.id, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const name = naming.value.trim();
                        setNaming(null);
                        if (name) onMoveToNewWorkspace?.(p.id, name);
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        setNaming(null);
                      }
                    }}
                    onBlur={() => setNaming(null)}
                  />
                </div>
              )}
              {!isCollapsed && (
                <ul className="threads">
                  {all.length === 0 && <li className="side-hint small">No threads</li>}
                  {visible.map((t) => <ThreadRow key={t.id} thread={t} projectName={p.name} compact={state.settings.theme === "graphite"} selected={t.id === selected} unsent={Boolean(unsent?.[t.id])}
                    onSelect={() => onSelect(t.id)} onDelete={() => onDeleteThread(t)} onArchive={() => onArchiveThread(t, true)} />)}
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
                    <ThreadRow key={t.id} thread={t} projectName={p.name} compact={state.settings.theme === "graphite"} selected={t.id === selected} unsent={Boolean(unsent?.[t.id])} onSelect={() => onSelect(t.id)} onDelete={() => onDeleteThread(t)} onArchive={() => onArchiveThread(t, true)} />
                  ))}
                  {archived.length > 0 && (
                    <li>
                      <button className="side-row show-more" data-testid="archived-toggle" aria-expanded={Boolean(q) || Boolean(archivedOpen[p.id]) || archived.some((t) => t.id === selected)} onClick={() => setArchivedOpen((x) => ({ ...x, [p.id]: !x[p.id] }))}>
                        <span className="side-row-label">Archived ({archived.length})</span>
                      </button>
                    </li>
                  )}
                  {(q || archivedOpen[p.id] || archived.some((t) => t.id === selected)) && archived.map((t) => (
                    <ThreadRow key={t.id} thread={t} projectName={p.name} compact={state.settings.theme === "graphite"} selected={t.id === selected} unsent={Boolean(unsent?.[t.id])} onSelect={() => onSelect(t.id)} onDelete={() => onDeleteThread(t)} onArchive={() => onArchiveThread(t, false)} />
                  ))}
                </ul>
              )}
            </section>
          );
  }
}

function stored<T extends string>(key: string, allowed: readonly T[]): T {
  try { const value = localStorage.getItem(key); if (value && (allowed as readonly string[]).includes(value)) return value as T; } catch { /* Blocked storage: the default. */ }
  return allowed[0]!;
}

/** A project's row, with a card beside it on hover: its name, how many chats, its branch and its folder. */
function ProjectRowShell({ className, draft, name, path, projectId, chats, compact, children }: { className: string; draft: boolean; name: string; path: string; projectId: string; chats: number; compact: boolean; children: ReactNode }) {
  const anchor = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const close = () => { clearTimeout(timer.current); setAt(null); };
  const leave = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setAt(null), 140); };
  const show = () => {
    if (!compact) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const bounds = anchor.current?.getBoundingClientRect();
      if (!bounds) return;
      const z = uiScale();
      setAt({ left: Math.max(8, Math.min(bounds.right / z + 3, innerWidth / z - 328)), top: Math.max(8, Math.min(bounds.top / z, innerHeight / z - 190)) });
      void bridge.invoke("project:branch", { projectId }).then(setBranch).catch(() => setBranch(null));
    }, 400);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const home = path.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  return <div ref={anchor} className={className} data-draft={draft ? "true" : undefined} onPointerEnter={show} onPointerLeave={leave} onPointerDown={close}>
    {children}
    {at && createPortal(<div className="thread-details project-details" role="tooltip" data-testid="project-card" style={at} onPointerEnter={() => clearTimeout(timer.current)} onPointerLeave={leave}>
      <div className="project-details-line strong"><Icon name="folder" size={15} /><span>{name}</span></div>
      <div className="project-details-line"><Icon name="comment" size={15} /><span>{chats} {chats === 1 ? "chat" : "chats"}</span></div>
      <hr />
      {branch && <div className="project-details-line"><Icon name="branch" size={15} /><span>{branch}</span></div>}
      <div className="project-details-line wrap"><Icon name="folder" size={15} /><span>{home}</span></div>
    </div>, document.body)}
  </div>;
}

function ThreadRow({ thread: t, projectName, compact, selected, unsent, onSelect, onDelete, onArchive }: {
  thread: Thread; projectName: string; compact: boolean; selected: boolean; unsent: boolean; onSelect: () => void; onDelete: () => void; onArchive: () => void;
}) {
  const card = useThreadDetails(compact);
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

  const provider = t.backend === "claude" ? "Claude Code" : t.backend === "codex" ? "Codex" : t.backend === "opencode" ? "OpenCode" : t.backend === "mimo" ? "MiMo Code" : "Mock";
  const model = t.model || "Default model";
  const pr = context?.pullRequest;
  const prLabel = t.retired ? `#${t.retired.pr} Merged` : pr ? pullRequestLabel(pr) : failed ? "PR unavailable" : "Loading…";
  const prTitle = pr && "number" in pr ? `${prLabel} · ${pr.title}` : pr && "detail" in pr ? pr.detail : "Reading checkout and pull request status";
  const branch = t.retired ? "Worktree removed" : context ? context.isRepo ? context.branch ?? "Detached HEAD" : "Local folder" : failed ? "Status unavailable" : "Checking branch…";
  return (
    <li ref={card.anchor} onPointerEnter={() => card.show()} onPointerLeave={card.leave} onFocus={event => { if (event.target.matches(":focus-visible")) card.show(true); }} onBlur={card.leave} onPointerDown={card.close} className={`side-row thread-row${selected ? " selected" : ""}`} data-testid="thread-row" data-thread-id={t.id} data-status={t.status} data-archived={t.archived ? "true" : undefined} aria-current={selected ? "true" : undefined}>
      <button className="thread-main" title={compact ? undefined : t.title} aria-label={t.title} aria-describedby={`thread-provider-${t.id}`} aria-controls={card.position ? card.id : undefined} aria-keyshortcuts={compact ? "ArrowRight" : undefined} onKeyDown={event => { if (compact && event.key === "ArrowRight") { event.preventDefault(); card.show(true, true); } }} onClick={onSelect}>
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
        {t.archived && <span className="row-glyph" data-testid="thread-row-archived" title="Archived"><Icon name="archive" size={14} /></span>}
        {t.worktree && <span className="row-glyph" data-testid="thread-row-worktree" title={`Worktree · ${t.worktree.branch}`}><Icon name="branch" size={14} /></span>}
      </span>
      <span className="row-actions">
        <RowMenu label="Thread actions" testId="thread-menu">
          <MenuItem data-testid="thread-archive" disabled={!t.archived && (t.status === "running" || t.status === "waiting")} onClick={onArchive}>{t.archived ? "Unarchive" : "Archive"}</MenuItem>
          <MenuItem data-testid="thread-delete" className="danger" onClick={onDelete}>Delete thread</MenuItem>
        </RowMenu>
      </span>
      <ThreadDetails card={card} title={t.title} project={projectName} updatedAt={t.updatedAt}>
        <span>{t.auto ? "Auto · " : ""}{provider} · {model}</span><span>{branch}</span>
        {t.retired ? <a href={t.retired.url} target="_blank" rel="noreferrer">{prLabel}</a> : pr && "url" in pr ? <a href={pr.url} target="_blank" rel="noreferrer">{prLabel}</a> : <span>{prLabel}</span>}
      </ThreadDetails>
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
