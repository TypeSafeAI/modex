import { useState, useRef, useLayoutEffect, type ReactNode } from "react";
import { prKeyId, summarizeChecks, type Capabilities, type Capability, type PrActivity, type PrLocator, type ReadResult } from "../../shared/code-review.js";
import { activityPages, externalDestination, stackOrder } from "../../shared/code-review-overview.js";
import { bridge } from "../bridge";
import { Menu, MenuItem } from "../components/ui/Menu";
import { Markdown } from "../components/Markdown";
import { ErrorNotice } from "../components/ui/ErrorNotice";
import type { OpenPr } from "./model.js";
import { prUrl } from "./model.js";
import { additions, deletions, shortfallText, unavailableText } from "./text.js";
import { ReviewComposer } from "./ReviewComposer";
import type { Writes } from "./writes.js";
import { EditPullRequest, RequestReviewers } from "./PrActions";
import type { Agent } from "./agent.js";
import { AgentReview } from "./AgentReview";

/** Explicit action boundary for CR-7. No draft or successful submission is invented here. */
export interface OverviewActions { edit?: () => void; requestReviewers?: () => void; comment?: () => void }
function Action({ label, capability, action }: { label: string; capability: Capability; action?: () => void }) {
  const available = capability.available && !!action;
  return <button className="btn" type="button" aria-disabled={!available || undefined} title={capability.available ? (action ? label : "This action isn't connected yet.") : capability.reason} onClick={available ? action : undefined}>{label}</button>;
}
function Evidence({ result, label, retry }: { result: ReadResult<unknown> | undefined; label: string; retry: () => void }) {
  if (!result) return <p role="status">Loading {label}…</p>;
  if (result.state === "unavailable") return <ErrorNotice where={`Code Review · ${label}`} message={unavailableText(result)} onRetry={retry} />;
  return <p className="cr-evidence">{result.state === "stale" ? "Stale · " : result.state === "partial" ? "Partial · " : ""}Read <time dateTime={result.fetchedAt}>{result.fetchedAt}</time>{result.state !== "ready" ? ` · ${shortfallText(result.reason)}` : ""}{result.state !== "ready" && <button className="btn" type="button" onClick={retry}>Retry {label}</button>}</p>;
}
function External({ url, children }: { url: string | null; children?: ReactNode }) {
  const destination = externalDestination(url);
  return destination ? <a href={destination} target="_blank" rel="noreferrer" title={destination}>{children} <span className="cr-destination">{new URL(destination).host}</span></a> : <span>Destination unavailable</span>;
}

const positions = new Map<string, number>();
function usePosition(id: string) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollTop = positions.get(id) ?? 0;
    const remember = () => positions.set(id, node.scrollTop);
    node.addEventListener("scroll", remember, { passive: true });
    return () => node.removeEventListener("scroll", remember);
  }, [id]);
  return ref;
}
export function PrOverview({ pr, caps, retry, onChanges, onPage, busy, actions = {}, writes, agent }: { pr: OpenPr; caps: Capabilities; retry: () => void; onChanges: () => void; onPage: (cursor: string | null) => void; busy: ReadonlySet<string>; actions?: OverviewActions; writes?: Writes; agent?: Agent }) {
  const main = usePosition(`${prKeyId(pr.key)}:content`);
  const sidebar = usePosition(`${prKeyId(pr.key)}:details`);
  const read = pr.overview;
  const [filter, setFilter] = useState("all");
  const [allChecks, setAllChecks] = useState(false);
  if (!read || read.state === "unavailable") return null;
  const overview = read.value;
  // Follow cursors, never object insertion order: parallel refreshes may finish in any order.
  const pages: ReadResult<PrActivity[]>[] = [];
  const pageCursors: string[] = [];
  const visited = new Set<string>();
  let cursor: string | null = "first";
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const page: ReadResult<PrActivity[]> | undefined = pr.activity?.[cursor];
    if (!page) break;
    pages.push(page);
    pageCursors.push(cursor);
    cursor = page.state === "unavailable" ? null : page.coverage?.next ?? null;
  }
  const activity = activityPages(pages);
  const pageFailed = pages.at(-1)?.state === "unavailable";
  const rows = activity.rows.filter(row => filter === "all" || row.kind === filter);
  const grouped: PrActivity[][] = [];
  for (const row of rows) {
    const last = grouped.at(-1);
    if (row.kind === "commit" && last?.[0]?.kind === "commit") last.push(row);
    else grouped.push([row]);
  }
  const checks = pr.checks;
  const stack = pr.stack;
  const freshOverview = read.state === "ready";
  // C54 "Add to chat": the comment's text, quoted into the question composer. Nothing runs until Ask is pressed.
  const ask = agent && caps.review.available ? (text: string) => agent.quote(pr.key, text) : undefined;
  return <div className="cr-overview-layout">
    <main ref={main} className="cr-overview-main" tabIndex={0} aria-label="Description and activity">
      <Evidence result={read} label="pull request" retry={retry} />
      <h1>{overview.title}</h1>
      <div className="cr-overview-meta"><strong>{overview.author.login}</strong> opened <time dateTime={overview.createdAt}>{new Date(overview.createdAt).toLocaleString()}</time><br /><code>{overview.headRepo ? `${overview.headRepo}:` : ""}{overview.headRef}</code> → <code>{overview.revision.baseRef}</code>{writes ? <EditPullRequest writes={writes} overview={overview} fallback={caps.edit} onDone={retry} /> : <Action label="Edit pull request" capability={caps.edit} action={actions.edit} />}</div>
      <button type="button" className="cr-changes-summary" onClick={onChanges} aria-label="Open Changes">{overview.totals.files} changed files · <span className="cr-add">{additions(overview.totals.additions)}</span> <span className="cr-del">{deletions(overview.totals.deletions)}</span> · {overview.comments} comments</button>
      <article data-testid="cr-description" aria-label="Pull request description"><Markdown text={overview.body || "No description provided."} /></article>
      {agent && writes && <AgentReview agent={agent} overview={overview} writes={writes} fallback={caps.review} />}
      <section data-testid="cr-activity" className="cr-activity" aria-labelledby="cr-activity-heading">
        <div className="cr-section-heading"><h2 id="cr-activity-heading">Activity</h2><label>Show <select aria-label="Activity filter" value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All activity</option><option value="commit">Commits</option><option value="comment">Comments</option><option value="review">Reviews</option><option value="deployment">Deployments</option><option value="event">Events</option></select></label></div>
        <Evidence result={pages[0]} label="activity" retry={retry} />
        {grouped.map(group => group[0]!.kind === "commit" ? <details className="cr-commit-group" key={`commit:${group[0]!.id}`}><summary>{group.length} {group.length === 1 ? "commit" : "commits"}</summary>{group.map(row => <Activity key={`${row.kind}:${row.id}`} row={row} locator={overview.locator} onAsk={ask} />)}</details> : <Activity key={`${group[0]!.kind}:${group[0]!.id}`} row={group[0]!} locator={overview.locator} onAsk={ask} />)}
        {pages.slice(1).map((page, i) => page.state !== "ready" && <Evidence key={i} result={page} label="activity page" retry={() => page.state !== "unavailable" && page.coverage?.next ? retry() : onPage(pageCursors[i + 1]!)} />)}
        {pr.activityRefreshing && <p role="status" className="cr-evidence">Refreshing activity · Earlier pages remain provisional.</p>}
        {activity.complete && !pr.activityRefreshing ? <p className="cr-evidence">{activity.rows.length ? "All activity loaded" : "No activity"}{filter !== "all" && rows.length === 0 ? " · No matching activity" : ""}</p> : <p className="cr-evidence">{activity.rows.length} activity items loaded · More activity may be missing.</p>}
        {activity.next && <button type="button" className="btn" disabled={pr.activityRefreshing || [...busy].some(s => s.startsWith(`activity:${prKeyId(pr.key)}:`))} onClick={() => onPage(activity.next)}>{pageFailed ? "Retry activity page" : "Load more activity"}</button>}
        {writes ? <ReviewComposer writes={writes} overview={overview} fallback={caps.comment} />
          : <div className="cr-comment-slot"><p>Comment on this pull request</p><Action label="Comment" capability={caps.comment} action={actions.comment} /><p className="cr-evidence">{!caps.comment.available && caps.comment.reason}</p></div>}
      </section>
    </main>
    <aside ref={sidebar} className="cr-overview-sidebar" aria-label="Pull request details" tabIndex={0}>
      <section><h2>Changes</h2><p>{freshOverview ? "" : "Previously read · "}{overview.totals.files} files · <span className="cr-add">{additions(overview.totals.additions)}</span> <span className="cr-del">{deletions(overview.totals.deletions)}</span></p><p>{overview.totals.commits} commits · {overview.comments ? `${overview.comments} comments` : freshOverview ? "No comments" : "Comments unknown"}</p></section>
      <section data-testid="cr-stack"><h2>Stack</h2><Evidence result={stack} label="stack" retry={retry} />{stack && stack.state !== "unavailable" && <><p>{stack.value.source === "inferred" ? "Inferred from base/head branches · May be incomplete" : "Explicit stack metadata"}</p>{stackOrder(stack.value) ? <ol>{stack.value.members.map((member, index) => <li key={prUrl(member.locator) ?? index} aria-current={index === stack.value.position ? "true" : undefined}><External url={prUrl(member.locator)}>{member.title ?? "Inaccessible member"} #{member.locator.number}</External>{member.state && <span className="cr-stack-state">{member.state}</span>}</li>)}</ol> : <p>Ambiguous stack · No ordering available.</p>}</>}</section>
      <section><h2>Reviewers</h2>{overview.reviewers.map(actor => <p key={actor.id ?? actor.login}>{actor.login}</p>)}{!overview.reviewers.length && <p>{freshOverview ? "No reviewers requested" : "Reviewers unknown"}</p>}{writes ? <RequestReviewers writes={writes} overview={overview} fallback={caps["request-reviewers"]} onDone={retry} /> : <Action label="Request reviewers" capability={caps["request-reviewers"]} action={actions.requestReviewers} />}</section>
      <section data-testid="cr-checks"><h2>Checks · {summarizeChecks(checks ?? { state: "unavailable", reason: "failed", fetchedAt: read.fetchedAt }, overview.revision).verdict}</h2><Evidence result={checks} label="checks" retry={retry} /><p className="cr-evidence">Head {overview.revision.headSha.slice(0, 8)} · Evidence only; merge permission is separate.</p>{checks && checks.state !== "unavailable" && <>{checks.value.length === 0 && <p>{checks.state === "ready" && checks.coverage?.complete ? "No checks reported" : "Checks unknown"}</p>}{checks.value.slice(0, allChecks ? undefined : 4).map(check => <details key={`${check.source}:${check.id}`}><summary>{check.name} · {check.status === "completed" ? check.conclusion ?? "unknown" : check.status}{check.headSha !== overview.revision.headSha && " · Old revision"}</summary><p>{check.source} · {check.reporter ?? "Unknown reporter"} · {check.headSha.slice(0, 8)}</p><p>Elapsed at read · {elapsed(check.startedAt, check.completedAt ?? checks.fetchedAt)}</p><p>Started {check.startedAt ?? "unknown"} · Finished {check.completedAt ?? "unknown"}</p><External url={check.url}>Check details</External></details>)}{checks.value.length > 4 && <button className="btn" type="button" onClick={() => setAllChecks(v => !v)}>{allChecks ? "Show fewer checks" : "Show all checks"}</button>}</>}</section>
      <section data-testid="cr-deployments"><h2>Deployments</h2><Evidence result={pages[0]} label="deployment source" retry={retry} /><p className="cr-evidence">Provider deployment records and comment links have separate provenance. Only loaded activity is shown.</p>{activity.rows.filter((r): r is Extract<PrActivity, { kind: "deployment" }> => r.kind === "deployment").map(row => <Activity key={row.id} row={row} currentHead={overview.revision.headSha} />)}{!activity.rows.some(r => r.kind === "deployment") && <p>No provider deployment evidence in loaded activity.</p>}</section>
    </aside>
  </div>;
}
function Activity({ row, locator, currentHead, onAsk }: { row: PrActivity; locator?: PrLocator; currentHead?: string; onAsk?: (text: string) => void }) {
  return <article className={`cr-activity-item cr-activity-${row.kind}`} data-activity-id={`${row.kind}:${row.id}`}>
    <header>{row.kind === "comment" && locator && <CommentMenu row={row} locator={locator} onAsk={onAsk} />}<strong>{row.kind === "deployment" ? row.environment : row.kind === "commit" ? row.author?.login ?? "Git author" : row.actor?.login ?? "GitHub"}</strong><span>{row.kind === "commit" ? "committed" : row.kind === "opened" ? "opened this pull request" : row.kind === "review" ? `reviewed · ${row.verdict}` : row.kind === "event" ? row.event : row.kind === "deployment" ? `provider deployment · ${row.status}` : "issue comment"}</span><time dateTime={row.at}>{new Date(row.at).toLocaleString()}</time></header>
    {row.kind === "commit" && <p><code>{row.sha.slice(0, 8)}</code> {row.headline}</p>}
    {(row.kind === "comment" || row.kind === "review") && <><p className="cr-evidence">{row.kind === "comment" ? "Comment content · Links and status claims are supplied by the commenter, not verified deployment evidence." : `Submitted review · revision ${row.commit?.slice(0, 8) ?? "unknown"}`}</p><Markdown text={row.body} /></>}
    {row.kind === "deployment" && <p>Provider record · revision {row.commit.slice(0, 8)}{currentHead && row.commit !== currentHead ? " · Old revision" : ""} · <External url={row.url}>Open deployment</External></p>}
  </article>;
}

function elapsed(start: string | null, end: string): string {
  const seconds = start ? Math.floor((Date.parse(end) - Date.parse(start)) / 1000) : NaN;
  return Number.isFinite(seconds) && seconds >= 0 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "unknown";
}
function CommentMenu({ row, locator, onAsk }: { row: Extract<PrActivity, { kind: "comment" }>; locator: PrLocator; onAsk?: (text: string) => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const numeric = /^(?:comment-)?([1-9][0-9]*)$/.exec(row.id)?.[1];
  const base = prUrl(locator);
  const copy = async () => {
    if (!numeric || !base) return;
    try { await bridge.invoke("clipboard:write", { text: `${base}#issuecomment-${numeric}` }); setCopied(true); setOpen(false); anchor.current?.focus(); } catch { setCopied(false); }
  };
  return <span className="cr-comment-menu"><button className="btn" ref={anchor} type="button" aria-label="Comment actions" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(v => !v)}>⋯</button><Menu open={open} onClose={() => setOpen(false)} anchorRef={anchor} label="Comment actions" placement="bottom-end"><MenuItem disabled={!numeric || !base} onClick={() => void copy()}>Copy comment link</MenuItem><MenuItem disabled={!onAsk} onClick={() => { onAsk?.(row.body); setOpen(false); anchor.current?.focus(); }}>Add to chat</MenuItem></Menu><span className="sr-only" role="status">{copied ? "Comment link copied" : ""}</span></span>;
}
