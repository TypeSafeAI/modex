import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { prKeyId, sameKey, sameRevision, type PrFile, type PrOverview, type ReadResult, type PrFiles } from "../../shared/code-review.js";
import { bridge } from "../bridge";
import { Diff, FileIcon } from "../components/Diff";
import { PanelResizeHandle } from "../components/PanelResizeHandle";
import { SPLIT } from "./navigation.js";
import { FILE_LIMITS, filePageRows, pageStopReason, retainFilePage, type FilePage } from "./file-pages.js";
import { Reader } from "./reader.js";
import { prUrl } from "./model.js";
import { anchorFor, anchorState, parsePatch, hunkBounds, contextWindow, type LineAnchor, type PatchRow } from "./patch.js";
import { unavailableText } from "./text.js";
import { highlightRows, REMOTE_TEXT_LIMITS } from "./remote-highlight.js";

let sessionSequence = 0;
export interface ChangesView { pages: FilePage[]; selected: string | null; expanded: string[]; filter: string; wrap: boolean; highlight: boolean }
/** Private window memory, owned and cleared by the account-aware host; at most two revisions. */
export type ChangesViews = Map<string, ChangesView>;
const DISPLAY = { files: FILE_LIMITS.files, open: 4, context: 200, chunk: 40 } as const;
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
  const [pages, setPages] = useState<FilePage[]>(saved?.pages ?? []);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(saved?.selected ?? null);
  const [expanded, setExpanded] = useState<string[]>(saved?.expanded ?? []);
  const [filter, setFilter] = useState(saved?.filter ?? "");
  const [wrap, setWrap] = useState(saved?.wrap ?? true);
  const [highlight, setHighlight] = useState(saved?.highlight ?? true);
  const sections = useRef(new Map<string, HTMLElement>());
  const alive = useRef(true);
  const lastPage = pages.at(-1);
  const last = lastPage?.result;
  const lastData = [...pages].reverse().find(p => p.result.state !== "unavailable")?.result;
  const files = useMemo(() => filePageRows(pages), [pages]);
  const stopped = pageStopReason(pages);
  const load = async (cursor: string | null, replace = false) => {
    if (!replace && cursor !== null && stopped && !pages.some(p => p.cursor === cursor)) return;
    setBusy(true);
    const outcome = await reader.read("files", { op: "files", key: overview.key, revision: overview.revision, cursor }, overview.key.account);
    if (!alive.current || outcome.status === "superseded") return;
    const result: ReadResult<PrFiles> = outcome.status === "mismatch" || (outcome.status === "applied" && outcome.result.state !== "unavailable" && !sameRevision(outcome.result.value.revision, overview.revision))
      ? { state: "unavailable", reason: "head-changed", fetchedAt: new Date().toISOString() } : outcome.result;
    setPages(p => retainFilePage(p, cursor, result, replace));
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
  const total = lastData && lastData.state !== "unavailable" ? lastData.coverage?.total ?? overview.totals.files : overview.totals.files;
  const next = lastData && lastData.state !== "unavailable" ? lastData.coverage?.next ?? null : null;
  const incomplete = pages.some(p => p.result.state !== "ready") || !!next || files.length < total || (lastData && lastData.state !== "unavailable" && lastData.coverage?.complete === false);
  const missing = files.filter(f => f.patch.kind === "omitted" && f.patch.reason !== "binary").length;
  const matching = files.filter(f => `${f.path}\n${f.previousPath ?? ""}`.toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  return <div className="cr-changes-body" data-tree={treeWidth === null ? (filesShown ? "only" : "folded") : "beside"}>
    <div ref={bodyRef} className="cr-diff" data-testid="code-review-diff" tabIndex={-1}>
      <div className="cr-diff-toolbar">
        <button type="button" disabled={busy} onClick={() => void load(null, true)}>Refresh files</button>
        <span>{files.length} of {total} files loaded{incomplete ? " · Incomplete file list" : ""}</span>
        <label><input type="checkbox" checked={wrap} onChange={e => setWrap(e.target.checked)} />Wrap lines</label>
        <label><input type="checkbox" checked={highlight} onChange={e => setHighlight(e.target.checked)} />Highlight changes</label>
      </div>
      {missing > 0 && <p className="cr-patch-notice" role="status">Incomplete patch coverage · {missing} textual patches unavailable.</p>}
      <p className="cr-revision">Base {overview.revision.baseSha.slice(0, 8)} → head {overview.revision.headSha.slice(0, 8)}{stale ? " · Overview read earlier" : ""}</p>
      {pages.some(p => p.result.state === "stale") && <p role="status">Files read earlier. Anchors refer only to the revision shown.</p>}
      {last?.state === "unavailable" && <p role="alert">{unavailableText(last)} <button onClick={() => void load(lastPage?.cursor ?? null, files.length === 0)}>Retry files</button></p>}
      {last && last.state !== "ready" && last.state !== "unavailable" && <p role="status">This file page is {last.state}: {last.reason}. <button onClick={() => void load(lastPage?.cursor ?? null, pages.length === 1)}>Retry files</button></p>}
      {!files.length && !busy && last?.state === "ready" && <p>No changed files in this read.</p>}
      {files.map(file => <section key={file.path} ref={el => { if (el) sections.current.set(file.path, el); else sections.current.delete(file.path); }} tabIndex={-1} className="cr-file-section" data-testid="cr-file-section" data-path={file.path} data-base-sha={overview.revision.baseSha} data-head-sha={overview.revision.headSha} data-old-path={file.previousPath ?? file.path}>
        <header className="cr-file-heading">
          <button type="button" aria-label={`${expanded.includes(file.path) ? "Collapse" : "Expand"} ${file.path}`} aria-expanded={expanded.includes(file.path)} onClick={() => expanded.includes(file.path) ? setExpanded(paths => paths.filter(p => p !== file.path)) : open(file.path)}>
            <span aria-hidden="true">{expanded.includes(file.path) ? "▾" : "▸"}</span><FileIcon path={file.path} /><bdi dir="ltr" title={file.path}>{file.path}</bdi>
          </button>
          {file.patch.kind === "omitted" && <span className="cr-patch-state">{file.patch.reason === "binary" ? "No text diff" : "Patch unavailable"}</span>}
          <span className="stat add" aria-label={`${file.additions} additions`}>+{file.additions}</span><span className="stat del" aria-label={`${file.deletions} deletions`}>−{file.deletions}</span>
          <details className="cr-file-menu"><summary aria-label={`File options for ${file.path}`}>⋯</summary><div><button onClick={() => void bridge.invoke("clipboard:write", { text: file.path })}>Copy path</button>{prUrl(overview.locator) && <a href={`${prUrl(overview.locator)}/files`} target="_blank" rel="noreferrer">Open in GitHub</a>}</div></details>
        </header>
        {file.previousPath && <p className="cr-previous">Renamed from <bdi dir="ltr">{file.previousPath}</bdi></p>}
        {expanded.includes(file.path) && <FilePatch key={file.path} file={file} overview={overview} reader={reader} wrap={wrap} highlight={highlight} onAnchor={onAnchor} />}
      </section>)}
      {busy && <p role="status">Loading remote files… <button onClick={() => { reader.cancel("files"); setBusy(false); }}>Cancel</button></p>}
      {!busy && next && !stopped && last?.state === "ready" && files.length < DISPLAY.files && <button onClick={() => void load(next)}>Load next 100 files</button>}
      {stopped && <p role="status">{stopped} <a href={`${prUrl(overview.locator)}/files`} target="_blank" rel="noreferrer">Open in GitHub</a></p>}
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
  const tokens = useMemo(() => highlightRows(model.hunks.flatMap(hunk => hunk.rows)), [model]);
  const textUsed = useRef(0);
  const admitText = (n: number) => { if (textUsed.current + n > REMOTE_TEXT_LIMITS.contextCharacters) return false; textUsed.current += n; return true; };
  const refundText = (n: number) => { textUsed.current -= n; };
  const [contextUsed, setContextUsed] = useState(0);
  const reserved = useRef(0);
  const reserve = (n: number) => { if (reserved.current + n > DISPLAY.context) return false; reserved.current += n; setContextUsed(reserved.current); return true; };
  const release = (n: number) => { reserved.current -= n; setContextUsed(reserved.current); };
  const line = (side: "base" | "head", number: number) => { const anchor = anchorFor(overview.key, overview.revision, file, side, number); if (anchor) onAnchor(anchor); };
  if (model.state !== "text") return <p className="cr-patch-notice">{model.state === "binary" ? "No text diff · binary, empty or metadata-only change" : model.state === "provider" ? "Patch omitted by provider · code unavailable" : "Patch exceeds display limit · code unavailable"}</p>;
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
        {model.complete && gap > 0 && <ContextFold file={file} overview={overview} reader={reader} oldStart={oldStart} newStart={newStart} count={gap} wrap={wrap} highlight={highlight} onLine={line} budget={DISPLAY.context - contextUsed} reserve={reserve} release={release} admitText={admitText} refundText={refundText} />}
        <Diff rows={hunk.rows} tokens={tokens} tabbable={i === 0} wrap={wrap} highlight={highlight} onLine={line} />
      </div>;
    })}
    {model.complete && model.hunks.length > 0 && file.status !== "added" && file.status !== "removed" && <ContextFold file={file} overview={overview} reader={reader} oldStart={hunkBounds(model.hunks.at(-1)!).oldEnd} newStart={hunkBounds(model.hunks.at(-1)!).newEnd} count={null} wrap={wrap} highlight={highlight} onLine={line} budget={DISPLAY.context - contextUsed} reserve={reserve} release={release} admitText={admitText} refundText={refundText} />}
  </div>;
}

function ContextFold({ file, overview, reader, oldStart, newStart, count, wrap, highlight, onLine, budget, reserve, release, admitText, refundText }: { file: PrFile; overview: PrOverview; reader: Reader; oldStart: number; newStart: number; count: number | null; wrap: boolean; highlight: boolean; onLine: (side: "base" | "head", line: number) => void; budget: number; reserve: (n: number) => boolean; release: (n: number) => void; admitText: (n: number) => boolean; refundText: (n: number) => void }) {
  const [top, setTop] = useState<PatchRow[]>([]);
  const [bottom, setBottom] = useState<PatchRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);
  const live = useRef(true);
  const direction = useRef<"before" | "after">(count === null ? "after" : "before");
  const slot = `context:${file.path}:${newStart}`;
  const pendingSize = useRef(0);
  const renderedCharacters = useRef(0);
  const refund = () => { if (pendingSize.current) { release(pendingSize.current); pendingSize.current = 0; } };
  useEffect(() => { live.current = true; return () => { live.current = false; reader.cancel(slot); }; }, [reader, slot]);
  const expand = async (from: "before" | "after") => {
    const window = contextWindow({ oldStart, newStart, count, top: top.length, bottom: bottom.length, budget, direction: from });
    if (!window || !reserve(window.length)) return;
    direction.current = from;
    pendingSize.current = window.length;
    setBusy(true); setError(null);
    const outcome = await reader.read(slot, { op: "context", key: overview.key, revision: overview.revision, side: "head", path: file.path, start: window.start, end: window.end }, overview.key.account);
    if (!live.current || outcome.status === "superseded") return;
    setBusy(false);
    if (outcome.status !== "applied") { refund(); setError("Context reply did not match the selected revision."); return; }
    const result = outcome.result;
    if (result.state !== "ready") { refund(); setError(result.state === "unavailable" ? unavailableText(result) : "Context is stale or incomplete; retry for this revision."); return; }
    const value = result.value;
    if (!sameRevision(value.revision, overview.revision) || value.path !== file.path || value.side !== "head" || value.start !== window.start || value.lines.length > window.length) { refund(); setError("Context reply did not match the requested file and lines."); return; }
    const characters = value.lines.reduce((sum, text) => sum + text.length, 0);
    if (!admitText(characters)) { refund(); setError("Context exceeds display text limit · requested lines were not displayed. Open in GitHub for full context."); return; }
    renderedCharacters.current += characters;
    const rows = value.lines.map((text, i): PatchRow => ({ kind: "context", text, oldLine: window.oldStart + i, newLine: window.start + i, noNewline: false }));
    if (from === "before") setBottom(current => [...rows, ...current]);
    else setTop(current => [...current, ...rows]);
    release(window.length - value.lines.length); pendingSize.current = 0;
    setEnded(value.lines.length < window.length || (count === null && value.total !== null && window.start + value.lines.length > value.total));
  };
  const remaining = count === null ? null : count - top.length - bottom.length;
  const label = Math.min(DISPLAY.chunk, budget, remaining ?? DISPLAY.chunk);
  const collapse = () => {
    reader.cancel(slot); refund(); setBusy(false);
    refundText(renderedCharacters.current); renderedCharacters.current = 0;
    release(top.length + bottom.length); setTop([]); setBottom([]); setEnded(false); setError(null);
  };
  return <div className="cr-context-fold">
    {top.length > 0 && <Diff rows={top} wrap={wrap} highlight={highlight} onLine={onLine} />}
    {error && <p role="alert">{error}</p>}
    {busy ? <button onClick={() => { reader.cancel(slot); refund(); setBusy(false); }}>Cancel context</button> : !ended && remaining !== 0 && <div className="cr-context-actions">
      {error ? <button onClick={() => void expand(direction.current)}>Retry context</button> : budget <= 0 ? <span>Context display limit reached</span> : <>
        {count !== null && <button className="diff-fold" onClick={() => void expand("before")}>Expand {label} unchanged lines above change{remaining === null ? "" : ` (${remaining} folded)`}</button>}
        <button className="diff-fold" onClick={() => void expand("after")}>Expand {label} unchanged lines below{count === null ? " · More unchanged context may be available" : (newStart === 1 ? " from file start" : " previous change")}</button>
      </>}
    </div>}
    {bottom.length > 0 && <Diff rows={bottom} wrap={wrap} highlight={highlight} onLine={onLine} />}
    {(top.length > 0 || bottom.length > 0) && <button onClick={collapse}>Collapse expanded context</button>}
  </div>;
}
