import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { bridge } from "../bridge";
import { capabilities, canonicalPrUrl, parsePrLocator, prKeyId, sameKey, sameRevision, type CodeReviewAccount, type CodeReviewConnection, type Inbox, type InboxGroup, type ReadResult } from "../../shared/code-review.js";
import type { Layout } from "../../shared/layout";
import { PanelResizeHandle } from "../components/PanelResizeHandle";
import { Icon } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";
import { Tooltip } from "../components/ui/Tooltip";
import { refreshingRead, retainRead } from "../../shared/code-review-overview.js";
import { Reader, type Ask, type Outcome } from "./reader.js";
import { back, canBack, canForward, closeChanges, current, DEFAULT_VIEW, EMPTY_HISTORY, fitSplit, fitTree, forward, panesFor, showTab, SPLIT, toggleSplit, visit, type History, type Pane, type PrView } from "./navigation.js";
import { isPinned, loadPins, togglePin, type Pin } from "./pins.js";
import { additions, deletions, unavailableText } from "./text.js";
import { InboxPane } from "./Inbox";
import { rowsOf, titleOf, type GroupPages, type OpenPr } from "./model.js";
import type { ChangesViews } from "./PrChanges";
import { PrPane } from "./PrPane";
import { Writes } from "./writes.js";
import "./code-review.css";

/** The title bar's back and forward while Code Review is the surface. */
export interface ReviewNavigation { canBack: boolean; canForward: boolean; back: () => void; forward: () => void }

interface Props {
  active: boolean;
  inboxOpen: boolean;
  layout: Layout;
  setLayout: (patch: Partial<Layout>) => void;
  onNavigation: (nav: ReviewNavigation | null) => void;
}

const connected = (result: ReadResult<CodeReviewConnection> | null): CodeReviewAccount | null =>
  result && result.state !== "unavailable" && result.value.state === "connected" ? result.value.account : null;

const SEARCH_DELAY = 250;

/**
 * The Code Review surface (#322): the inbox beside a PR workspace whose PR and Changes tabs sit in the
 * title bar, alone or side by side (R1, R4). Every read goes through main's `code-review:read`; a
 * reply is shown only for the account, PR and request that asked for it. The overview's content
 * (#323) and the remote diff (#324) fill the panes this host lays out.
 */
export default function CodeReviewView({ active, inboxOpen, layout, setLayout, onNavigation }: Props) {
  const reader = useMemo(() => new Reader((request) => bridge.invoke("code-review:read", request), undefined, `cr${Math.random().toString(36).slice(2, 8)}`), []);
  useEffect(() => () => reader.cancelAll(), [reader]);
  // Comments and reviews (#326) go through main's separate write channel.
  const writes = useMemo(() => new Writes((request) => bridge.invoke("code-review:write", request)), []);
  const [connection, setConnection] = useState<ReadResult<CodeReviewConnection> | null>(null);
  const account = connected(connection);
  const accountRef = useRef<CodeReviewAccount | null>(null);
  const changesViews = useRef<ChangesViews>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set());
  const [inbox, setInbox] = useState<ReadResult<Inbox> | null>(null);
  const [pages, setPages] = useState<GroupPages>({});
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const searchedRef = useRef(searched); searchedRef.current = searched;
  const [refreshes, setRefreshes] = useState(0);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [prs, setPrs] = useState<Record<string, OpenPr>>({});
  const prsRef = useRef(prs); prsRef.current = prs;
  const activityEpoch = useRef(new Map<string, number>());
  const [views, setViews] = useState<Record<string, PrView>>({});
  const [history, setHistory] = useState<History>(EMPTY_HISTORY);
  const [pins, setPins] = useState<Pin[]>([]);
  const [now, setNow] = useState(() => Date.now());

  /** Reads through the reader and keeps `busy` true while the slot's latest read is in flight. */
  const run = async <A extends Ask>(slot: string, ask: A, accountId: string | null): Promise<Outcome<A["op"]>> => {
    setBusy((b) => new Set(b).add(slot));
    const outcome = await reader.read(slot, ask, accountId);
    if (!reader.pending(slot)) setBusy((b) => { const next = new Set(b); next.delete(slot); return next; });
    return outcome;
  };

  const readConnection = async () => {
    const outcome = await run("connection", { op: "connection" }, null);
    if (outcome.status !== "applied") return;
    const next = connected(outcome.result);
    setConnection(outcome.result);
    if (next?.id === accountRef.current?.id) return;
    // Another account, or none: nothing asked under the old one may land, and none of its PRs stay open.
    reader.cancelAll();
    writes.clear();
    changesViews.current.clear();
    accountRef.current = next;
    setBusy(new Set());
    setInbox(null); setPages({}); setPrs({}); setViews({}); setHistory(EMPTY_HISTORY); setResolveError(null);
    setPins(next ? loadPins(localStorage, next.id) : []);
  };
  const readConnectionRef = useRef(readConnection); readConnectionRef.current = readConnection;

  const readInbox = async (acc: CodeReviewAccount, q: string) => {
    for (const group of ["authored", "review-requested"] as const) reader.cancel(`page:${group}`);
    const outcome = await run("inbox", { op: "inbox", query: q }, acc.id);
    if (outcome.status === "superseded") return;
    if (outcome.status === "mismatch") return void readConnectionRef.current();
    const result = outcome.result;
    // An answer for another query or account is not this inbox.
    if (result.state !== "unavailable" && (result.value.query !== q || result.value.account !== acc.id)) return;
    setInbox(result); setPages({}); setNow(Date.now());
  };

  const readOverview = async (pr: OpenPr) => {
    const acc = accountRef.current;
    if (!acc) return;
    const id = prKeyId(pr.key);
    const outcome = await run(`overview:${id}`, { op: "overview", key: pr.key }, acc.id);
    if (outcome.status === "superseded") return;
    if (outcome.status === "mismatch") return void readConnectionRef.current();
    const result = outcome.result;
    if (result.state !== "unavailable" && !sameKey(result.value.key, pr.key)) return;
    setPrs((p) => p[id] ? { ...p, [id]: { ...p[id]!, overview: result } } : p);
    if (result.state !== "unavailable") void readContext(pr, result.value.revision);
    // A key for another account than gh's: the account changed under us.
    if (result.state === "unavailable" && result.reason === "signed-out") void readConnectionRef.current();
  };

  async function readActivity(pr: OpenPr, cursor: string | null, epoch = activityEpoch.current.get(prKeyId(pr.key)) ?? 0) {
    const id = prKeyId(pr.key);
    const outcome = await run(`activity:${id}:${cursor ?? "first"}`, { op: "activity", key: pr.key, cursor }, pr.key.account);
    if ((activityEpoch.current.get(id) ?? 0) !== epoch) return null;
    if (outcome.status === "mismatch") { void readConnectionRef.current(); return null; }
    if (outcome.status !== "applied") return null;
    setPrs(p => p[id] ? { ...p, [id]: { ...p[id]!, activity: { ...p[id]!.activity, [cursor ?? "first"]: retainRead(p[id]!.activity?.[cursor ?? "first"], outcome.result) } } } : p);
    return outcome.result;
  }

  async function readContext(pr: OpenPr, revision: import("../../shared/code-review.js").PrRevision) {
    const id = prKeyId(pr.key);
    const epoch = (activityEpoch.current.get(id) ?? 0) + 1;
    activityEpoch.current.set(id, epoch);
    // Snapshot at launch, not before the overview request: pagination may have completed meanwhile.
    const cached = prsRef.current[id]?.activity ?? {};
    for (const cursor of Object.keys(cached)) reader.cancel(`activity:${id}:${cursor}`);
    setPrs(p => p[id] ? { ...p, [id]: { ...p[id]!, activityRefreshing: true,
      activity: Object.fromEntries(Object.entries(p[id]!.activity ?? {}).map(([cursor, read]) => [cursor, refreshingRead(read)])),
      ...(p[id]!.checks ? { checks: refreshingRead(p[id]!.checks!) } : {}),
    } } : p);
    const checks = run(`checks:${id}`, { op: "checks", key: pr.key, revision }, pr.key.account).then(outcome => {
      if (outcome.status === "mismatch") return void readConnectionRef.current();
      if (outcome.status !== "applied") return;
      setPrs(p => p[id]?.overview && p[id]!.overview!.state !== "unavailable" && sameRevision(p[id]!.overview!.value.revision, revision)
        ? { ...p, [id]: { ...p[id]!, checks: retainRead(p[id]!.checks, outcome.result) } } : p);
    });
    const stack = run(`stack:${id}`, { op: "stack", key: pr.key }, pr.key.account).then(outcome => {
      if (outcome.status === "mismatch") return void readConnectionRef.current();
      if (outcome.status !== "applied") return;
      setPrs(p => p[id] ? { ...p, [id]: { ...p[id]!, stack: retainRead(p[id]!.stack, outcome.result) } } : p);
    });
    const refreshActivity = async () => {
      let cursor: string | null = null;
      const seen = new Set<string>();
      // Refresh as much as the reader had opened, following new cursors in order.
      const limit = Math.max(1, Object.keys(cached).length);
      for (let i = 0; i < limit; i++) {
        const result = await readActivity(pr, cursor, epoch);
        if (!result || result.state === "unavailable" || result.state === "stale") break;
        cursor = result.coverage?.next ?? null;
        if (!cursor || seen.has(cursor)) break;
        seen.add(cursor);
      }
      if (activityEpoch.current.get(id) === epoch) setPrs(p => p[id] ? { ...p, [id]: { ...p[id]!, activityRefreshing: false } } : p);
    };
    await Promise.all([checks, stack, refreshActivity()]);
  }

  const openPr = (pr: Omit<OpenPr, "overview">) => {
    const id = prKeyId(pr.key);
    setPrs((p) => ({ ...p, [id]: p[id] ? { ...p[id]!, title: pr.title ?? p[id]!.title, state: pr.state ?? p[id]!.state } : { ...pr, overview: null } }));
    setViews((v) => v[id] ? v : { ...v, [id]: DEFAULT_VIEW });
    setHistory((h) => visit(h, id));
  };

  const resolve = async (input: string, title: string | null = null) => {
    const acc = accountRef.current;
    if (!acc) return;
    setResolveError(null);
    const outcome = await run("resolve", { op: "resolve", input }, acc.id);
    if (outcome.status === "superseded") return;
    if (outcome.status === "mismatch") return void readConnectionRef.current();
    const result = outcome.result;
    if (result.state === "unavailable") return setResolveError(unavailableText(result));
    if (result.value.key.account !== acc.id) return void readConnectionRef.current();
    setQuery("");
    openPr({ key: result.value.key, locator: result.value.locator, title: title ?? prsRef.current[prKeyId(result.value.key)]?.title ?? null, state: null });
  };

  // Check the connection whenever the surface is shown: the gh account may have changed meanwhile.
  useEffect(() => { if (active) void readConnectionRef.current(); }, [active]);

  // Search as the person types, once they pause. A pasted or typed PR link opens instead (Enter or paste).
  useEffect(() => {
    const text = query.trim();
    if (parsePrLocator(text)) return;
    const timer = setTimeout(() => setSearched(text), SEARCH_DELAY);
    return () => clearTimeout(timer);
  }, [query]);
  const readInboxRef = useRef(readInbox); readInboxRef.current = readInbox;
  useEffect(() => {
    const acc = accountRef.current;
    if (acc && acc.id === account?.id) void readInboxRef.current(acc, searched);
  }, [account?.id, searched, refreshes]);

  const selectedId = current(history);
  const selected = selectedId ? prs[selectedId] ?? null : null;
  const view = (selectedId && views[selectedId]) || DEFAULT_VIEW;
  const setView = (change: (view: PrView) => PrView) => {
    if (selectedId) setViews((v) => ({ ...v, [selectedId]: change(v[selectedId] ?? DEFAULT_VIEW) }));
  };

  // A PR opened for the first time reads its overview; returning to it shows what was read.
  const readOverviewRef = useRef(readOverview); readOverviewRef.current = readOverview;
  useEffect(() => {
    const pr = selectedId ? prsRef.current[selectedId] : null;
    if (pr && !pr.overview && !reader.pending(`overview:${selectedId}`)) void readOverviewRef.current(pr);
  }, [selectedId, reader]);

  useEffect(() => {
    onNavigation(active ? { canBack: canBack(history), canForward: canForward(history), back: () => setHistory(back), forward: () => setHistory(forward) } : null);
  }, [active, history, onNavigation]);
  useEffect(() => () => onNavigation(null), [onNavigation]);

  const refresh = () => {
    setRefreshes((n) => n + 1);
    void readConnection();
    if (selected) void readOverview(selected);
  };

  const [workspace, setWorkspace] = useState<HTMLElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!workspace) return;
    const measure = () => setWidth(workspace.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, [workspace]);
  const panes = selected ? panesFor(view, width) : [];
  const split = panes.length === 2;
  const splitWidth = fitSplit(layout.codeReviewSplit, width);
  const changesWidth = split ? width - splitWidth - 1 : width;
  const treeWidth = fitTree(layout.codeReviewTree, changesWidth);

  const [titlebar, setTitlebar] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setTitlebar(document.getElementById("code-review-titlebar")); }, []);
  const tabRefs = useRef<Partial<Record<Pane, HTMLButtonElement | null>>>({});
  const focusTab = (pane: Pane) => requestAnimationFrame(() => tabRefs.current[pane]?.focus());
  const inboxRef = useRef<HTMLDivElement>(null);
  const focusRow = (id: string | null) => requestAnimationFrame(() => {
    const row = id ? inboxRef.current?.querySelector<HTMLElement>(`[data-key-id="${CSS.escape(id)}"]`) : null;
    (row ?? inboxRef.current?.querySelector<HTMLElement>("input"))?.focus();
  });

  const closePr = () => { const id = selectedId; setHistory((h) => visit(h, null)); focusRow(id); };
  const closeChangesTab = () => { setView(closeChanges); focusTab("overview"); };

  const connectionValue: CodeReviewConnection = connection && connection.state !== "unavailable" ? connection.value : { state: "unavailable", detail: connection?.state === "unavailable" ? unavailableText(connection) : "" };
  const caps = capabilities(connectionValue);
  const pinned = selected ? isPinned(pins, selected.key) : false;
  const pin = () => {
    if (!selected || !account) return;
    setPins(togglePin(localStorage, account.id, { key: selected.key, locator: selected.locator, title: titleOf(selected) }));
  };
  const openPin = (p: Pin) => {
    const id = prKeyId(p.key);
    const seen = prs[id] ?? rowsOf(inbox, pages).find((row) => prKeyId(row.key) === id);
    // Main knows a repository only from its own reads: a pin from another session resolves its link first.
    if (seen) openPr({ key: seen.key, locator: seen.locator, title: "title" in seen && seen.title ? seen.title : p.title, state: seen.state });
    else void resolve(canonicalPrUrl(p.locator), p.title);
  };

  const totals = selected?.overview && selected.overview.state !== "unavailable" ? selected.overview.value.totals : null;
  const tabs = (group: Pane[]) => (
    <div className="cr-tabgroup" role="tablist" aria-label={group.includes("overview") ? "Pull request tabs" : "Changes tabs"} style={split && group.includes("overview") ? { width: splitWidth } : undefined}>
      {group.map((pane) => {
        const isSelected = split || panes[0] === pane;
        const label = pane === "overview" ? titleOf(selected!) : "Changes";
        const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
          const next = event.key === "ArrowRight" || event.key === "ArrowLeft" ? group.find((p) => p !== pane) : undefined;
          if (!next) return;
          event.preventDefault();
          setView((v) => showTab(v, next));
          focusTab(next);
        };
        return <div key={pane} className={`workspace-tab cr-tab${isSelected ? " selected" : ""}`} data-pane={pane}>
          <button ref={(el) => { tabRefs.current[pane] = el; }} role="tab" id={`cr-tab-${pane}`} data-testid={`code-review-tab-${pane}`} aria-selected={isSelected} aria-controls={`cr-pane-${pane}`}
            tabIndex={isSelected ? 0 : -1} title={label} onClick={() => setView((v) => showTab(v, pane))} onKeyDown={keyDown}>
            <Icon name={pane === "overview" ? "pull-request" : "files"} size={14} />
            <span className="cr-tab-label">{label}</span>
            {pane === "changes" && totals && <span className="cr-totals"><span className="cr-add">{additions(totals.additions)}</span> <span className="cr-del">{deletions(totals.deletions)}</span></span>}
          </button>
          <button type="button" className="workspace-tab-close" data-testid={`code-review-close-${pane}`} aria-label={pane === "overview" ? `Close ${label}` : "Close Changes"} onClick={pane === "overview" ? closePr : closeChangesTab}><Icon name="close" size={13} /></button>
        </div>;
      })}
      {/* C07: what a new tab opens here is an open decision; until then it is shown and unavailable. */}
      {(!split || !group.includes("overview")) && <Tooltip label="New tab isn't available here yet"><button type="button" className="icon-btn md cr-new-tab" aria-label="New tab" aria-disabled="true" data-testid="code-review-new-tab"><Icon name="plus" size={16} /></button></Tooltip>}
    </div>
  );
  const singleGroup: Pane[] = view.changes ? ["overview", "changes"] : ["overview"];
  const tabStrip = titlebar && active && createPortal(
    <div className="cr-tabbar" data-testid="code-review-tabbar">
      {selected && (split ? <>{tabs(["overview"])}{tabs(["changes"])}</> : tabs(singleGroup))}
      <span className="spacer" />
      {selected && <IconButton icon="changes" size="md" label={view.mode === "split" ? "Show one pane" : "Show Changes beside the pull request"} aria-pressed={view.mode === "split"} data-testid="code-review-split-toggle" onClick={() => { setView(toggleSplit); }} />}
    </div>, titlebar);

  const style = { "--cr-split-w": `${splitWidth}px`, "--cr-tree-w": `${treeWidth ?? 0}px` } as CSSProperties;
  return (
    <section className="code-review" data-testid="code-review" aria-label="Code Review" hidden={!active}>
      {tabStrip}
      {inboxOpen && <InboxPane ref={inboxRef} connection={connection} account={account} inbox={inbox} pages={pages} query={query} now={now} busy={busy} resolveError={resolveError}
        selectedId={selectedId} pins={pins} onQuery={(text) => { setQuery(text); setResolveError(null); }} onResolve={(input) => void resolve(input)}
        onOpen={(row) => openPr({ key: row.key, locator: row.locator, title: row.title, state: row.state })} onOpenPin={openPin} onRefresh={refresh}
        onRetryConnection={() => void readConnection()} onRetryInbox={() => account && void readInbox(account, searched)}
        onShowMore={(group, cursor) => account && void showMore(group, cursor)} />}
      <div ref={setWorkspace} className="cr-workspace" data-testid="code-review-workspace" data-panes={panes.join(" ")} style={style}>
        {!selected && <div className="cr-empty" data-testid="code-review-empty">
          <Icon name="pull-request" size={20} />
          <p>{account ? "Choose a pull request from the inbox, or paste a link to one." : "Pull requests appear here once GitHub CLI is signed in."}</p>
        </div>}
        {selected && panes.map((pane) => <PrPane key={pane} pane={pane} changesViews={changesViews.current} pr={selected} keyId={selectedId!} changesWidth={changesWidth} treeWidth={treeWidth}
          busy={busy.has(`overview:${selectedId}`)} pinned={pinned} caps={caps} onPin={pin} onRetry={() => void readOverview(selected)}
          onShowChanges={() => { setView(v => showTab(v, "changes")); focusTab("changes"); }} onActivityPage={(cursor) => void readActivity(selected, cursor)} contextBusy={busy} onTreeResize={(w) => setLayout({ codeReviewTree: w })} onTreeReset={() => setLayout({ codeReviewTree: undefined })} writes={writes} />)}
        {split && <PanelResizeHandle side="sidebar" className="cr-split-resizer" label="Resize the pull request pane" width={splitWidth} min={SPLIT.overviewMin} max={Math.max(SPLIT.overviewMin, width - 1 - SPLIT.changesMin)}
          onResize={(w) => setLayout({ codeReviewSplit: w })} onReset={() => setLayout({ codeReviewSplit: undefined })} />}
      </div>
    </section>
  );

  async function showMore(group: InboxGroup, cursor: string) {
    const acc = accountRef.current;
    if (!acc) return;
    const q = searchedRef.current;
    const outcome = await run(`page:${group}`, { op: "inbox-page", group, query: q, cursor }, acc.id);
    if (outcome.status === "superseded") return;
    if (outcome.status === "mismatch") return void readConnectionRef.current();
    const result = outcome.result;
    setPages((p) => {
      return { ...p, [group]: { reads: { ...p[group]?.reads, [cursor]: result } } };
    });
  }
}
