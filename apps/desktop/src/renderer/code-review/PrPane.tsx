import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { Capabilities, Capability } from "../../shared/code-review.js";
import { PrOverview } from "./PrOverview";
import { bridge } from "../bridge";
import { ErrorNotice } from "../components/ui/ErrorNotice";
import { Icon, type IconName } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";
import { Tooltip } from "../components/ui/Tooltip";
import { prUrl, type OpenPr } from "./model.js";
import { type Pane } from "./navigation.js";
import { PrChanges, type ChangesViews } from "./PrChanges";
import { STATE_LABELS, unavailableText } from "./text.js";
import type { Writes } from "./writes.js";

interface Props {
  pane: Pane;
  changesViews: ChangesViews;
  pr: OpenPr;
  keyId: string;
  changesWidth: number;
  treeWidth: number | null;
  busy: boolean;
  pinned: boolean;
  caps: Capabilities;
  onPin: () => void;
  onRetry: () => void;
  onShowChanges: () => void;
  onActivityPage: (cursor: string | null) => void;
  contextBusy: ReadonlySet<string>;
  onTreeResize: (width: number) => void;
  onTreeReset: () => void;
  writes?: Writes;
}

/** Where each scroll region was, per PR, for returning to it. Session memory only. */
const scrolled = new Map<string, number>();

function useScrollMemory(ref: RefObject<HTMLElement | null>, id: string, content: string) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.scrollTop = scrolled.get(id) ?? 0;
    const remember = () => { scrolled.set(id, element.scrollTop); };
    element.addEventListener("scroll", remember, { passive: true });
    return () => { remember(); element.removeEventListener("scroll", remember); };
  }, [ref, id, content]);
}

/**
 * One pane of a PR: its header (C21–C29, repeated over Changes as C62) and the region below it. The
 * overview renders #323's read-only content; #324 supplies revision-bound remote diffs and the file tree.
 */
export function PrPane({ pane, changesViews, pr, keyId, changesWidth, treeWidth, busy, pinned, caps, onPin, onRetry, onShowChanges, onActivityPage, contextBusy, onTreeResize, onTreeReset, writes }: Props) {
  const body = useRef<HTMLDivElement>(null);
  const tree = useRef<HTMLElement>(null);
  const [filesShown, setFilesShown] = useState(false);
  const overview = pr.overview;
  const content = overview && overview.state !== "unavailable" ? `${overview.value.revision.baseSha}/${overview.value.revision.headSha}` : "loading";
  useScrollMemory(body, `${keyId}:${pane}`, content);
  useScrollMemory(tree, `${keyId}:tree`, content);
  const notice = overview?.state === "unavailable"
    ? <ErrorNotice className="cr-notice" testId="code-review-overview-error" where="Code Review · pull request" message={unavailableText(overview)} onRetry={onRetry} />
    : null;
  const status = !overview ? <p className="cr-hint" role="status">{busy ? "Loading the pull request…" : "Not loaded yet."}</p> : notice;
  return (
    <section id={`cr-pane-${pane}`} role="tabpanel" aria-labelledby={`cr-tab-${pane}`} className={`cr-pane cr-pane-${pane}`} data-pane={pane} data-testid={`code-review-pane-${pane}`}>
      <PrHeader pr={pr} busy={busy} pinned={pinned} caps={caps} onPin={onPin} filesToggle={pane === "changes" && treeWidth === null ? { shown: filesShown, toggle: () => setFilesShown((v) => !v) } : null} />
      {pane === "overview" && <div ref={body} className="cr-pane-body" data-testid="code-review-overview-body" tabIndex={-1}>
        {status ?? <PrOverview key={keyId} pr={pr} caps={caps} retry={onRetry} onChanges={onShowChanges} onPage={onActivityPage} busy={contextBusy} writes={writes} />}
      </div>}
      {pane === "changes" && (overview && overview.state !== "unavailable"
        ? <PrChanges views={changesViews} overview={overview.value} stale={overview.state !== "ready"} bodyRef={body} treeRef={tree} treeWidth={treeWidth} changesWidth={changesWidth} filesShown={filesShown} onSelect={() => setFilesShown(false)} onTreeResize={onTreeResize} onTreeReset={onTreeReset} writes={writes} />
        : <div ref={body} className="cr-diff" data-testid="code-review-diff">{status}</div>)}
    </section>
  );
}

function PrHeader({ pr, busy, pinned, caps, onPin, filesToggle }: { pr: OpenPr; busy: boolean; pinned: boolean; caps: Capabilities; onPin: () => void; filesToggle: { shown: boolean; toggle: () => void } | null }) {
  const state = pr.overview && pr.overview.state !== "unavailable" ? pr.overview.value.state : pr.state;
  const { owner, repo, number } = pr.locator;
  const url = prUrl(pr.locator);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    if (!url) return;
    void bridge.invoke("clipboard:write", { text: url }).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <header className="cr-pr-header" data-testid="code-review-pr-header">
      {state && <span className={`cr-state cr-state-${state}`} data-testid="code-review-state"><Icon name="pull-request" size={14} />{STATE_LABELS[state]}</span>}
      <span className="cr-pr-id" data-testid="code-review-pr-id" title={`${owner}/${repo} #${number}`}>{repo} #{number}</span>
      {busy && <span className="spinner" role="status" aria-label="Loading the pull request" data-testid="code-review-loading" />}
      <span className="spacer" />
      <span className="sr-only" aria-live="polite">{copied ? "Link copied" : ""}</span>
      {filesToggle && <IconButton icon="list" size="md" label={filesToggle.shown ? "Show the diff" : "Show changed files"} aria-pressed={filesToggle.shown} data-testid="code-review-files-toggle" onClick={filesToggle.toggle} />}
      <span className="cr-link-group">
        <IconButton icon="pin" size="md" label={pinned ? "Unpin" : "Pin"} aria-pressed={pinned} data-testid="code-review-pin" onClick={onPin} />
        <IconButton icon="link" size="md" label={copied ? "Link copied" : "Copy link"} data-testid="code-review-copy-link" disabled={!url} onClick={copy} />
        {url && <Tooltip label="Open in GitHub"><a className="icon-btn md" href={url} target="_blank" rel="noreferrer" aria-label="Open in GitHub" data-testid="code-review-open-github"><Icon name="external" size={16} /></a></Tooltip>}
      </span>
      <Unavailable label="Review with Codex" icon="review" iconWhenNarrow capability={caps.review} testId="code-review-review" text />
      <Unavailable label="Review instructions" icon="gear" capability={caps.instructions} testId="code-review-instructions" />
      <Unavailable label="Merge" icon="branch" capability={caps.merge} testId="code-review-merge" text primary />
    </header>
  );
}

/** A control whose slice has not delivered it: focusable, named, and saying why it does nothing. */
function Unavailable({ label, icon, iconWhenNarrow = false, capability, testId, text = false, primary = false }: { label: string; icon?: IconName; iconWhenNarrow?: boolean; capability: Capability; testId: string; text?: boolean; primary?: boolean }) {
  const reason = capability.available ? label : capability.reason;
  return (
    <Tooltip label={reason}>
      <button type="button" className={`cr-action${text ? "" : " icon-only"}${primary ? " primary" : ""}`} aria-label={label} aria-disabled={capability.available ? undefined : "true"} data-testid={testId}
        onClick={(event) => { if (!capability.available) event.preventDefault(); }}>
        {icon && <Icon name={icon} size={14} className={iconWhenNarrow ? "cr-narrow-icon" : undefined} />}
        {text && <span className="cr-action-label">{label}</span>}
      </button>
    </Tooltip>
  );
}
