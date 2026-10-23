import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { prKeyId, sameKey, sameRevision, type PrFile, type PrOverview, type ReadResult, type PrFiles } from "../../shared/code-review.js";
import { bridge } from "../bridge";
import { Diff, FileIcon } from "../components/Diff";
import { PanelResizeHandle } from "../components/PanelResizeHandle";
import { SPLIT } from "./navigation.js";
import { Reader } from "./reader.js";
import { prUrl } from "./model.js";
import { anchorFor, anchorState, parsePatch, hunkBounds, type LineAnchor, type PatchRow } from "./patch.js";
import { unavailableText } from "./text.js";

let sessionSequence = 0;
export interface ChangesView { pages: ReadResult<PrFiles>[]; selected: string | null; expanded: string[]; filter: string; wrap: boolean; highlight: boolean }
/** Private window memory, owned and cleared by the account-aware host; at most two revisions. */
export type ChangesViews = Map<string, ChangesView>;
const DISPLAY = { files: 1000, open: 4, context: 200, chunk: 40 } as const;
interface Props {
  overview: PrOverview;
  views: ChangesViews;
  stale: boolean;
  bodyRef: RefObject<HTMLDivElement | null>;
  treeRef: RefObject<HTMLElement | null>;
  treeWidth: number | null;
  changesWidth: number;
  filesShown: boolean;
  onSelect: () => void;
  onTreeResize: (width: number) => void;
  onTreeReset: () => void;
}

/** The selected anchor survives a head refresh, but is never reinterpreted on that head. */
export function PrChanges(props: Props) {
  const [anchor, setAnchor] = useState<LineAnchor | null>(null);
  const { overview } = props;
  return <>
    {anchor && sameKey(anchor.key, overview.key) && <p className="cr-anchor" role="status">{anchorState(anchor, overview.key, overview.revision) === "outdated" ? "Outdated line anchor" : "Line anchor"}: <bdi dir="ltr">{anchor.path}</bdi> · {anchor.side} {anchor.start} · {anchor.revision.headSha.slice(0, 8)}</p>}
    <ChangesSession key={`${prKeyId(overview.key)}/${overview.revision.baseSha}/${overview.revision.headSha}/${overview.revision.baseRef}`} {...props} onAnchor={setAnchor} />
  </>;
}

function ChangesSession({ overview, views, stale, bodyRef, treeRef, treeWidth, changesWidth, filesShown, onSelect, onTreeResize, onTreeReset, onAnchor }: Props & { onAnchor: (anchor: LineAnchor) => void }) {
  const reader = useMemo(() => new Reader(request => bridge.invoke("code-review:read", request), undefined, `diff-${++sessionSequence}`), []);
  const viewId = `${prKeyId(overview.key)}/${overview.revision.baseSha}/${overview.revision.headSha}/${overview.revision.baseRef}`;
  const saved = views.get(viewId);
  const [pages, setPages] = useState<ReadResult<PrFiles>[]>(saved?.pages ?? []);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(saved?.selected ?? null);
  const [expanded, setExpanded] = useState<string[]>(saved?.expanded ?? []);
  const [filter, setFilter] = useState(saved?.filter ?? "");
  const [wrap, setWrap] = useState(saved?.wrap ?? true);
  const [highlight, setHighlight] = useState(saved?.highlight ?? true);
  const sections = useRef(new Map<string, HTMLElement>());
  const alive = useRef(true);
  const last = pages.at(-1);
  const lastData = [...pages].reverse().find(p => p.state !== "unavailable");
  const requestedCursor = useRef<string | null>(null);
  const files = useMemo(() => {
    const byPath = new Map<string, PrFile>();
    for (const page of pages) if (page.state !== "unavailable" && sameRevision(page.value.revision, overview.revision)) for (const file of page.value.files) byPath.set(file.path, file);
    return [...byPath.values()].slice(0, DISPLAY.files);
  }, [pages, overview.revision]);
  const load = async (cursor: string | null, replace = false) => {
    requestedCursor.current = cursor;
    setBusy(true);
    const outcome = await reader.read("files", { op: "files", key: overview.key, revision: overview.revision, cursor }, overview.key.account);
    if (!alive.current || outcome.status === "superseded") return;
    const result: ReadResult<PrFiles> = outcome.status === "mismatch" || (outcome.status === "applied" && outcome.result.state !== "unavailable" && !sameRevision(outcome.result.value.revision, overview.revision))
      ? { state: "unavailable", reason: "head-changed", fetchedAt: new Date().toISOString() } : outcome.result;
    setPages(p => replace ? [result] : [...p.filter(page => page.state !== "unavailable"), result]);
    if (replace && result.state !== "unavailable") {
      setExpanded(result.value.files.slice(0, DISPLAY.open).map(f => f.path));
      setSelected(result.value.files[0]?.path ?? null);
    }
    setBusy(false);
  };
  useEffect(() => {
    alive.current = true;
    if (!saved?.pages.length) void load(null, true);
    return () => { alive.current = false; reader.cancelAll(); };
  }, []);
  useEffect(() => {
    views.delete(viewId);
    views.set(viewId, { pages, selected, expanded, filter, wrap, highlight });
    while (views.size > 2) views.delete(views.keys().next().value!);
  }, [views, viewId, pages, selected, expanded, filter, wrap, highlight]);
  const open = (path: string) => setExpanded(paths => paths.includes(path) ? paths : [...paths.slice(-(DISPLAY.open - 1)), path]);
  const select = (path: string) => {
    setSelected(path); open(path); onSelect();
    requestAnimationFrame(() => {
      const el = sections.current.get(path), scroller = bodyRef.current;
      if (el && scroller) { scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top; el.focus({ preventScroll: true }); }
    });
  };
  const total = last && last.state !== "unavailable" ? last.coverage?.total ?? overview.totals.files : overview.totals.files;
  const next = lastData ? lastData.coverage?.next ?? null : null;
  const incomplete = pages.some(p => p.state !== "ready") || !!next || files.length < total;
  const matching = files.filter(f => `${f.path}\n${f.previousPath ?? ""}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <div className="cr-changes-body" data-tree={treeWidth === null ? (filesShown ? "only" : "folded") : "beside"}>
    <div ref={bodyRef} className="cr-diff" data-testid="code-review-diff" tabIndex={-1}>
      <div className="cr-diff-toolbar">
        <button type="button" disabled={busy} onClick={() => void load(null, true)}>Refresh files</button>
        <span>{files.length} of {total} files loaded{incomplete ? " · Incomplete coverage" : ""}</span>
        <label><input type="checkbox" checked={wrap} onChange={e => setWrap(e.target.checked)} />Wrap lines</label>
        <label><input type="checkbox" checked={highlight} onChange={e => setHighlight(e.target.checked)} />Highlight changes</label>
      </div>
      <p className="cr-revision">Base {overview.revision.baseSha.slice(0, 8)} → head {overview.revision.headSha.slice(0, 8)}{stale ? " · Overview read earlier" : ""}</p>
      {pages.some(p => p.state === "stale") && <p role="status">Files read earlier. Anchors refer only to the revision shown.</p>}
      {last?.state === "unavailable" && <p role="alert">{unavailableText(last)} <button onClick={() => void load(requestedCursor.current, files.length === 0)}>Retry files</button></p>}
      {!files.length && !busy && last?.state === "ready" && <p>No changed files in this read.</p>}
      {files.map(file => <section key={file.path} ref={el => { if (el) sections.current.set(file.path, el); else sections.current.delete(file.path); }} tabIndex={-1} className="cr-file-section" data-testid="cr-file-section" data-path={file.path} data-base-sha={overview.revision.baseSha} data-head-sha={overview.revision.headSha} data-old-path={file.previousPath ?? file.path}>
        <header className="cr-file-heading">
          <button type="button" aria-label={`${expanded.includes(file.path) ? "Collapse" : "Expand"} ${file.path}`} aria-expanded={expanded.includes(file.path)} onClick={() => expanded.includes(file.path) ? setExpanded(paths => paths.filter(p => p !== file.path)) : open(file.path)}>
            <span aria-hidden="true">{expanded.includes(file.path) ? "▾" : "▸"}</span><FileIcon path={file.path} /><bdi dir="ltr" title={file.path}>{file.path}</bdi>
          </button>
          <span className="stat add" aria-label={`${file.additions} additions`}>+{file.additions}</span><span className="stat del" aria-label={`${file.deletions} deletions`}>−{file.deletions}</span>
          <details className="cr-file-menu"><summary aria-label={`File options for ${file.path}`}>⋯</summary><div><button onClick={() => void bridge.invoke("clipboard:write", { text: file.path })}>Copy path</button>{prUrl(overview.locator) && <a href={`${prUrl(overview.locator)}/files`} target="_blank" rel="noreferrer">Open in GitHub</a>}</div></details>
        </header>
        {file.previousPath && <p className="cr-previous">Renamed from <bdi dir="ltr">{file.previousPath}</bdi></p>}
        {expanded.includes(file.path) && <FilePatch key={file.path} file={file} overview={overview} reader={reader} wrap={wrap} highlight={highlight} onAnchor={onAnchor} />}
      </section>)}
      {busy && <p role="status">Loading remote files… <button onClick={() => { reader.cancel("files"); setBusy(false); }}>Cancel</button></p>}
      {!busy && next && files.length < DISPLAY.files && <button onClick={() => void load(next)}>Load next 100 files</button>}
      {files.length >= DISPLAY.files && (next || files.length < total) && <p>Display limited to {DISPLAY.files} files. <a href={`${prUrl(overview.locator)}/files`} target="_blank" rel="noreferrer">Open remaining files in GitHub</a></p>}
      <p className="cr-hint">Text patches may be incomplete. Each open file reports its patch coverage. Up to {DISPLAY.open} file bodies are open at once.</p>
    </div>
    {treeWidth !== null && <PanelResizeHandle side="workspace" className="cr-tree-resizer" label="Resize the file tree" width={treeWidth} min={SPLIT.treeMin} max={Math.max(SPLIT.treeMin, changesWidth - 1 - SPLIT.diffMin)} onResize={onTreeResize} onReset={onTreeReset} />}
    <nav ref={treeRef} className="cr-tree" aria-label="Changed files" data-testid="code-review-tree">
      <label className="cr-file-filter">Filter files<input aria-label="Filter remote files" placeholder="Filter files…" value={filter} onChange={e => setFilter(e.target.value)} /></label>
      <p className="cr-hint">{matching.length} matching · {files.length} loaded</p>
      <FileTree files={matching} selected={selected} onSelect={select} />
      {!matching.length && <p className="cr-hint">{files.length ? "No matching files." : "No files loaded yet."}</p>}
    </nav>
  </div>;
}

interface TreeNode { folders: Map<string, TreeNode>; files: PrFile[] }
function FileTree({ files, selected, onSelect }: { files: PrFile[]; selected: string | null; onSelect: (path: string) => void }) {
  const root: TreeNode = { folders: new Map(), files: [] };
  for (const file of files) {
    let node = root;
    for (const part of file.path.split("/").slice(0, -1)) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part)!;
    }
    node.files.push(file);
  }
  const render = (node: TreeNode, prefix = "") => <>
    {[...node.folders].map(([folder, child]) => <details key={folder} open className="cr-folder"><summary><bdi dir="ltr">{folder}</bdi></summary><div>{render(child, `${prefix}${folder}/`)}</div></details>)}
    {node.files.map(file => <button type="button" key={file.path} data-testid="cr-tree-file" className="cr-tree-file" title={file.path} aria-label={`View remote diff for ${file.path}`} aria-current={selected === file.path ? "true" : undefined} onClick={() => onSelect(file.path)}>
      <FileIcon path={file.path} /><bdi dir="ltr">{file.path.slice(prefix.length)}</bdi><span className="stat add">+{file.additions}</span><span className="stat del">−{file.deletions}</span>
    </button>)}
  </>;
  return <div onKeyDown={event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-testid="cr-tree-file"]')].filter(el => el.checkVisibility());
    const i = buttons.indexOf(event.target as HTMLButtonElement);
    if (i < 0) return;
    event.preventDefault();
    buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  }}>{render(root)}</div>;
}

function FilePatch({ file, overview, reader, wrap, highlight, onAnchor }: { file: PrFile; overview: PrOverview; reader: Reader; wrap: boolean; highlight: boolean; onAnchor: (anchor: LineAnchor) => void }) {
  const model = useMemo(() => parsePatch(file), [file]);
  const [contextUsed, setContextUsed] = useState(0);
  const reserved = useRef(0);
  const reserve = (n: number) => { if (reserved.current + n > DISPLAY.context) return false; reserved.current += n; setContextUsed(reserved.current); return true; };
  const release = (n: number) => { reserved.current -= n; setContextUsed(reserved.current); };
  const line = (side: "base" | "head", number: number) => { const anchor = anchorFor(overview.key, overview.revision, file, side, number); if (anchor) onAnchor(anchor); };
  if (model.state !== "text") return <p className="cr-patch-notice">{model.state === "binary" ? "Binary file · no textual patch" : model.state === "provider" ? "Patch omitted by provider · code unavailable" : "Patch exceeds display limit · code unavailable"}</p>;
  return <div className="cr-patch" onKeyDown={event => {
    if (!(event.target instanceof HTMLButtonElement) || !event.target.classList.contains("line-number")) return;
    if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".line-number:not(:disabled)")];
    const i = buttons.indexOf(event.target);
    event.preventDefault();
    buttons[event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, i + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1)))]?.focus();
  }}>
    <span className="sr-only">Line anchors: use arrow keys to move between gutters, Enter to select a line.</span>
    {!model.complete && <p className="cr-patch-notice" role="status">Incomplete patch · displayed lines do not cover the provider's change counts. Context expansion unavailable.</p>}
    {model.complete && !model.hunks.length && <p className="cr-patch-notice">No textual changes · empty file or metadata-only change.</p>}
    {model.hunks.map((hunk, i) => {
      const previous = model.hunks[i - 1];
      const oldStart = previous ? hunkBounds(previous).oldEnd : 1;
      const newStart = previous ? hunkBounds(previous).newEnd : 1;
      const bounds = hunkBounds(hunk);
      const gap = Math.min(bounds.oldStart - oldStart, bounds.newStart - newStart);
      return <div key={i}>
        {model.complete && gap > 0 && <ContextFold file={file} overview={overview} reader={reader} oldStart={oldStart} newStart={newStart} count={gap} wrap={wrap} highlight={highlight} onLine={line} budget={DISPLAY.context - contextUsed} reserve={reserve} release={release} />}
        <Diff rows={hunk.rows} tabbable={i === 0} wrap={wrap} highlight={highlight} onLine={line} />
      </div>;
    })}
    {model.complete && model.hunks.length > 0 && file.status !== "added" && file.status !== "removed" && <ContextFold file={file} overview={overview} reader={reader} oldStart={hunkBounds(model.hunks.at(-1)!).oldEnd} newStart={hunkBounds(model.hunks.at(-1)!).newEnd} count={null} wrap={wrap} highlight={highlight} onLine={line} budget={DISPLAY.context - contextUsed} reserve={reserve} release={release} />}
  </div>;
}

function ContextFold({ file, overview, reader, oldStart, newStart, count, wrap, highlight, onLine, budget, reserve, release }: { file: PrFile; overview: PrOverview; reader: Reader; oldStart: number; newStart: number; count: number | null; wrap: boolean; highlight: boolean; onLine: (side: "base" | "head", line: number) => void; budget: number; reserve: (n: number) => boolean; release: (n: number) => void }) {
  const [rows, setRows] = useState<PatchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const live = useRef(true);
  const slot = `context:${file.path}:${newStart}`;
  const pendingSize = useRef(0);
  const refund = () => { if (pendingSize.current) { release(pendingSize.current); pendingSize.current = 0; } };
  useEffect(() => { live.current = true; return () => { live.current = false; reader.cancel(slot); }; }, [reader, slot]);
  const expand = async () => {
    const start = newStart + rows.length;
    const length = Math.min(DISPLAY.chunk, budget, count === null ? DISPLAY.chunk : count - rows.length);
    if (length <= 0 || !reserve(length)) return;
    pendingSize.current = length;
    setBusy(true); setError(null);
    const outcome = await reader.read(slot, { op: "context", key: overview.key, revision: overview.revision, side: "head", path: file.path, start, end: start + length - 1 }, overview.key.account);
    if (!live.current || outcome.status === "superseded") return;
    setBusy(false);
    if (outcome.status !== "applied") { refund(); setError("Context reply did not match the selected revision."); return; }
    const result = outcome.result;
    if (result.state !== "ready") { refund(); setError(result.state === "unavailable" ? unavailableText(result) : "Context is stale or incomplete; retry for this revision."); return; }
    const value = result.value;
    if (!sameRevision(value.revision, overview.revision) || value.path !== file.path || value.side !== "head" || value.start !== start || value.lines.length > length) { refund(); setError("Context reply did not match the requested file and lines."); return; }
    setRows(current => [...current, ...value.lines.map((text, i): PatchRow => ({ kind: "context", text, oldLine: oldStart + rows.length + i, newLine: start + i, noNewline: false }))]);
    release(length - value.lines.length); pendingSize.current = 0;
    setEnded(value.lines.length < length || (value.total !== null && start + value.lines.length > value.total));
  };
  const remaining = count === null ? null : count - rows.length;
  return <div className="cr-context-fold">
    {rows.length > 0 && <Diff rows={rows} wrap={wrap} highlight={highlight} onLine={onLine} />}
    {error && <p role="alert">{error}</p>}
    {busy ? <button onClick={() => { reader.cancel(slot); refund(); setBusy(false); }}>Cancel context</button> : !ended && remaining !== 0 && <button className="diff-fold" disabled={budget <= 0} onClick={() => void expand()}>{error ? "Retry context" : budget <= 0 ? "Context display limit reached" : `Expand ${Math.min(DISPLAY.chunk, budget, remaining ?? DISPLAY.chunk)} unchanged lines${remaining === null ? " · More unchanged context may be available" : ` (${remaining} folded)`}`}</button>}
  </div>;
}
