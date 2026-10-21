import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import { launch, resizeWindow, seedHome, tid } from "./support.js";
import { ACCOUNT_A, ACCOUNT_B, FAULTS, FIELD_GUIDE, key, LENDING, locator, NOW, R1, R4 } from "../test/fixtures/code-review.js";
import { prKeyId, type CodeReviewConnection, type Inbox, type PrOverview, type PrSummary, type ReadResult } from "../src/shared/code-review.js";

// CR-3 (#322): the Code Review inbox and workspace host, driven through main's real
// `code-review:read` channel. The handler is replaced here with one that serves the synthetic
// fixtures (docs/design/code-review.md, decision 6); no fixture code ships in the app.

interface Served {
  account: { host: "github.com"; id: string; login: string } | null;
  connection: ReadResult<CodeReviewConnection>;
  inbox: Record<string, ReadResult<Inbox>>;
  pages: Record<string, ReadResult<PrSummary[]>>;
  overview: Record<string, ReadResult<PrOverview>>;
  /** Requests matching one of these (`op` or `op:prKeyId`) wait until `release`. */
  hold: string[];
}

const ready = <T>(value: T): ReadResult<T> => ({ state: "ready", value, fetchedAt: NOW });
const LENDING_73 = prKeyId(key(ACCOUNT_A, LENDING, 73));
const FIELD_GUIDE_73 = prKeyId(key(ACCOUNT_A, FIELD_GUIDE, 73));
const FIELD_GUIDE_91 = prKeyId(key(ACCOUNT_A, FIELD_GUIDE, 91));

/** The rest of R1's 12 authored rows, for Show more: made up like the rest of the fixtures. */
const SECOND_PAGE: PrSummary[] = [
  { key: key(ACCOUNT_A, LENDING, 63), locator: locator(LENDING, 63), title: "Count renewals per member in the nightly report", state: "open", author: { login: "ada-fixture", id: "1001", bot: false }, updatedAt: "2026-10-18T18:30:00Z", stackHint: false },
  { key: key(ACCOUNT_A, FIELD_GUIDE, 80), locator: locator(FIELD_GUIDE, 80), title: "Link each branch page to its accessibility notes", state: "draft", author: { login: "ada-fixture", id: "1001", bot: false }, updatedAt: "2026-10-18T17:55:00Z", stackHint: null },
  { key: key(ACCOUNT_A, LENDING, 61), locator: locator(LENDING, 61), title: "Track the lending rework", state: "open", author: { login: "ada-fixture", id: "1001", bot: false }, updatedAt: "2026-10-18T17:20:00Z", stackHint: false },
];

function served(): Served {
  return {
    account: ACCOUNT_A,
    connection: R1.connection,
    inbox: { "": R1.inbox },
    pages: { "authored:cGFnZTI": { state: "ready", value: SECOND_PAGE, fetchedAt: NOW, coverage: { loaded: 12, total: 12, complete: true, next: null } } },
    overview: { [LENDING_73]: ready(R1.overview), [FIELD_GUIDE_91]: ready(R4.overview) },
    hold: [],
  };
}

/** Installs the fixture handler in main. State lives on `globalThis.__codeReview` so tests can change it. */
async function serve(app: ElectronApplication, data: Served): Promise<void> {
  await app.evaluate(({ ipcMain }, data) => {
    type Req = { op: string; requestId: string; key?: { account: string; host: string; repoId: string; number: number }; revision?: unknown; query?: string; group?: string; cursor?: string; input?: string };
    const g = globalThis as unknown as { __codeReview: { state: typeof data; log: Req[]; held: { match: string; release: () => void }[] } };
    g.__codeReview = { state: data, log: [], held: [] };
    const keyId = (k: NonNullable<Req["key"]>) => `${k.host}/${k.account}/${k.repoId}/${k.number}`;
    const rows = (inbox: { groups: Record<string, { state: string; value?: { key: Req["key"]; locator: { owner: string; repo: string; number: number }; title: string; state: string; author: unknown; updatedAt: string }[] }> }) =>
      Object.values(inbox.groups).flatMap((group) => group.value ?? []);
    const answer = (req: Req) => {
      const { state } = g.__codeReview;
      const at = state.connection.fetchedAt;
      if (req.op === "connection") return state.connection;
      const base = state.inbox[""] as unknown as { state: string; value?: Parameters<typeof rows>[0] };
      const known = () => base.value ? rows(base.value) : [];
      if (req.op === "inbox") {
        const known = state.inbox[req.query ?? ""];
        if (known) return known;
        // Any other query filters R1's rows by title, the way a search narrows them.
        const q = (req.query ?? "").toLowerCase();
        const value = (state.inbox[""] as { value: { groups: Record<string, { value: { title: string }[] }> } }).value;
        const groups = Object.fromEntries(Object.entries(value.groups).map(([name, group]) => {
          const found = (group.value ?? []).filter((row) => row.title.toLowerCase().includes(q));
          return [name, { state: "ready", value: found, fetchedAt: at, coverage: { loaded: found.length, total: found.length, complete: true, next: null } }];
        }));
        return { state: "ready", value: { account: state.account?.id ?? "", query: req.query, groups }, fetchedAt: at };
      }
      if (req.op === "inbox-page") return state.pages[`${req.group}:${req.cursor}`] ?? { state: "unavailable", reason: "failed", fetchedAt: at };
      if (req.op === "resolve") {
        const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(req.input ?? "") ?? /^([^/#]+)\/([^/#]+)#(\d+)$/.exec(req.input ?? "");
        const row = m ? known().find((r) => r.locator.owner === m[1] && r.locator.repo === m[2] && r.locator.number === Number(m[3])) : undefined;
        return row ? { state: "ready", value: { locator: row.locator, key: row.key }, fetchedAt: at } : { state: "unavailable", reason: "not-found", fetchedAt: at };
      }
      if (req.op === "overview" && req.key) {
        if (state.account && req.key.account !== state.account.id) return { state: "unavailable", reason: "signed-out", fetchedAt: at };
        const known = state.overview[keyId(req.key)];
        if (known) return known;
        const row = known().find((r) => r.key && keyId(r.key) === keyId(req.key!));
        if (!row) return { state: "unavailable", reason: "not-found", fetchedAt: at };
        return { state: "ready", fetchedAt: at, value: { key: row.key, locator: { host: "github.com", ...row.locator }, revision: { baseRef: "main", baseSha: "a".repeat(40), headSha: "b".repeat(40) }, title: row.title, body: "", state: row.state, author: row.author, createdAt: row.updatedAt, updatedAt: row.updatedAt, headRef: "fixture-branch", headRepo: null, totals: { files: 2, additions: 5, deletions: 1, commits: 1 }, reviewers: [], comments: 0 } };
      }
      return { state: "unavailable", reason: "failed", fetchedAt: at };
    };
    ipcMain.removeHandler("code-review:read");
    ipcMain.handle("code-review:read", async (_event, req: Req) => {
      const self = g.__codeReview;
      self.log.push(req);
      if (req.op === "cancel") return null;
      const scope = { account: req.key ? req.key.account : self.state.account?.id ?? null, key: req.key ?? null, revision: req.revision ?? null };
      const match = [req.op, req.key ? `${req.op}:${keyId(req.key)}` : `${req.op}:${req.query ?? ""}`];
      if (self.state.hold.some((h) => match.includes(h))) await new Promise<void>((release) => self.held.push({ match: match.find((m) => self.state.hold.includes(m))!, release }));
      return { requestId: req.requestId, op: req.op, scope, result: answer(req) };
    });
  }, data);
}

async function change(app: ElectronApplication, patch: Partial<Served>): Promise<void> {
  await app.evaluate((_electron, patch) => { Object.assign((globalThis as unknown as { __codeReview: { state: object } }).__codeReview.state, patch); }, patch);
}

async function release(app: ElectronApplication, match: string): Promise<void> {
  await app.evaluate((_electron, match) => {
    const g = (globalThis as unknown as { __codeReview: { held: { match: string; release: () => void }[]; state: { hold: string[] } } }).__codeReview;
    g.state.hold = g.state.hold.filter((h) => h !== match);
    for (const h of g.held.filter((h) => h.match === match)) h.release();
    g.held = g.held.filter((h) => h.match !== match);
  }, match);
}

const log = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __codeReview: { log: { op: string; requestId: string; query?: string; key?: { repoId: string; number: number } }[] } }).__codeReview.log);

/** Waits until replies main has already sent have reached the renderer: IPC answers arrive in order. */
const settle = (p: Page) => p.evaluate(() => window.modex!.invoke("code-review:read", { op: "connection", requestId: "settle" }));

let home: string, repo: string, app: ElectronApplication, page: Page;

/** Launches with the fixtures served and the destination switched on (it is hidden in built apps). */
async function open(data: Served = served()): Promise<void> {
  ({ home, repo } = seedHome());
  ({ app, page } = await launch(home));
  await serve(app, data);
  await page.evaluate(() => localStorage.setItem("modex.codeReview", "on"));
  await page.reload();
  await expect(tid(page, "rail-code-review")).toBeVisible();
}

test.afterEach(async () => {
  await app?.close();
  for (const dir of [home, repo]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const row = (p: Page, owner: string, repoName: string, n: number) => p.locator(`[data-testid="code-review-row"][data-pr="${owner}/${repoName}#${n}"]`);

test("the rail opens the inbox, and a row opens its PR with the PR and Changes tabs (R1)", async () => {
  await open();
  await tid(page, "rail-code-review").click();
  await expect(tid(page, "rail-code-review")).toHaveAttribute("aria-current", "page");
  const inbox = tid(page, "code-review-inbox");
  await expect(inbox.getByRole("heading", { name: "Code Review" })).toBeVisible();
  await expect(inbox.getByRole("group", { name: "Authored by me" })).toBeVisible();
  await expect(inbox.getByRole("group", { name: "Needs my review" })).toBeVisible();
  await expect(row(page, "example-org", "lending", 73)).toContainText(R1.overview.title);
  await row(page, "example-org", "lending", 73).click();
  await expect(row(page, "example-org", "lending", 73)).toHaveAttribute("aria-current", "true");
  const prTab = tid(page, "code-review-tab-overview");
  await expect(prTab).toHaveAttribute("aria-selected", "true");
  await expect(prTab).toContainText(R1.overview.title);
  await expect(tid(page, "code-review-tab-changes")).toContainText("+8,912");
  await expect(tid(page, "code-review-tab-changes")).toContainText("−47");
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #73");
  await expect(tid(page, "code-review-pr-id").first()).toHaveAttribute("title", "example-org/lending #73");
});

test("captures the R1 and R4 arrangements at the references' CSS sizes", async ({}, testInfo) => {
  await open();
  await tid(page, "rail-code-review").click();
  await resizeWindow(app, page, 1766, 1057);
  await row(page, "example-org", "lending", 73).click();
  await expect(tid(page, "code-review-tab-changes")).toContainText("+8,912");
  await page.screenshot({ path: testInfo.outputPath("code-review-r1.png"), animations: "disabled" });
  await resizeWindow(app, page, 1764, 1047);
  await row(page, "example-org", "field-guide", 91).click();
  await tid(page, "code-review-split-toggle").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview changes");
  await page.screenshot({ path: testInfo.outputPath("code-review-r4.png"), animations: "disabled" });
  await resizeWindow(app, page, 900, 600);
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", /^(overview|changes)$/);
  await page.screenshot({ path: testInfo.outputPath("code-review-narrow.png"), animations: "disabled" });
  await change(app, { account: null, connection: ready<CodeReviewConnection>({ state: "signed-out", detail: "Not signed in to GitHub CLI." }) });
  await tid(page, "code-review-inbox-menu").click();
  await tid(page, "code-review-refresh").click();
  await expect(tid(page, "code-review-connection-error")).toBeVisible();
  await resizeWindow(app, page, 1440, 900);
  await page.screenshot({ path: testInfo.outputPath("code-review-signed-out.png"), animations: "disabled" });
});

test("identical PR numbers in two repositories never show each other's answer, however late it arrives (AC2)", async () => {
  const data = served();
  data.overview[FIELD_GUIDE_73] = ready({ ...R4.overview, key: key(ACCOUNT_A, FIELD_GUIDE, 73), locator: locator(FIELD_GUIDE, 73), title: "Fix the broken anchors on the opening-hours page", totals: { files: 1, additions: 3, deletions: 2, commits: 1 } });
  data.hold = [`overview:${LENDING_73}`];
  await open(data);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await tid(page, "rail-code-review").click();
  await row(page, "example-org", "lending", 73).click();
  await expect(tid(page, "code-review-loading").first()).toBeVisible();
  await expect(tid(page, "code-review-loading").first()).toHaveCSS("animation-name", "none");
  await row(page, "example-org", "field-guide", 73).click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("field-guide #73");
  await expect(tid(page, "code-review-tab-changes")).toContainText("+3");
  await release(app, `overview:${LENDING_73}`);
  await settle(page);
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("field-guide #73");
  await expect(tid(page, "code-review-tab-changes")).not.toContainText("8,912");
  await expect(row(page, "example-org", "field-guide", 73)).toHaveAttribute("aria-current", "true");
  await expect(row(page, "example-org", "lending", 73)).not.toHaveAttribute("aria-current", "true");
  // The late answer was for #73 in lending, and that is where it shows.
  await tid(page, "nav-back").click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #73");
  await expect(tid(page, "code-review-tab-changes")).toContainText("+8,912");
});

test("a slow search answer never replaces a newer one, and typing reads only where it pauses (AC2)", async () => {
  const data = served();
  data.hold = ["inbox:hold"];
  await open(data);
  await tid(page, "rail-code-review").click();
  await expect(row(page, "example-org", "lending", 73)).toBeVisible();
  const search = tid(page, "code-review-search");
  await search.fill("hold");
  await expect.poll(async () => (await log(app)).filter((r) => r.op === "inbox" && r.query === "hold").length).toBe(1);
  await search.fill("");
  await search.pressSequentially("loan", { delay: 40 });
  await expect(row(page, "example-org", "field-guide", 91)).toHaveCount(0);
  await expect(row(page, "example-org", "lending", 73)).toBeVisible();
  await release(app, "inbox:hold");
  await settle(page);
  // "hold" would bring back field-guide #91 ("…a moved hold's place…"); its answer was superseded.
  await expect(row(page, "example-org", "field-guide", 91)).toHaveCount(0);
  const requests = await log(app);
  const held = requests.find((r) => r.op === "inbox" && r.query === "hold")!;
  expect(requests.some((r) => r.op === "cancel" && r.requestId === held.requestId)).toBe(true);
  expect(requests.filter((r) => r.op === "inbox").map((r) => r.query)).toEqual(["", "hold", "loan"]);
});

test("switching the gh account during a slow read drops its answer and every PR of the old account (AC2)", async () => {
  const data = served();
  data.hold = [`overview:${FIELD_GUIDE_91}`];
  await open(data);
  await tid(page, "rail-code-review").click();
  await row(page, "example-org", "lending", 73).click();
  await expect(tid(page, "code-review-tab-changes")).toContainText("+8,912");
  await row(page, "example-org", "field-guide", 91).click();
  await expect(tid(page, "code-review-loading").first()).toBeVisible();
  // gh is now signed in as another account, which has no pull requests.
  await change(app, {
    account: ACCOUNT_B,
    connection: ready<CodeReviewConnection>({ state: "connected", account: ACCOUNT_B }),
    inbox: { "": ready<Inbox>({ account: ACCOUNT_B.id, query: "", groups: { authored: ready<PrSummary[]>([]), "review-requested": ready<PrSummary[]>([]) } }) },
  });
  await tid(page, "code-review-inbox-menu").click();
  await tid(page, "code-review-refresh").click();
  await expect(tid(page, "code-review-group-empty")).toHaveCount(2);
  await expect(tid(page, "code-review-empty")).toBeVisible();
  await release(app, `overview:${FIELD_GUIDE_91}`);
  await settle(page);
  await expect(tid(page, "code-review-tabbar").getByRole("tab")).toHaveCount(0);
  await expect(page.getByText(R4.overview.title)).toHaveCount(0);
  await expect(tid(page, "nav-back")).toBeDisabled();
  const requests = await log(app);
  const pending = requests.filter((r) => r.op === "overview" && r.key?.number === 91).map((r) => r.requestId);
  expect(pending.every((id) => requests.some((r) => r.op === "cancel" && r.requestId === id))).toBe(true);
});

test("back and forward return to each PR as it was left without reading it again; closing tabs keeps focus (AC2, C80)", async () => {
  await open();
  await tid(page, "rail-code-review").click();
  await row(page, "example-org", "lending", 73).click();
  await tid(page, "code-review-tab-changes").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "changes");
  await row(page, "example-org", "field-guide", 91).click();
  await tid(page, "code-review-split-toggle").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview changes");
  const reads = (await log(app)).filter((r) => r.op === "overview").length;
  await tid(page, "nav-back").click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #73");
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "changes");
  await expect(tid(page, "code-review-tab-changes")).toHaveAttribute("aria-selected", "true");
  await tid(page, "nav-forward").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview changes");
  expect((await log(app)).filter((r) => r.op === "overview").length).toBe(reads);
  // The inbox toggle hides and restores the inbox, keeping the selection (C03).
  await tid(page, "sidebar-toggle").click();
  await expect(tid(page, "code-review-inbox")).toHaveCount(0);
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("field-guide #91");
  await tid(page, "sidebar-toggle").click();
  await expect(row(page, "example-org", "field-guide", 91)).toHaveAttribute("aria-current", "true");
  // Closing Changes keeps the PR tab and moves focus to it; closing the PR returns focus to its row.
  await tid(page, "code-review-close-changes").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview");
  await expect(tid(page, "code-review-tab-changes")).toHaveCount(0);
  await expect(tid(page, "code-review-tab-overview")).toBeFocused();
  await tid(page, "code-review-split-toggle").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview changes");
  await tid(page, "code-review-close-overview").click();
  await expect(tid(page, "code-review-empty")).toBeVisible();
  await expect(row(page, "example-org", "field-guide", 91)).toBeFocused();
  await tid(page, "nav-back").click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("field-guide #91");
  // Leaving the surface and coming back keeps all of it.
  await tid(page, "rail-chat").click();
  await expect(tid(page, "code-review")).toBeHidden();
  await tid(page, "rail-code-review").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview changes");
});

test("no gh, signed out, offline, empty, denied and failed reads each say what happened, never an empty inbox (#322 item 2)", async () => {
  const data = served();
  data.account = null;
  data.connection = ready(FAULTS.noCli);
  await open(data);
  await tid(page, "rail-code-review").click();
  const connection = tid(page, "code-review-connection-error");
  await expect(connection).toContainText("GitHub CLI (gh) was not found.");
  await expect(page.getByRole("group", { name: "Authored by me" })).toHaveCount(0);
  await expect(tid(page, "code-review-search")).toBeDisabled();
  await change(app, { connection: ready<CodeReviewConnection>({ state: "signed-out", detail: "Not signed in to GitHub CLI." }) });
  await connection.getByTestId("error-retry").click();
  await expect(connection).toContainText("Not signed in to GitHub CLI.");
  await expect(tid(page, "code-review-group-empty")).toHaveCount(0);
  // Offline: the earlier inbox is shown, marked with when it was read and why.
  await change(app, { account: ACCOUNT_A, connection: R1.connection, inbox: { "": FAULTS.offline } });
  await connection.getByTestId("error-retry").click();
  await expect(tid(page, "code-review-inbox-stale")).toContainText("GitHub couldn't be reached.");
  await expect(row(page, "example-org", "lending", 73)).toBeVisible();
  const refresh = async () => { await tid(page, "code-review-inbox-menu").click(); await tid(page, "code-review-refresh").click(); };
  await change(app, { inbox: { "": FAULTS.emptyInbox } });
  await refresh();
  await expect(tid(page, "code-review-group-empty")).toHaveCount(2);
  await change(app, { inbox: { "": FAULTS.signedOut } });
  await refresh();
  await expect(tid(page, "code-review-inbox-error")).toContainText("Not signed in to GitHub CLI.");
  await expect(tid(page, "code-review-group-empty")).toHaveCount(0);
  // A PR this account can't see says so in its pane, with Retry.
  await change(app, { inbox: { "": R1.inbox }, overview: { [FIELD_GUIDE_91]: FAULTS.denied } });
  await refresh();
  await row(page, "example-org", "field-guide", 91).click();
  await expect(tid(page, "code-review-overview-error")).toContainText("This account can't see that repository.");
  // The second page fails, then loads on Retry.
  await change(app, { pages: { "authored:cGFnZTI": { state: "unavailable", reason: "rate-limited", fetchedAt: NOW } } });
  await tid(page, "code-review-show-more-authored").click();
  await expect(tid(page, "code-review-page-error")).toContainText("GitHub's rate limit was reached.");
  await expect(row(page, "example-org", "lending", 73)).toBeVisible();
  await change(app, { pages: served().pages });
  await tid(page, "code-review-page-error").getByTestId("error-retry").click();
  await expect(row(page, "example-org", "lending", 63)).toBeVisible();
  await expect(tid(page, "code-review-show-more-authored")).toHaveCount(0);
});

test("pin, copy and Open in GitHub use the canonical link, a pasted link opens its PR, and nothing reaches local Discard (C24–C26, AC5)", async () => {
  await open();
  await app.evaluate(({ shell, ipcMain }) => {
    const g = globalThis as unknown as { __opened: string[]; __reverts: number };
    g.__opened = []; g.__reverts = 0;
    shell.openExternal = async (url: string) => { g.__opened.push(url); };
    ipcMain.removeHandler("changes:revert");
    ipcMain.handle("changes:revert", () => { g.__reverts += 1; });
  });
  await tid(page, "rail-code-review").click();
  await expect(row(page, "example-org", "lending", 73)).toBeVisible();
  await tid(page, "code-review-search").evaluate((input) => {
    const data = new DataTransfer();
    data.setData("text", "https://github.com/example-org/field-guide/pull/91");
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("field-guide #91");
  await expect(tid(page, "code-review-search")).toHaveValue("");
  await tid(page, "code-review-search").fill("example-org/lending#73");
  await expect(tid(page, "code-review-link-hint")).toContainText("example-org/lending #73");
  await tid(page, "code-review-search").press("Enter");
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #73");
  await tid(page, "code-review-search").fill("https://github.com/example-org/lending/pull/999");
  await tid(page, "code-review-search").press("Enter");
  await expect(tid(page, "code-review-resolve-error")).toContainText("It wasn't found, or this account can't see it.");
  expect((await log(app)).filter((r) => r.op === "inbox").map((r) => r.query)).toEqual([""]);
  await tid(page, "code-review-search").fill("");
  await tid(page, "code-review-copy-link").first().click();
  await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe("https://github.com/example-org/lending/pull/73");
  await tid(page, "code-review-open-github").first().click();
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)).toEqual(["https://github.com/example-org/lending/pull/73"]);
  await tid(page, "code-review-pin").first().click();
  await expect(tid(page, "code-review-pin").first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("group", { name: "Pinned" })).toContainText(R1.overview.title);
  // Unavailable actions are focusable, say why, and do nothing.
  const merge = tid(page, "code-review-merge").first();
  await expect(merge).toHaveAttribute("aria-disabled", "true");
  await tid(page, "code-review-instructions").first().focus();
  await page.keyboard.press("Tab");
  await expect(merge).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText("Merging from Modex isn't available yet.");
  await expect(merge).toHaveAccessibleDescription("Merging from Modex isn't available yet. Open the pull request on GitHub to merge.");
  const asked = (await log(app)).length;
  await merge.dispatchEvent("click");
  await settle(page);
  expect((await log(app)).filter((r) => r.requestId !== "settle").length).toBe(asked);
  await expect(tid(page, "code-review-review").first()).toHaveAttribute("aria-disabled", "true");
  await expect(tid(page, "code-review-new-tab").first()).toHaveAttribute("aria-disabled", "true");
  // Pins outlive a reload, per account, and open their PR.
  await page.reload();
  await tid(page, "rail-code-review").click();
  const pinned = page.getByRole("group", { name: "Pinned" });
  await expect(pinned).toContainText(R1.overview.title);
  await pinned.getByTestId("code-review-row").click();
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #73");
  await expect(tid(page, "code-review").locator('[data-testid="changes-revert"]')).toHaveCount(0);
  expect(await app.evaluate(() => (globalThis as unknown as { __reverts: number }).__reverts)).toBe(0);
});

test("keyboard alone works at 1440×900 and 900×600; the split folds and resized panes persist within the window (AC3, AC4)", async () => {
  await open();
  await resizeWindow(app, page, 1440, 900);
  await tid(page, "rail-code-review").click();
  await row(page, "example-org", "field-guide", 91).click();
  await tid(page, "code-review-split-toggle").click();
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", "overview changes");
  const divider = page.getByRole("separator", { name: "Resize the pull request pane" });
  const before = Number(await divider.getAttribute("aria-valuenow"));
  await divider.focus();
  await page.keyboard.press("Shift+ArrowRight");
  await expect(divider).toHaveAttribute("aria-valuenow", String(before + 32));
  await page.reload();
  await tid(page, "rail-code-review").click();
  await row(page, "example-org", "field-guide", 91).click();
  await tid(page, "code-review-split-toggle").click();
  await expect(page.getByRole("separator", { name: "Resize the pull request pane" })).toHaveAttribute("aria-valuenow", String(before + 32));
  // Narrow: the split shows one pane, and both tabs still reach theirs.
  await resizeWindow(app, page, 900, 600);
  await expect(tid(page, "code-review-workspace")).toHaveAttribute("data-panes", /^(overview|changes)$/);
  await expect(tid(page, "code-review-tab-overview")).toBeVisible();
  await expect(tid(page, "code-review-tab-changes")).toBeVisible();
  for (const id of ["code-review-pin", "code-review-copy-link", "code-review-open-github", "code-review-review", "code-review-instructions", "code-review-merge", "code-review-split-toggle", "code-review-inbox-menu", "code-review-search"]) {
    const box = (await tid(page, id).first().boundingBox())!;
    expect(box, id).toBeTruthy();
    expect(box.x >= 0 && box.x + box.width <= 900 && box.y >= 0 && box.y + box.height <= 600, `${id} inside 900×600`).toBe(true);
  }
  // The rows: Tab reaches the selected one, arrows move, Enter opens.
  await tid(page, "code-review-search").focus();
  await page.keyboard.press("Tab");
  await expect(row(page, "example-org", "field-guide", 91)).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(row(page, "example-org", "lending", 70)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tid(page, "code-review-pr-id").first()).toHaveText("lending #70");
  // Tabs: arrows switch between the PR and Changes.
  await tid(page, "code-review-tab-overview").focus();
  await page.keyboard.press("ArrowRight");
  await expect(tid(page, "code-review-tab-changes")).toBeFocused();
  await expect(tid(page, "code-review-pane-changes")).toBeVisible();
  // The tree sits beside the diff, or behind a toggle when Changes has no room for both.
  const toggle = tid(page, "code-review-files-toggle");
  if (await toggle.count()) {
    await toggle.click();
    await expect(tid(page, "code-review-tree")).toBeVisible();
    await expect(tid(page, "code-review-diff")).toBeHidden();
  } else await expect(tid(page, "code-review-tree")).toBeVisible();
  // Menus close on Escape and give focus back.
  await tid(page, "code-review-inbox-menu").click();
  await expect(tid(page, "code-review-refresh")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(tid(page, "code-review-inbox-menu")).toBeFocused();
  // The inbox scrolls on its own: nothing else moves.
  const list = tid(page, "code-review-inbox-list");
  await list.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await tid(page, "code-review-diff").evaluate((el) => el.scrollTop)).toBe(0);
  expect(await tid(page, "sheet").evaluate((el) => el.scrollTop)).toBe(0);
  expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
});

test("independently stale inbox groups show their read time and retry", async () => {
  const data = served();
  if (R1.inbox.state === "unavailable") throw new Error("fixture missing");
  const first = R1.inbox.value.groups.authored;
  if (first.state === "unavailable") throw new Error("fixture missing");
  data.inbox[""] = ready({ ...R1.inbox.value, groups: {
    ...R1.inbox.value.groups,
    authored: { ...first, state: "stale", reason: "offline" },
  } });
  await open(data);
  await tid(page, "rail-code-review").click();
  const group = tid(page, "code-review-group-authored");
  await expect(group).toContainText("Showing pull requests read at");
  await expect(group).toContainText("GitHub couldn't be reached.");
  await expect(group.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  await expect(tid(page, "code-review-group-review-requested")).not.toContainText("GitHub couldn't be reached.");
  await change(app, { inbox: { "": R1.inbox } });
  await group.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(group).not.toContainText("Showing pull requests read at");
});

test("pagination deduplicates the first-page boundary and retains earlier stale page evidence", async () => {
  const data = served();
  if (R1.inbox.state === "unavailable") throw new Error("fixture missing");
  const first = R1.inbox.value.groups.authored;
  if (first.state === "unavailable") throw new Error("fixture missing");
  data.pages = {
    "authored:cGFnZTI": { state: "stale", reason: "offline", fetchedAt: NOW,
      value: [first.value[0]!, SECOND_PAGE[0]!], coverage: { loaded: 2, total: 12, complete: false, next: "page3" } },
    "authored:page3": { state: "ready", fetchedAt: NOW, value: SECOND_PAGE.slice(1),
      coverage: { loaded: 2, total: 12, complete: true, next: null } },
  };
  await open(data);
  await tid(page, "rail-code-review").click();
  await row(page, "example-org", "lending", 73).click();
  await tid(page, "code-review-show-more-authored").click();
  const group = tid(page, "code-review-group-authored");
  await expect(group.getByTestId("code-review-row")).toHaveCount(first.value.length + 1);
  await expect(row(page, "example-org", "lending", 73)).toHaveAttribute("aria-current", "true");
  await expect(group).toContainText("GitHub couldn't be reached.");
  await tid(page, "code-review-show-more-authored").click();
  await expect(group.getByTestId("code-review-row")).toHaveCount(first.value.length + SECOND_PAGE.length);
  await expect(group).toContainText("GitHub couldn't be reached.");
  await expect(group.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
});

test("an earlier failed page retry stays visible after a later page succeeds", async () => {
  const data = served();
  data.pages = {
    "authored:cGFnZTI": { state: "stale", reason: "offline", fetchedAt: NOW, value: [SECOND_PAGE[0]!], coverage: { loaded: 1, total: 12, complete: false, next: "page3" } },
    "authored:page3": { state: "stale", reason: "offline", fetchedAt: NOW, value: [SECOND_PAGE[1]!], coverage: { loaded: 1, total: 12, complete: false, next: "page4" } },
    "authored:page4": { state: "ready", fetchedAt: NOW, value: [SECOND_PAGE[2]!], coverage: { loaded: 1, total: 12, complete: true, next: null } },
  };
  await open(data);
  await tid(page, "rail-code-review").click();
  await tid(page, "code-review-show-more-authored").click();
  await expect(row(page, "example-org", "lending", 63)).toBeVisible();
  await tid(page, "code-review-show-more-authored").click();
  await expect(row(page, "example-org", "field-guide", 80)).toBeVisible();
  await change(app, { pages: { ...data.pages, "authored:cGFnZTI": { state: "unavailable", reason: "rate-limited", fetchedAt: NOW } } });
  await tid(page, "code-review-group-authored").getByRole("button", { name: "Retry", exact: true }).first().click();
  await expect(tid(page, "code-review-page-error")).toContainText("GitHub's rate limit was reached.");
  await tid(page, "code-review-show-more-authored").click();
  await expect(row(page, "example-org", "lending", 61)).toBeVisible();
  await expect(tid(page, "code-review-page-error")).toContainText("GitHub's rate limit was reached.");
  await expect(tid(page, "code-review-page-error").getByTestId("error-retry")).toBeVisible();
});
