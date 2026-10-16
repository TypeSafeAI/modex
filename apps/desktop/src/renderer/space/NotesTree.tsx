import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { NotesNode, NotesTree } from "../../shared/notes";
import { pageTitle, type SpacePage } from "../../shared/space";
import { SecretInput } from "../streamer";
import { Icon } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../components/ui/Menu";
import { bridge } from "../bridge";
import { indexTree, type NotesTreeIndex } from "./tree-index";

/** What the tree is asking its owner to do. Each returns when done; a thrown error is shown by the owner. */
export interface NotesTreeActions {
  openPage(id: string): void;
  createPage(containerId: string): Promise<void>;
  createFolder(parentId: string, name: string): Promise<void>;
  createProject(workspaceId: string, name: string): Promise<void>;
  createWorkspace(name: string): Promise<void>;
  rename(id: string, name: string): Promise<void>;
  move(id: string, targetId: string): Promise<void>;
  remove(id: string): Promise<void>;
  reveal(id: string): Promise<void>;
  openFile(id: string): Promise<void>;
  /** Shows a file's preview. */
  previewFile(id: string): void;
  /** Copies files into a project or folder; without paths, a picker opens. */
  importFiles(containerId: string, paths?: string[]): Promise<void>;
}

/**
 * The owner's actions as one object that lasts, each calling the owner's latest. Space re-renders on every
 * keystroke in a page; new functions each time would make the tree rebuild all its rows.
 */
export function useTreeActions(actions: NotesTreeActions): NotesTreeActions {
  const latest = useRef(actions);
  latest.current = actions;
  return useMemo<NotesTreeActions>(() => ({
    openPage: id => latest.current.openPage(id),
    createPage: containerId => latest.current.createPage(containerId),
    createFolder: (parentId, name) => latest.current.createFolder(parentId, name),
    createProject: (workspaceId, name) => latest.current.createProject(workspaceId, name),
    createWorkspace: name => latest.current.createWorkspace(name),
    rename: (id, name) => latest.current.rename(id, name),
    move: (id, targetId) => latest.current.move(id, targetId),
    remove: id => latest.current.remove(id),
    reveal: id => latest.current.reveal(id),
    openFile: id => latest.current.openFile(id),
    previewFile: id => latest.current.previewFile(id),
    importFiles: (containerId, paths) => latest.current.importFiles(containerId, paths),
  }), []);
}

type Editing = { kind: "rename" | "folder" | "project"; id: string; value: string } | { kind: "workspace"; id: null; value: string };

/**
 * The notes folder as Workspace › Project › Folder › notes and files. A note opens its page; a folder
 * with a folder note opens that page; a file opens in its default app. Names are edited in place.
 */
export function NotesTreeView({ tree, pages, selected, actions, newWorkspace, focus, onFocusApplied }: { tree: NotesTree; pages: SpacePage[]; selected: string | null; actions: NotesTreeActions; newWorkspace: number; focus?: { id: string }; onFocusApplied: (request: { id: string }) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** The row being dragged within the tree, to move it. */
  const [dragging, setDragging] = useState<NotesNode | null>(null);
  useEffect(() => { if (newWorkspace) setEditing({ kind: "workspace", id: null, value: "" }); }, [newWorkspace]);
  // A node asked for from elsewhere (a project's notes): open its ancestors and bring it into view,
  // once per request, so the tree's later polls do not pull the view back to it.
  const focused = useRef<{ id: string } | undefined>(undefined);
  useEffect(() => {
    if (!focus || focused.current === focus) return;
    let node = tree.nodes.find(n => n.id === focus.id);
    if (!node) return;
    focused.current = focus;
    const chain = new Set<string>();
    while (node?.parentId) { chain.add(node.parentId); node = tree.nodes.find(n => n.id === node!.parentId); }
    setCollapsed(current => new Set([...current].filter(id => !chain.has(id) && id !== focus.id)));
    requestAnimationFrame(() => document.querySelector(`[data-node-id="${CSS.escape(focus.id)}"]`)?.scrollIntoView({ block: "nearest" }));
    onFocusApplied(focus);
  }, [focus, tree, onFocusApplied]);
  const index = useMemo(() => indexTree(tree), [tree]);
  // Space re-renders on every keystroke in a page, with new page objects. The tree shows only their titles,
  // so it keeps its rows (below) until a title changes.
  const titleList = JSON.stringify(pages.map(page => [page.id, pageTitle(page)]));
  const titles = useMemo(() => new Map<string, string>(JSON.parse(titleList)), [titleList]);
  const nameOf = (node: NotesNode) => node.kind === "note" ? titles.get(node.id) ?? pageTitle({ title: node.name }) : node.name;
  /** Where the dragged row may be dropped, found once per drag rather than on every dragover. */
  const dropTargets = useMemo(() => new Set(dragging ? index.targetsFor(dragging).map(target => target.id) : []), [index, dragging]);
  const commit = async () => {
    if (!editing) return;
    const value = editing.value.trim();
    const current = editing;
    setEditing(null);
    if (!value) return;
    if (current.kind === "workspace") await actions.createWorkspace(value);
    else if (current.kind === "project") await actions.createProject(current.id, value);
    else if (current.kind === "folder") await actions.createFolder(current.id, value);
    else await actions.rename(current.id, value);
  };
  const field = (label: string) => editing && <SecretInput autoFocus className="space-tree-edit" aria-label={label} value={editing.value}
    onChange={event => setEditing({ ...editing, value: event.target.value })}
    onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void commit(); } else if (event.key === "Escape") setEditing(null); }}
    onBlur={() => void commit()} />;
  const toggle = (id: string) => setCollapsed(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const startCreate = (kind: "folder" | "project", id: string) => {
    setCollapsed(current => { const next = new Set(current); next.delete(id); return next; });
    setEditing({ kind, id, value: "" });
  };

  const row = (node: NotesNode): ReactNode => {
    const name = nameOf(node);
    const kids = index.children(node.id);
    const open = !collapsed.has(node.id);
    const folderNote = node.kind === "folder" ? node.noteId : null;
    const current = (node.kind === "note" && selected === node.id) || (folderNote !== null && selected === folderNote);
    const icon = node.kind === "workspace" ? "grid" : node.kind === "project" ? "folder" : node.kind === "folder" ? (open ? "folder-open" : "folder") : node.kind === "file" ? "file" : "page";
    const activate = () => {
      if (node.kind === "note") actions.openPage(node.id);
      else if (folderNote) actions.openPage(folderNote);
      else if (node.kind === "file") actions.previewFile(node.id);
      else toggle(node.id);
    };
    const renaming = editing?.kind === "rename" && editing.id === node.id;
    const container = node.kind === "project" || node.kind === "folder";
    // A row dragged onto a place it may go moves there; files dragged in from Finder onto a project
    // or folder are copied into it.
    const accepts = (event: React.DragEvent) => dragging ? dragging.id !== node.id && dropTargets.has(node.id) : container && event.dataTransfer.types.includes("Files");
    const drop = {
      onDragOver: (event: React.DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault(); event.stopPropagation();
        event.dataTransfer.dropEffect = dragging ? "move" : "copy";
        setDropTarget(node.id);
      },
      onDragLeave: () => setDropTarget(current => current === node.id ? null : current),
      onDrop: (event: React.DragEvent) => {
        if (!accepts(event)) return;
        event.preventDefault(); event.stopPropagation(); setDropTarget(null);
        if (dragging) { const moved = dragging; setDragging(null); void actions.move(moved.id, node.id); return; }
        const paths = [...event.dataTransfer.files].map(file => { try { return bridge.pathForFile?.(file) ?? ""; } catch { return ""; } }).filter(Boolean);
        if (paths.length) void actions.importFiles(node.id, paths);
      },
    };
    const drag = node.kind === "workspace" || renaming ? {} : {
      draggable: true,
      onDragStart: (event: React.DragEvent) => { event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", name); setDragging(node); },
      onDragEnd: () => { setDragging(null); setDropTarget(null); },
    };
    return <li key={node.id} data-kind={node.kind} data-node-id={node.id}>
      <div className={`space-tree-row${current || focus?.id === node.id || dropTarget === node.id ? " selected" : ""}`} {...drop}>
        {kids.length > 0 && <button className="space-tree-toggle" aria-label={`${open ? "Collapse" : "Expand"} ${name}`} aria-expanded={open} onClick={() => toggle(node.id)}><Icon name={open ? "chevron-down" : "chevron-right"} size={12} /></button>}
        {renaming ? field(`Rename ${name}`) : <button className="space-tree-page" data-testid={`notes-${node.kind}`} aria-label={node.kind === "note" || folderNote || node.kind === "file" ? `Open ${name}` : name} aria-expanded={node.kind === "note" || folderNote || node.kind === "file" ? undefined : open} aria-current={current ? "page" : undefined} onClick={activate} {...drag}>
          <Icon name={icon} size={15} /><span>{name}</span>
        </button>}
        <NodeMenu label={`${name} actions`}>{() => {
          const targets = node.kind === "workspace" ? [] : index.targetsFor(node);
          return <>
            {(node.kind === "project" || node.kind === "folder") && <>
              <MenuItem onClick={() => void actions.createPage(node.id)}><Icon name="plus" />New page</MenuItem>
              <MenuItem onClick={() => startCreate("folder", node.id)}><Icon name="folder" />New folder</MenuItem>
              <MenuItem onClick={() => void actions.importFiles(node.id)}><Icon name="download" />Import files…</MenuItem>
            </>}
            {node.kind === "workspace" && <MenuItem onClick={() => startCreate("project", node.id)}><Icon name="folder" />New project</MenuItem>}
            {node.kind === "file" && <MenuItem onClick={() => void actions.openFile(node.id)}><Icon name="expand" />Open</MenuItem>}
            {node.kind !== "note" && <MenuItem onClick={() => setEditing({ kind: "rename", id: node.id, value: name })}><Icon name="compose" />Rename</MenuItem>}
            {targets.length > 0 && <>
              <MenuSeparator />
              <MenuLabel>Move to</MenuLabel>
              {targets.map(target => <MenuItem key={target.id} onClick={() => void actions.move(node.id, target.id)}>{pathName(index, target, nameOf)}</MenuItem>)}
            </>}
            <MenuSeparator />
            <MenuItem onClick={() => void actions.reveal(node.id)}><Icon name="folder-open" />Reveal in Finder</MenuItem>
            {(node.kind === "workspace" || node.kind === "project" || node.kind === "folder") && kids.length === 0 && !(node.kind === "workspace" && node.isDefault) &&
              <MenuItem className="danger" onClick={() => void actions.remove(node.id)}><Icon name="trash" />Delete {node.kind}</MenuItem>}
          </>;
        }}</NodeMenu>
      </div>
      {(kids.length > 0 || (editing && editing.kind !== "rename" && editing.kind !== "workspace" && editing.id === node.id)) && open && <ul>
        {editing && editing.kind !== "rename" && editing.kind !== "workspace" && editing.id === node.id && <li className="space-tree-row">{field(editing.kind === "project" ? "New project name" : "New folder name")}</li>}
        {kids.map(row)}
      </ul>}
    </li>;
  };

  // Rebuilt only when something a row shows changes; otherwise React keeps every row as it is.
  const rows = useMemo(() => index.children(null).map(row), [index, titles, selected, actions, focus, collapsed, editing, dropTarget, dragging]);
  return <ul className="notes-tree" aria-label="Workspaces">
    {rows}
    {editing?.kind === "workspace" && <li className="space-tree-row">{field("New workspace name")}</li>}
    {tree.truncated && <li className="space-tree-empty">Showing the first 10,000 items.</li>}
  </ul>;
}

/** "Workspace › Project › Folder" for a move target. */
function pathName(index: NotesTreeIndex, node: NotesNode, nameOf: (node: NotesNode) => string): string {
  const parts: string[] = [];
  let current: NotesNode | undefined = node;
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) { seen.add(current.id); parts.unshift(nameOf(current)); current = current.parentId === null ? undefined : index.get(current.parentId); }
  return parts.join(" › ");
}

/** A row's actions. Its items are built only while it is open: a Move to list names every place the row can go. */
function NodeMenu({ label, children }: { label: string; children: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return <span className="space-tree-menu" onClick={event => event.stopPropagation()}>
    <IconButton ref={trigger} icon="more" label={label} size="sm" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(value => !value)} />
    <Menu open={open} onClose={() => setOpen(false)} anchorRef={trigger} label={label} placement="bottom-end" fitViewport>
      {open && <span className="menu-close-on-select" onClick={() => setOpen(false)}>{children()}</span>}
    </Menu>
  </span>;
}
