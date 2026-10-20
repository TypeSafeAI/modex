# Code Review workspace

A Code Review destination in Modex desktop: a PR inbox, an overview with activity, checks and stack,
and a revision-bound remote diff with a file tree. It is reconstructed from four reference
screenshots (R1–R4). The work is tracked in [#319](https://github.com/TypeSafeAI/modex/issues/319).
This page is CR-1's contract ([#320](https://github.com/TypeSafeAI/modex/issues/320)). Every later
slice works against it.

**Nothing here has shipped.** CR-1 adds a pure read contract, synthetic fixtures and this page. It
registers no IPC channel, draws no UI and makes no GitHub request. The rest of Gate A follows in
order:

- [#321](https://github.com/TypeSafeAI/modex/issues/321): the read service.
- [#322](https://github.com/TypeSafeAI/modex/issues/322): the inbox and the workspace.
- [#323](https://github.com/TypeSafeAI/modex/issues/323): the overview.
- [#324](https://github.com/TypeSafeAI/modex/issues/324): the diffs.

Gate A also includes [#327](https://github.com/TypeSafeAI/modex/issues/327)'s tests for those slices.
AI review ([#325](https://github.com/TypeSafeAI/modex/issues/325)) and GitHub writes
([#326](https://github.com/TypeSafeAI/modex/issues/326)) are later gates.

- Contract: `apps/desktop/src/shared/code-review.ts`.
- Fixtures: `apps/desktop/test/fixtures/code-review.ts`.
- Tests: `apps/desktop/test/code-review-contract.test.ts`. They also check that this page's reference
  manifest and control inventory stay in step with the fixtures.

## Decisions

Val confirmed these in a planning session on 2026-10-19. That session posted them on #320 at Val's
direction ([comment](https://github.com/TypeSafeAI/modex/issues/320#issuecomment-6278869439)), so the
comment is the session's record of Val's answer, not Val's own words:

1. **Placement: Modex desktop.** The workspace lives in `apps/desktop`, inside the existing shell. It
   does not go in River Oaks, TypeSafe Place or TypeSafe Computer. The PRs in the screenshots are only
   the content being reviewed.
2. **References stay out of the repository.** R1–R4 are on Val's Mac (see the
   [manifest](#references-and-calibration)). Neither the images nor what they show (real PR text,
   names, avatars) is committed. Fixtures are synthetic and match the references' density, not their
   content.
3. **GitHub reads use the user's `gh` CLI login.** This is the path
   `apps/desktop/src/main/engine/thread-context.ts` already takes for a checkout's PR status: github.com
   only, fixed endpoints, `gh api … --method GET`. There is no new sign-in, no GitHub App, and Modex
   stores no token. Writes are #326's and keep their own gate. The GitHub App item under
   `docs/status.md`'s Next is about acting on repositories and is unchanged.

The contract adds these engineering decisions:

4. **One local-only channel.** CR-2 registers a single `code-review:read` channel through
   `handle(…, { localOnly: true })` in `src/main/index.ts`. Paired desktops can't reach it, and it gets
   the existing trusted-sender and document-epoch check. Main passes every payload through
   `validateRequest` before anything else. The renderer never sends a URL, an endpoint, shell text, a
   local path or an AbortSignal; cancellation names a request id. Every path segment main builds into
   an endpoint is encoded with `encodeURIComponent`, and #321 tests it.
5. **Replies carry their request's scope.** `scopeOf(request, account)` is the request's own key and
   revision (null where the operation takes none) and the key's account. Main stamps each reply with
   the scope of the request it answers, and the renderer keeps the scope of what it asked. It applies
   a reply only through `acceptsReply`, so a slow answer for another account, another repository with
   the same PR number, or an old head is dropped. An overview names no revision; its value carries
   the one it was read at. `connection` matches by request id alone, since it is what names the
   account.
6. **E2E feeds fixtures through main's handler.** Playwright replaces the `code-review:read` handler
   with `app.evaluate(({ ipcMain }) => …)`, the pattern `e2e/sidebar-details.spec.ts` uses for
   `thread:context`, and serves these fixtures. No fixture code ships in the app (`dist/test` is
   outside electron-builder's `files`).
7. **Remote content never becomes local authority.** PR paths, patches and names are display data.
   The remote diff reuses only `Diff` and `FileIcon` from `ChangesPanel.tsx`. It never reaches
   `onRevert`, `changes:revert` or any `git.ts` function.

The [open decisions](#open-decisions) list what still needs Val. Until each is decided, its control is
shown unavailable.

## Source map

The extension points, checked on `main` at `9c0b063` (paths under `apps/desktop/`):

| Need | Where | What it means for Code Review |
| --- | --- | --- |
| Destination | `src/renderer/App.tsx:86` `surface` union; `.sheet` view switch at `:898` | Add a `"code-review"` surface. The title bar and workspace are gated on `surface === "chat"` (`:878`, `:993`), and the sidebar resize handle on chat or space (`:899`); Code Review brings its own. |
| Icon rail | `src/renderer/components/Rail.tsx:17` | Add an `onOpenCodeReview` button. Its `surface` prop repeats the union. |
| Tabs | `src/renderer/components/Workspace.tsx:15` `Tab` kinds; tabs are in memory and reset per thread (`App.tsx:992`) | Code Review needs its own PR and Changes tabs, kept per PR key. The thread workspace's tabs are not reused. |
| Back / forward | `src/renderer/history.ts:8` `useSelectionHistory` (in memory) | Reuse the pattern for PR selection history. |
| Theme tokens | `src/renderer/tokens.css`: `--bg-*`, `--border-pane`, `--text-1..4`, `--accent*`, `--ok`/`--warn`/`--danger`, `--add`/`--del` and their `-bg` pairs | No new tokens are needed for Gate A. `styles.css` aliases are legacy. |
| Bridge | `src/shared/types.ts:445` `ModexBridge`, `:515` `BridgeCommands`; `src/main/preload.cjs:127` `invoke` | `"code-review:read": { req: CodeReviewRequest; res: CodeReviewReply }`. |
| IPC registration | `src/main/index.ts:389` `handle()`, with the trusted-sender check at `:397` (`isTrustedTerminalSender`, `engine/terminal.ts:139`) | The boundary does no payload validation; `validateRequest` is it. |
| GitHub CLI | `src/main/engine/thread-context.ts:10` `run()`: `execFile`, 8 s timeout, 512 KiB `maxBuffer`, `GH_PROMPT_DISABLED`, `GH_PAGER=cat`, an absolute-only PATH; `:78` the one `gh api` call; disabled under demo/E2E (`index.ts:143`) | Reuse `run()`'s environment and no-shell spawn. File lists and patches outgrow 512 KiB, so #321 sets its own bounded buffer per operation. There is no account notion yet: CR-2 adds `gh api user` for the account id and login. |
| Safe Markdown | `src/renderer/components/Markdown.tsx:16` `Markdown({ text })`: React elements only, raw HTML as text, http(s) links only via `safeHref` (`src/shared/inline.ts:19`), remote images shown as links | PR descriptions and comments use it as is. |
| Diff presentation | `src/renderer/components/ChangesPanel.tsx:106` `Diff({ text, wrap, highlight, onExpand })`, `:96` `FileIcon`, `:100` `FileGroup`; Discard is wired in `ChangesPanel` itself (`:69`, `:88`) | Reuse `Diff`/`FileIcon` only. `Diff` parses hunks inline and has no separate parser; #324 extracts a pure one with line anchors. |
| External links | `src/main/index.ts:1032` `setWindowOpenHandler`: http(s) to `shell.openExternal`, everything denied in-app | Open in GitHub is a `target="_blank"` link to `canonicalPrUrl`. |
| Layout and splitters | `src/shared/layout.ts:5` `Layout`, `loadLayout` (fail-closed); `src/renderer/components/PanelResizeHandle.tsx:13` (pointer, arrows, Home/End, double-click reset) | Add Code Review pane widths to `Layout` with defaults. |
| Existing PR type | `src/shared/types.ts:411` `PullRequestSummary` (a checkout's PR status) | Unrelated to the review contract. `PrState` matches its states. |
| Unit tests | `node --test "dist/test/**/*.test.js"` after `tsc -p tsconfig.main.json` | Fixtures compile to `dist/test/fixtures/`. |
| UI capture | `e2e/layout.spec.ts:14` captures at 1786×1049; `scripts/ui-compare.mjs` compares against a folder; no goldens in the repo | The references are 1764–1769 CSS px wide (below). #327 captures at the reference size or records the difference. |

## Contract

`src/shared/code-review.ts` is pure and serializable. Main and the renderer both import it.

```ts
interface PrLocator { host: "github.com"; owner: string; repo: string; number: number }   // what a person names
interface PrKey { account: string; host: "github.com"; repoId: string; number: number }  // what a read is for
interface PrRevision { baseRef: string; baseSha: string; headSha: string }               // what a diff or result is about

type ReadResult<T> =
  | { state: "ready"; value: T; fetchedAt; coverage? }                    // succeeded; coverage says how much
  | { state: "partial"; value: T; fetchedAt; reason; coverage }           // stopped part-way, or capped
  | { state: "stale"; value: T; fetchedAt; reason; coverage? }            // an earlier read: offline, or the head moved
  | { state: "unavailable"; reason; fetchedAt; retryAfter?; detail? };   // nothing to show
```

The rules the tests hold:

- **A locator names; a key authorizes.**
  - `parsePrLocator` accepts `github.com/owner/repo/pull/N`, with or without a scheme or a trailing
    `/files` and fragment, and `owner/repo#N`.
  - The link is parsed as a URL, which must then name github.com with no credentials and the
    scheme's default port. It rejects another host, a look-alike host, a dot segment, a zero or
    leading-zero number, and anything over 2,048 characters. Spellings the URL parser normalizes
    (`:443`, an empty `user:@`) are accepted: the link is only read for its parts, never fetched.
  - The key uses the account's numeric id and the repository's stable id. A rename or a display name
    changes nothing.
- **Unavailable is not empty.**
  - `isEmpty` is true only for a complete, successful read with no rows.
  - `knownCount` returns the provider's total when there is one, otherwise what arrived, marked inexact
    unless complete. A stale count is from then, so it is never exact. It returns null when unread.
  - `inboxGroup` carries an unavailable or stale inbox down to its groups, partial ones included.
- **Pending is not passing.**
  - `summarizeChecks` returns `passing` only for a complete, fresh read in which every check on the
    current head finished as success, neutral or skipped.
  - Cancelled, unknown, unread, or present only on an old head is `incomplete`. Queued or running is
    `pending`. Failure, timed out, action required or startup failure is `failing`.
  - Only the newest run of a check counts: a re-run on the same head replaces the run it repeats,
    as GitHub's own merge state does. A run is matched by name and by its reporter (the app or the
    status's creator), so another reporter's check of the same name is not a re-run. Run ids grow
    with creation; without numeric ids `startedAt` decides, and a queued re-run is the latest.
  - It describes evidence. It never decides merge permission.
- **A missing patch is not a zero-line change.**
  - `diffCoverage` counts a binary file as covered and a `too-large` or provider-omitted patch as
    missing.
  - It is `complete` only for a fresh, uncapped read with every textual patch present.
  - An omitted file keeps the provider's line counts.
- **Capabilities say why.** In Gate A, `capabilities` makes `read` follow the `gh` connection.
  `review`, `ask` and `instructions` (#325), and `comment`, `submit-review`, `request-reviewers`,
  `edit`, `state` and `merge` (#326), are unavailable with a user-facing reason and their owning issue.
  An unavailable `read` names no issue: installing or signing in to `gh` is the person's fix.
- **Requests are bounded plain data.** `validateRequest` accepts a known operation with exactly its
  fields:
  - a numeric account, `github.com`, a stable repository id and a positive PR number;
  - 40- or 64-hex SHAs and a git-valid base ref;
  - a relative repository path with no empty, `.` or `..` segment, no control character (C0, C1,
    line or paragraph separator) and no
    invisible format character (bidi overrides, zero-width joiners). `\`, `%`, `?` and `#` stay
    allowed, since real files have them;
  - no lone surrogate in any text, since `encodeURIComponent` throws on one;
  - a context range of at most 500 lines;
  - query, input and cursor length caps.

  It rebuilds the request from validated fields, so main never holds the renderer's object.

## Read operations

What each operation returns. The source column is a proposal; #321 confirms each against GitHub's
current REST documentation before binding to it. Every call is `gh api <fixed path> --method GET`
with validated, encoded segments.

| `op` | Request fields | Returns | Proposed source |
| --- | --- | --- | --- |
| `connection` | none | `CodeReviewConnection` | `gh api user` (id, login); a missing binary is `no-cli`, an auth failure is `signed-out` |
| `inbox` | `query` | `Inbox`: `authored` and `review-requested` groups, each its own `ReadResult` | `search/issues` with `is:pr is:open author:@me` / `review-requested:@me` (`total_count` gives the total) |
| `inbox-page` | `group`, `query`, `cursor` | `PrSummary[]` | the same search, next page |
| `resolve` | `input` (a pasted link) | `{ locator, key }` | `parsePrLocator`, then `repos/{owner}/{repo}` for the stable id |
| `overview` | `key` | `PrOverview` with its `revision` | `repos/{owner}/{repo}/pulls/{n}` |
| `activity` | `key`, `cursor` | `PrActivity[]` | `repos/{owner}/{repo}/issues/{n}/timeline` |
| `checks` | `key`, `revision` | `PrCheck[]` for that head | `commits/{headSha}/check-runs` and `commits/{headSha}/status`; `reporter` is a run's `app.slug` or a status's `creator.login` |
| `stack` | `key` | `PrStack`, `explicit` or `inferred` | #323 chooses a documented relationship source; base-branch chains are `inferred` |
| `files` | `key`, `revision`, `cursor` | `PrFiles` | `repos/{owner}/{repo}/pulls/{n}/files` (GitHub stops at 3,000 files and omits large or binary patches) |
| `context` | `key`, `revision`, `side`, `path`, `start`, `end` | `PrContext` | file contents at the base or head SHA, sliced in main |
| `cancel` | none | nothing | main aborts the named request |

For #321, three constraints:

- **Repository names:** main maps a repository id to its current owner and name from its own
  `resolve` and `inbox` reads. It never takes a name from the renderer.
- **Rate limits:** search has a much lower limit than the rest of the REST API. Prefer conditional
  requests where GitHub supports them, and no background polling of hidden views.
- **Why REST:** REST has an endpoint for every read here, paginates predictably, and answers
  conditional requests with a `304` that GitHub does not charge against the primary rate limit.

## References and calibration

The four references stay on Val's Mac, at `~/Desktop`. The Desktop is not a permanent home, so if they
move, update this table and #320. Each was checked by SHA-256 on 2026-10-19. Times are the file names'
local times (UTC−5), converted.

| ID | File | Pixels | SHA-256 | Device px per CSS px | CSS size | Offset from R2 | Captured | State |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1 | Screenshot 2026-10-18 at 15.38.42.png | 1766×1057 | `ad7365cfb4cede0ad0ace887fbe4167d5c77efb1699994886428c1082d9675ec` | 1 | 1766×1057 | 0, +2 | 20:38:42Z | Overview at the top: title, description, stack and checks sidebar, floating composer |
| R2 | Screenshot 2026-10-18 at 15.38.52.png | 3536×2102 | `448ce452b9b858f614a6109f797e06bf605070823048550874012426567cc212` | 2 | 1768×1051 | 0, 0 | 20:38:52Z | The same PR scrolled to its activity |
| R3 | Screenshot 2026-10-18 at 15.38.55.png | 3538×2098 | `6a6c2291c9263f7d355abe97bd5beb537433e73b390eeb2d39f604bedeff86c0` | 2 | 1769×1049 | 0, −1 | 20:38:55Z | R2 with the review-instructions popover open |
| R4 | Screenshot 2026-10-18 at 15.40.30.png | 3528×2094 | `022642da9ed9dbaf160a8aa99d4c0462cd772404ef8239f22c94acefdac320dc` | 2 | 1764×1047 | −6, −2 | 20:40:30Z | Another PR split: description beside its Changes tab, grouped diffs and a file tree |

**Scale.** All four PNGs say 144 dpi, so the scale is not read from the files. It is inferred from the
layout: R1's elements sit at the same CSS positions as R2's at half scale (the "Code Review" title at
x 71 in both). So R1 is one image pixel per CSS pixel, and R2–R4 are Retina captures at two.
[#319](https://github.com/TypeSafeAI/modex/issues/319)'s table lists R2–R4 at about 2048 px wide,
which matches 2048-wide copies. Calibrate against these originals.

**Crop.** R1–R3 are window captures with the window's 3–5 px edge. R4 is a region crop, about 6 px
further left and 2 px higher than R2. The offsets come from the centre of the red window button.

**Measured geometry**, in CSS px (±2), from luminance runs across rows and columns:

| Region | R1 / R2 | R4 (split) |
| --- | --- | --- |
| Title bar and tab strip | y 3–46, about 43 tall | y 1–44 (crop) |
| Icon rail | x 4–55 | x 0–49 (crop) |
| Inbox pane, including an 8 px scrollbar gutter | x 55–335 | x 49–329 |
| Overview text column | x 491–1255 (R1); activity cards x 494–1252 (R2) | PR pane x 329–988, summary card x 354–952 |
| Right sidebar (Changes, Stack, Checks) | x 1295–1600 | not shown |
| Diff pane | not shown | x 988–1458, divider at 988 |
| File tree | not shown | x 1458–1748, divider at 1458 |
| Floating composer | x 1186–1745, y 991–1033 (R1): 42 tall, 17 above the bottom edge | x 1182–1745, over the diff |

**Typography and spacing**, in CSS px. A line's glyph extent runs from its tallest ascender to its
lowest descender, and its pitch is the distance from one line's top to the next. The size column is an
estimate: about the extent ÷ 0.95 for a line with descenders, ÷ 0.72 for capitals and ascenders only
(SF Pro's proportions). Measured on R1 (1×) and R2 and R4 (2×, so to half a pixel):

| Text | Glyph extent | Line pitch | About | Nearest Modex token |
| --- | --- | --- | --- | --- |
| PR title (R1, two lines) | 21 | 29 | 22 | none: between `--text-lg` (18) and `--text-xl` (28) |
| Section heading in a description (R2, R4) | 14 caps / 17 | – | 18 | `--text-lg` |
| Description and comment prose | 13 | 24–25 | 14 | `--text-md`, but the pitch is ~1.75×, not `--leading` 1.5 (21) |
| Inbox header "Code Review" | 13.5 caps | – | 18 | `--text-lg` |
| Inbox group label, row title | 13 | 20 (a wrapped title) | 14 | `--text-md` |
| Sidebar label ("Changes") | 12 | – | 13 | `--text-sm` |
| Sidebar rows (stack, checks) | 13 | 30 | 14 | `--text-md` |
| Activity rows | 13 | 46 (card to card) | 14 | `--text-md` |
| Diff code | 12 | 21–22 | 13 mono | `--text-sm`, `--font-mono` |
| File tree rows | 10.5–12 | 28–31 | 13 | `--text-sm` |

Two proposals for #323, which needs a recorded decision before using either: a PR-title size of about
22 px, which no token has, and a prose pitch of about 24 px for descriptions and comments. Everything
else maps to an existing token.

## Control inventory

Every visible control in R1–R4, with its owner and how it is tested. The owners are:

- An issue (#322–#327).
- `shell`: the existing Modex shell, unchanged.
- `native chrome`: macOS.
- `deferred`: outside #319's initial scope, shown unavailable or left out.
- `needs decision`: Val decides whether it is in scope. Until then it is unavailable.

Contract-level guarantees are cited where they already hold. Everything else names the slice that
must prove it.

| ID | Refs | Region | Control | Owner | Test / evidence |
| --- | --- | --- | --- | --- | --- |
| C01 | R1, R2, R3, R4 | Window | Traffic lights and window drag | native chrome | macOS provides them; not tested |
| C02 | R1, R2, R3, R4 | Title bar | Back and forward | #322 | Navigation spec: back/forward between PRs restores the view without replaying a read as an action |
| C03 | R1, R2, R3, R4 | Title bar | Inbox pane toggle | #322 | Navigation spec: hides and restores the inbox, keeping selection |
| C04 | R1, R2, R3, R4 | Title bar | Top-right buttons (expand, right panel) | shell | Existing title-bar controls; #322 confirms which apply on this surface |
| C05 | R1, R2, R3, R4 | Tab strip | PR tab: icon, truncated title, close | #322 | Navigation spec: open, switch and close, per PR key |
| C06 | R1, R2, R3, R4 | Tab strip | Changes tab with +/− totals | #322 | Opens the PR's Changes; totals from `overview.totals` |
| C07 | R1, R2, R3, R4 | Tab strip | New tab (+) | needs decision | Unavailable until a use is decided |
| C08 | R1, R2, R3, R4 | Rail | Code Review rail button, selected | #322 | Opens the `code-review` surface; selected state |
| C09 | R1, R2, R3, R4 | Rail | Other rail icons and their dots | shell | Existing rail; unchanged |
| C10 | R1, R2, R3, R4 | Rail | Account monogram at the bottom | shell | Existing; unchanged |
| C11 | R1, R2, R3, R4 | Inbox | "Code Review" title and ⋯ menu | #322 | The menu holds Refresh; other items need a decision |
| C12 | R1, R2, R3, R4 | Inbox | Search or paste a PR link | #322 | `parsePrLocator` (contract test); debounced search and paste-to-resolve in the navigation spec |
| C13 | R1, R2, R3, R4 | Inbox | "Authored by me" group | #322 | `inboxGroup`, `isEmpty` (contract test); empty, unavailable and stale states in the navigation spec |
| C14 | R1, R2, R3, R4 | Inbox | "Needs my review" group | #322 | As C13 |
| C15 | R1, R2, R3, R4 | Inbox | PR row: two-line title, author, relative time | #322 | Navigation spec over the fixture inbox |
| C16 | R1, R2, R3, R4 | Inbox | Author avatar and badge on a row | needs decision | Proposal D1: login only, no remote avatar |
| C17 | R1, R2, R3, R4 | Inbox | Stack icon on a row | #322 | `stackHint` is inferred; the row says so in its accessible name |
| C18 | R1, R2, R3, R4 | Inbox | Selected and hover row states | #322 | Navigation spec and visual check |
| C19 | R1, R2, R3, R4 | Inbox | Show more | #322 | `inbox-page`; `knownCount` (contract test) |
| C20 | R1, R2, R3, R4 | Inbox | Independent list scroll | #322 | Scroll-isolation check (#322 AC3) |
| C21 | R1, R2, R3, R4 | PR header | State pill "Open ▾" | needs decision | The state shows from `overview.state` (#323); its menu (close, reopen, draft) is capability `state`, #326 only if included |
| C22 | R1, R2, R3, R4 | PR header | Repository and number | #323 | From `overview.locator` |
| C23 | R2 | PR header | Loading spinner | #322 | Shown while a read for this PR is in flight |
| C24 | R1, R2, R3, R4 | PR header | Pin | #322 | Local only, never synced (D2) |
| C25 | R1, R2, R3, R4 | PR header | Copy link | #322 | `canonicalPrUrl` (contract test) |
| C26 | R1, R2, R3, R4 | PR header | Open in GitHub | #322 | `canonicalPrUrl` through the window-open handler (`index.ts:1032`) |
| C27 | R1, R2, R3, R4 | PR header | Review with Codex | #325 | Capability `review`, unavailable in Gate A (contract test) |
| C28 | R1, R2, R3, R4 | PR header | Review settings (gear) | #325 | Opens R3's popover; capability `instructions` |
| C29 | R1, R2, R3, R4 | PR header | Merge split button and method menu | #326 | Capability `merge`, unavailable in Gate A (contract test) |
| C30 | R1, R4 | Overview | Title | #323 | `overview.title`; long-title wrap check |
| C31 | R1, R4 | Overview | Edit title (pencil) | needs decision | Capability `edit`; #326 only if included |
| C32 | R1, R4 | Overview | Author, age, head → base branch | #323 | `overview.author`, `createdAt`, `headRef`, `revision.baseRef` |
| C33 | R1, R2, R4 | Overview | Description Markdown: headings, lists, inline code, links | #323 | `Markdown.tsx` (inert HTML, http(s) links, no remote images); hostile-content fixture in #323 |
| C34 | R2 | Overview | Reaction button under the description | deferred | D3 |
| C35 | R2 | Overview | Edit description | needs decision | Capability `edit`; #326 only if included |
| C36 | R4 | Overview | Summary card: files and totals | #323 | `overview.totals`; opens Changes (#322) |
| C37 | R4 | Overview | Summary card: comment count | #323 | `overview.comments` |
| C38 | R4 | Overview | Summary card: Request review | needs decision | Capability `request-reviewers`; #326 only if included |
| C39 | R4 | Overview | Summary card: passing checks | #323 | `summarizeChecks` verdict (contract test: 11 of 11 is `passing`) |
| C40 | R1, R2, R3 | Sidebar | Changes: files and totals | #323 | `overview.totals` |
| C41 | R1, R2, R3 | Sidebar | Stack: numbered members, current one highlighted | #323 | `PrStack`, labelled `explicit` or `inferred`; inaccessible members keep their place |
| C42 | R1, R2, R3 | Sidebar | Comment count ("No comments") | #323 | `overview.comments`; zero only from a complete read |
| C43 | R1, R2, R3 | Sidebar | Reviewers ("No reviewers") and + | needs decision | The list shows from `overview.reviewers` (#323); + is capability `request-reviewers` |
| C44 | R1, R2, R3 | Sidebar | Checks with an elapsed clock | #323 | `summarizeChecks`; elapsed from `startedAt` (the fixture reads 03:27 at its clock) |
| C45 | R1, R2, R3 | Sidebar | Check row states: running ring, success tick | #323 | `PrCheck` status and conclusion; text, not colour alone |
| C46 | R1, R2, R3 | Sidebar | Show more checks | #323 | `knownCount` |
| C47 | R1, R2, R3 | Sidebar | Independent sidebar scroll | #323 | Scroll-isolation check |
| C48 | R2, R3 | Activity | "Activity" heading and "All activity" filter | #323 | Filter options are defined in #323 |
| C49 | R2, R3 | Activity | Commit groups ("3 commits") | #323 | Consecutive `commit` items grouped in presentation; stable ids keep pagination from doubling them |
| C50 | R2, R3 | Activity | "opened this pull request" | #323 | `opened` item |
| C51 | R2, R3 | Activity | Bot comment card with ⋯ menu and age | #323 | `comment` item; the ⋯ menu offers Copy link only until more is decided |
| C52 | R2, R3 | Activity | Deployment table, Ready and Preview links inside the comment | #323 | Comment-derived links are labelled as comment content, not a provider deployment; opened only on click |
| C53 | R2, R3 | Activity | A third-party bot's button inside the comment (a link styled as a button) | #323 | Third-party HTML in a comment renders as inert text and links (D4); not a Modex control |
| C54 | R2, R3 | Activity | Reaction and Add to chat on a comment | #325 | Add to chat feeds the PR conversation (capability `ask`); reactions are deferred (D3) |
| C55 | R2, R3 | Activity | Comment composer and Comment button | #326 | Capability `comment`, unavailable in Gate A |
| C56 | R3 | Popover | Review instructions: title, scope line, text field | #325 | Capability `instructions`; Escape and focus return checked in #327 |
| C57 | R1, R2, R3, R4 | Composer | "Ask about this pull request" field and send | #325 | Capability `ask`, unavailable in Gate A |
| C58 | R1, R2, R3, R4 | Composer | Attach (+) | #325 | Reuses the thread composer's attachments only if #325 includes them |
| C59 | R1, R2, R3, R4 | Composer | Model and reasoning effort (the brain icon) | #325 | The thread composer's `ModelMenu` (`Composer.tsx:195`) is the equivalent |
| C60 | R1, R2, R3, R4 | Composer | Voice input | deferred | Outside #319's initial scope |
| C61 | R1, R2, R3, R4 | Composer | Clearance: the composer never covers the last item or focus | #323 | Composer-clearance check (#323 AC5, #324 for R4) |
| C62 | R4 | Changes header | State, number and header actions repeated in the Changes pane | #322 | Same controls as C21–C29, second pane |
| C63 | R4 | Changes toolbar | ⋯ menu and view toggles (tree, file, image, layout) | #324 | Each mapped to a `Diff` option (wrap, highlight exist) or left out |
| C64 | R4 | Diff | File header: icon, path with a truncated head, +/− | #324 | `FileIcon` (`ChangesPanel.tsx:96`); `PrFile` |
| C65 | R4 | Diff | Viewed (eye) toggle per file | needs decision | Local-only, or GitHub's viewed state (a write)? |
| C66 | R4 | Diff | File ⋯ menu | #324 | Copy path, Open in GitHub; never Discard (#324 AC4) |
| C67 | R4 | Diff | Folded unmodified lines with expand up/down | #324 | `context` request (contract test bounds it); `Diff` `onExpand` |
| C68 | R4 | Diff | Old and new line numbers, added and removed rows | #324 | Patch-model anchor tests (#324 AC2) over the R4 fixture patches |
| C69 | R4 | Diff | "More unchanged context may be available" | #324 | `PrContext.total` null |
| C70 | R4 | Diff | Collapsed file sections | #324 | Per-file collapsed state |
| C71 | R4 | Diff | Horizontal scroll per file | #324 | Wrap off; independent scroll |
| C72 | R4 | File tree | Filter files | #324 | Filter spec |
| C73 | R4 | File tree | Folder tree, per-file totals, selected file | #324 | Selecting a file scrolls to its section |
| C74 | R4 | Split | Divider between overview and Changes | #322 | `PanelResizeHandle` pattern; pointer and keyboard resize |
| C75 | R4 | Split | Divider between diff and file tree | #322 | As C74 |
| C76 | R1, R2, R3, R4 | Whole workspace | Keyboard path through every control above at 900×600 and 1440×900 | #327 | Acceptance matrix; human VoiceOver pass recorded separately |
| C77 | R1, R2, R4 | Overview | Independent scroll of the description and activity column | #323 | Scroll-isolation check (#322 AC3) |
| C78 | R4 | Diff | Independent vertical scroll of the diff pane | #324 | Scroll-isolation check; file selection keeps the overall position |
| C79 | R4 | File tree | Independent scroll of the file tree | #324 | Scroll-isolation check |
| C80 | R4 | Tab strip | Closing the Changes tab, or leaving the split for one pane | #322 | Navigation spec: the PR tab and its scroll position survive |
| C81 | R2, R3 | Activity | Avatars in the timeline and the comment composer (a bot's logo, a commenter) | needs decision | D1 |
| C82 | R1, R2, R3, R4 | Composer | Access-mode indicator (the orange shield, `--accent-warn`, as the thread composer's full-access pill uses, `Composer.tsx:296`) | needs decision | Review runs read-only whatever it shows (#325); see open decision 7 |

## Deviations

- **D1, avatars.** People and bots show by login (and the shell's monogram), not a fetched avatar, in
  the inbox, the timeline and the comment composer. Fetching one would load a remote image, which the
  Markdown view never does. This needs a decision (C16, C81).
- **D2, pins.** Pins are a local list, never synced to GitHub or across devices.
- **D3, reactions.** No child owns them. They are left out or shown unavailable.
- **D4, third-party comment HTML.** A bot's buttons and images in a comment are comment content. They
  render through the inert Markdown view as text and links, never as controls.
- **D5, outside the initial scope.** Native window chrome, voice input, proprietary cloud review
  services, stack mutation or rebasing, and admin bypass (#319).

## Open decisions

For Val. Each control stays unavailable until decided:

1. **C16 and C81, avatars:** login only (D1), or fetch avatars?
2. **C21, the state menu** (close, reopen, draft): in #326's scope?
3. **C31 and C35, editing the title and description:** in #326's scope?
4. **C38 and C43, requesting reviewers:** in #326's scope?
5. **C65, the Viewed toggle:** local only, or GitHub's viewed state?
6. **C07, the new-tab button** on this surface: what does it open?
7. **C82, the access-mode indicator.** The reference's PR composer shows full access. Review is
   read-only (#325), so should this composer show an access mode at all, and if so, which?

## Fixtures

`apps/desktop/test/fixtures/code-review.ts` is plain data with a fixed clock
(`2026-10-18T20:41:00Z`). It imports only the contract's types. It follows the references' layout and
density, never their content: a made-up library-lending project, with its own people, numbers,
check names and code. Two accounts and two repositories share PR #73. A test checks that every
patch's hunk headers count its lines and that the file totals add up to the overview's.

| Export | Covers |
| --- | --- |
| `R1` | Connection, an inbox (a 9-of-12 first page plus 2 to review), the overview (11 files, +8,912 −47, a long description), 7 checks (6 pending, the clock at 03:27), a 4-member inferred stack with a draft |
| `R2` | The same PR's activity: 2 commits, the opening, a preview bot's comment with a table and raw HTML, then 7 commits |
| `R3` | R2 with the instructions popover open and empty instructions |
| `R4` | A second PR: 4 files (+11 −4) with folded hunks shaped like R4's, 11 passing checks |
| `FAULTS` | Empty inbox, signed out, no `gh`, denied, offline (a stale inbox), a first page, a failed second page, one check of every outcome plus one on an old head, a failed check and its passing re-run, a 3,000-of-3,412 capped diff with a binary and a too-large patch, and a head change with its stale diff |
| `REQUESTS` | One well-formed request per operation |
| `REFERENCES` | The manifest above |
| `stressFiles(n)` | `n` small added files, the same every time, for #324's 1,000-file run |
