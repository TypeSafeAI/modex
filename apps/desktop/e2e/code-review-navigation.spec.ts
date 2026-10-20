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
      const base = state.inbox[""] as unknown as Parameters<typeof rows>[0] & { state: string };
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
        const row = m && base.state !== "unavailable" ? rows(base as Parameters<typeof rows>[0]).find((r) => r.locator.owner === m[1] && r.locator.repo === m[2] && r.locator.number === Number(m[3])) : undefined;
        return row ? { state: "ready", value: { locator: row.locator, key: row.key }, fetchedAt: at } : { state: "unavailable", reason: "not-found", fetchedAt: at };
      }
      if (req.op === "overview" && req.key) {
        if (state.account && req.key.account !== state.account.id) return { state: "unavailable", reason: "signed-out", fetchedAt: at };
        const known = state.overview[keyId(req.key)];
        if (known) return known;
        const row = base.state !== "unavailable" ? rows(base as Parameters<typeof rows>[0]).find((r) => r.key && keyId(r.key) === keyId(req.key!)) : undefined;
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
});
