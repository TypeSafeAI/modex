import { useRef, useState, type ClipboardEvent, type KeyboardEvent, type Ref } from "react";
import { capabilities, inboxGroup, isEmpty, knownCount, parsePrLocator, prKeyId, type CodeReviewAccount, type CodeReviewConnection, type Inbox, type InboxGroup, type PrSummary, type ReadResult } from "../../shared/code-review.js";
import { SecretInput } from "../streamer";
import { ErrorNotice } from "../components/ui/ErrorNotice";
import { Icon } from "../components/ui/Icon";
import { IconButton } from "../components/ui/IconButton";
import { Menu, MenuItem } from "../components/ui/Menu";
import type { GroupPages } from "./model.js";
import type { Pin } from "./pins.js";
import { age, shortfallText, unavailableText } from "./text.js";

const GROUPS: { id: InboxGroup; label: string }[] = [{ id: "authored", label: "Authored by me" }, { id: "review-requested", label: "Needs my review" }];

interface Props {
  ref?: Ref<HTMLDivElement>;
  connection: ReadResult<CodeReviewConnection> | null;
  account: CodeReviewAccount | null;
  inbox: ReadResult<Inbox> | null;
  pages: GroupPages;
  query: string;
  now: number;
  busy: ReadonlySet<string>;
  resolveError: string | null;
  selectedId: string | null;
  pins: Pin[];
  onQuery: (text: string) => void;
  onResolve: (input: string) => void;
  onOpen: (row: PrSummary) => void;
  onOpenPin: (pin: Pin) => void;
  onRefresh: () => void;
  onRetryConnection: () => void;
  onRetryInbox: () => void;
  onShowMore: (group: InboxGroup, cursor: string) => void;
}

/**
 * The inbox (R1's left pane): search or paste a link, then the account's PRs in two groups. A missing
 * connection or a failed read says so, with a way out; it never looks like an empty inbox.
 */
export function InboxPane({ ref, connection, account, inbox, pages, query, now, busy, resolveError, selectedId, pins, onQuery, onResolve, onOpen, onOpenPin, onRefresh, onRetryConnection, onRetryInbox, onShowMore }: Props) {
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const link = parsePrLocator(query.trim());
  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text").trim();
    if (!parsePrLocator(text)) return;
    event.preventDefault();
    onQuery(text);
    onResolve(text);
  };
  // Arrow keys move between rows; Tab leaves the list.
  const moveFocus = (event: KeyboardEvent<HTMLElement>) => {
    const keys = { ArrowDown: 1, ArrowUp: -1 } as Record<string, number>;
    if (!(event.key in keys) && event.key !== "Home" && event.key !== "End") return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-key-id]"));
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, at + keys[event.key]!));
    rows[next]?.focus();
  };
  const tabbable = (id: string, first: boolean) => selectedId ? id === selectedId : first;
  let firstRow = true;
  const rowFor = (row: { key: PrSummary["key"]; locator: PrSummary["locator"]; title: string; meta: string; stack: boolean; open: () => void }) => {
    const id = prKeyId(row.key);
    const selected = id === selectedId;
    const focusable = tabbable(id, firstRow);
    firstRow = false;
    return <li key={id}>
      <button type="button" className={`cr-row${selected ? " selected" : ""}`} data-testid="code-review-row" data-key-id={id} data-pr={`${row.locator.owner}/${row.locator.repo}#${row.locator.number}`}
        aria-current={selected ? "true" : undefined} tabIndex={focusable ? 0 : -1} onClick={row.open}>
        <span className="cr-row-title">{row.title}</span>
        {row.stack && <span className="cr-row-stack" title="Its base is another branch, so it may be part of a stack (inferred)"><Icon name="stack" size={14} /><span className="sr-only">May be part of a stack (inferred from its base branch)</span></span>}
        <span className="cr-row-meta"><span className="sr-only">{`${row.locator.owner}/${row.locator.repo} #${row.locator.number}, `}</span>{row.meta}</span>
      </button>
    </li>;
  };

  const notConnected = connection && (connection.state === "unavailable" || connection.value.state !== "connected");
  return (
    <aside ref={ref} className="cr-inbox" data-testid="code-review-inbox" aria-label="Pull request inbox">
      <header className="cr-inbox-head">
        <h1 className="cr-inbox-title">Code Review</h1>
        <span className="cr-menu">
          <IconButton ref={menuRef} icon="more" label="Inbox actions" size="md" data-testid="code-review-inbox-menu" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} />
          <Menu open={menu} onClose={() => setMenu(false)} anchorRef={menuRef} label="Inbox actions" placement="bottom-end" testId="code-review-inbox-actions">
            <MenuItem data-testid="code-review-refresh" onClick={() => { setMenu(false); onRefresh(); }}>Refresh</MenuItem>
          </Menu>
        </span>
      </header>
      <form className="sidebar-search cr-search" role="search" onSubmit={(event) => { event.preventDefault(); if (link) onResolve(query.trim()); }}>
        <Icon name="search" size={14} />
        <SecretInput type="search" aria-label="Search or paste a PR link" placeholder="Search or paste a PR link" data-testid="code-review-search" value={query} disabled={!account}
          spellCheck={false} onChange={(event) => onQuery(event.target.value)} onPaste={paste} />
        {busy.has("resolve") || busy.has("inbox") ? <span className="spinner" role="status" aria-label="Loading" /> : null}
      </form>
      {link && !resolveError && <p className="cr-hint" data-testid="code-review-link-hint">Press Return to open {link.owner}/{link.repo} #{link.number}.</p>}
      {resolveError && <ErrorNotice className="cr-notice" testId="code-review-resolve-error" where="Code Review · open link" message={resolveError} onRetry={() => onResolve(query.trim())} />}
      <div className="cr-inbox-list" data-testid="code-review-inbox-list" onKeyDown={moveFocus}>
        {!connection && <p className="cr-hint" role="status">Checking GitHub CLI…</p>}
        {notConnected && <ErrorNotice className="cr-notice" testId="code-review-connection-error" where="Code Review · GitHub CLI"
          message={connection.state === "unavailable" ? unavailableText(connection) : connectionText(connection.value)} onRetry={onRetryConnection} />}
        {account && !inbox && <p className="cr-hint" role="status">Loading pull requests…</p>}
        {account && inbox?.state === "unavailable" && <ErrorNotice className="cr-notice" testId="code-review-inbox-error" where="Code Review · inbox" message={unavailableText(inbox)} onRetry={onRetryInbox} />}
        {account && inbox?.state === "stale" && <p className="cr-stale" role="status" data-testid="code-review-inbox-stale">
          {`Showing pull requests read at ${new Date(inbox.fetchedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. ${shortfallText(inbox.reason)}`} <button type="button" className="btn small" onClick={onRetryInbox}>Retry</button>
        </p>}
        {account && pins.length > 0 && <section className="cr-group" role="group" aria-label="Pinned">
          <h2 className="cr-group-label">Pinned</h2>
          <ul>{pins.map((pin) => rowFor({ key: pin.key, locator: pin.locator, title: pin.title, meta: `${pin.locator.repo} #${pin.locator.number}`, stack: false, open: () => onOpenPin(pin) }))}</ul>
        </section>}
        {account && inbox && inbox.state !== "unavailable" && GROUPS.map(({ id, label }) => {
          const base = inboxGroup(inbox, id);
          const page = pages[id];
          const rows = [...(base.state === "unavailable" ? [] : base.value), ...(page?.rows ?? [])];
          const latest = page && page.result.state !== "unavailable" ? page.result : base;
          const next = latest.state === "unavailable" ? null : latest.coverage?.next ?? null;
          const count = knownCount(latest.state === "unavailable" ? latest : { ...latest, value: rows });
          return <section key={id} className="cr-group" role="group" aria-label={label} data-testid={`code-review-group-${id}`}>
            <h2 className="cr-group-label">{label}</h2>
            {base.state === "unavailable" && <ErrorNotice className="cr-notice" where={`Code Review · ${label}`} message={unavailableText(base)} onRetry={onRetryInbox} />}
            {isEmpty(base) && !page && <p className="cr-hint" data-testid="code-review-group-empty">No pull requests.</p>}
            {rows.length > 0 && <ul>{rows.map((row) => rowFor({ key: row.key, locator: row.locator, title: row.title, meta: `${row.author.login} · ${age(row.updatedAt, now)}`, stack: row.stackHint === true, open: () => onOpen(row) }))}</ul>}
            {latest.state === "partial" && <p className="cr-stale" role="status">{`Some pull requests are missing. ${shortfallText(latest.reason)}`}</p>}
            {page?.result.state === "unavailable" && <ErrorNotice className="cr-notice" testId="code-review-page-error" where={`Code Review · ${label}`} message={unavailableText(page.result)} onRetry={() => onShowMore(id, page.cursor)} />}
            {next && <button type="button" className="cr-show-more" data-testid={`code-review-show-more-${id}`} disabled={busy.has(`page:${id}`)} onClick={() => onShowMore(id, next)}>
              {busy.has(`page:${id}`) ? "Loading…" : "Show more"}{count && count.exact ? <span className="sr-only">{` (${rows.length} of ${count.count})`}</span> : null}
            </button>}
          </section>;
        })}
      </div>
    </aside>
  );
}

/** What main said about gh, then what the person can do about it. */
function connectionText(connection: CodeReviewConnection): string {
  if (connection.state === "connected") return "";
  const read = capabilities(connection).read;
  const fix = read.available ? "" : read.reason;
  return connection.detail && connection.detail !== fix ? `${connection.detail} ${fix}`.trim() : fix;
}
