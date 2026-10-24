# Code Review acceptance matrix (CR-8), 2026-10-22

CR-8 ([#327](https://github.com/TypeSafeAI/modex/issues/327)) runs the integration and acceptance pass for the
Code Review workspace ([#319](https://github.com/TypeSafeAI/modex/issues/319)), alongside the implementation
slices. This page maps every control in the
[inventory](../design/code-review.md#control-inventory) (C01–C82) and every acceptance criterion of
#321–#326 to its evidence. Each piece of evidence names the SHA and environment it ran in.

**Gate A is not complete.** CR-2 (#321) has landed and is closed. CR-3 (#322) has landed on `main` but its
issue is still open. CR-4 to CR-7 (#323–#326) have not started. A row with no evidence says *pending* and names
its owner. A passing fixture run is not authenticated evidence, and an authenticated read is not live-provider
or live-write evidence. Those columns stay separate.

## How to read a row

| Column | Means |
| --- | --- |
| **Fixture** | Node tests, main/IPC tests, or real Electron with synthetic data. Real Electron is either the renderer over a replaced `code-review:read` handler (`F-nav`), or the production preload, IPC, read service and gh transport with only `gh` synthetic (`F-prod`). |
| **Authenticated** | Read-only reads through a real `gh` login against a repository the user authorized. |
| **Live provider** | A native-CLI (Codex or Claude) review turn that a person authorized. Applies only to #325. |
| **Live write** | A GitHub mutation against a disposable target that a person authorized. Applies only to #326. |
| **Human** | A person driving the app (keyboard, VoiceOver, visual comparison with the references). |

Cells hold the environment IDs below. **pending (#n)** means the owning slice hasn't produced the evidence yet.
**open** means the slice exists but this gate hasn't run. **—** means the column doesn't apply. No cell says
"pass" for a check that didn't run.

## Environments

| ID | What ran | SHA | Where | Result |
| --- | --- | --- | --- | --- |
| `U` | `node --test` on the five `dist/test/code-review-*.test.js` files (contract, gh, IPC handler, read service, workspace) | `0e674e7` | E1 | 71 of 71 passed, 0 skipped |
| `F-nav` | `e2e/code-review-navigation.spec.ts` (CR-3): renderer over a replaced handler that serves `test/fixtures/code-review.ts` | `0e674e7` | E1 | 12 of 12 passed (with `F-ipc`, 13 of 13 in 1.0 min) |
| `F-ipc` | `e2e/code-review-ipc.spec.ts` (CR-2 AC1): production IPC with `FAKE_GH` | `0e674e7` | E1 | 1 of 1 passed |
| `F-prod` | This page's new specs: `code-review-journey`, `-regressions`, `-a11y` and `-measure` `.spec.ts`. Production preload, IPC, service and transport, with only `gh` synthetic (`WORLD_GH`) | product `0e674e7`; specs on branch `cr8-acceptance` | E1 | 16 of 16 passed (journey 1, regressions 7, a11y 5, measure 2), alone and inside the full `pnpm test:e2e` run |
| `CI` | Required check `unit + e2e (macOS)` on PR #372 (GitHub macOS runner, about 677 px of display height) | branch head `17f53a5` (product `0e674e7`) | GitHub Actions job 120081297678 | unit: 0 failed, 0 cancelled; e2e: 406 passed, 3 skipped, 0 failed, including all 29 Code Review specs. The first head, `ac5fc58`, failed 3 of the new specs because the window couldn't grow past that display; `fitWindow` fixed it |
| `A-main` | Authenticated read-only re-run on main, authorized by Val on 2026-10-22. (1) The CR-2 service smoke (`2026-10-20-cr2-read-smoke.mjs 367`): account BunsDev (id 68980965) on github.com; TypeSafeAI/modex (id 1386876170); PR #367 at head `0866265`, base `eb93287`; gh 2.102.0. (2) CR-3's navigation probe through the real renderer, IPC and service. | product `0e674e7` | E1 | (1) connection, inbox, resolve, overview (then a `304`), activity 36 complete, checks 13/13, files 21/21 and context ready; `stack` unavailable as designed; a foreign account's key answers `signed-out` and an unknown repository id `not-found`, with no request. 17 GET requests, 7 of them `304`s. (2) All six checks passed: inbox and repository search; #349 and #348 resolved with their totals; back/forward, Changes and split; a pin surviving reload; an explicit error for a missing PR; signed-out with an empty gh configuration. |
| `A-321` | CR-2's authenticated read smoke ([record](2026-10-20-cr2-read-smoke.md)): account BunsDev (id 68980965), TypeSafeAI/modex (id 1386876170), PRs #334 and #330, gh 2.98.0 | branch `cr2-read-service`, before it merged | Val's Mac | 17 requests per run, all GET; reads ready except `stack` |
| `A-349` | The authenticated smoke for CR-2's cache-denial repair ([record](2026-10-20-cr2-cache-denial.md)): PR #349 head `d31f661` | `d31f661` (PR #349) | Val's Mac | connection, resolve, overview, files and context ready |
| `A-322` | CR-3's authenticated navigation smoke through the real renderer and service ([record](2026-10-21-cr3-read-integration.md)) | candidate `65e86dd` + #354 `4dd5bb5` | Val's Mac | probe exited 0 |

`A-321`, `A-349` and `A-322` ran on candidate SHAs before squash-merge (#366 and #367). `A-main` re-ran both
authenticated checks on `main` at `0e674e7`, read-only, with Val's go-ahead. Neither run switched to a second
real GitHub account, so account-switch races remain fixture evidence (`U`, `F-nav`, `F-prod`).

**E1:** Mac17,6 (Apple M5 Max, 18 cores, 128 GiB), macOS 26.7.1 (Darwin 25.6.0), Electron 44.4.5,
Playwright 1.63.0, Node 24.22.0. The display was 2× (DPR 2), with the Graphite theme (dark) and locale en-US.
The renderer clock was pinned to the fixtures' `2026-10-18T20:41:00Z` with Playwright's clock. The system font
stack was `-apple-system`. Other sessions were running on the machine: the load average was 25–34 during the
measurements, so absolute times are pessimistic. The `F-prod` specs set aside the machine's gh 2.102.0,
`claude` 2.1.308 and `codex` 0.163.0. `gh` is synthetic, and `claude`/`codex` on PATH are recorders that exit 1.

## Controls C01–C82

The owner column comes from the inventory. The status values are: *built* (the slice delivered it and evidence
exists); *unavailable* (shown focusable, named and `aria-disabled` with its capability's reason, and proven to
do nothing); *pending*; *deviation*; *needs decision* (one of the [open decisions](../design/code-review.md#open-decisions),
shown unavailable or left out until Val decides). Rows whose owner is #323 or later are pending throughout.

| ID | Control | Owner | Status | Fixture | Authenticated | Live provider / write | Human |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C01 | Traffic lights, window drag | native chrome | deviation D5 | — (macOS) | — | — | — |
| C02 | Back / forward | #322 | built | `F-nav` "back and forward…"; `F-prod` journey (no re-read on back/forward) | `A-322`, `A-main` (navigation) | — | open (VoiceOver) |
| C03 | Inbox pane toggle | #322 | built | `F-nav` back/forward test | — | — | open |
| C04 | Top-right buttons | shell | deviation D9 (only the split toggle applies) | `F-nav`, `F-prod` journey (split toggle) | `A-322`, `A-main` (navigation) | — | open |
| C05 | PR tab: icon, title, close | #322 | built | `F-nav`; `F-prod` journey, a11y (Tab reaches tab and close) | — | — | open |
| C06 | Changes tab with +/− | #322 | built | `F-nav`; `F-prod` journey (totals from the production overview) | `A-322`, `A-main` (overview totals) | — | open |
| C07 | New tab (+) | needs decision 6 | unavailable | `F-nav` (aria-disabled); `F-prod` regressions "dispatch" | — | — | open |
| C08 | Code Review rail button | #322 | built | `F-nav`; `F-prod` journey (`aria-current`) | `A-322` | — | open |
| C09 | Other rail icons | shell | unchanged | full `pnpm test:e2e` (see Repository suites) | — | — | — |
| C10 | Account monogram | shell | unchanged | full `pnpm test:e2e` | — | — | — |
| C11 | Inbox title and ⋯ menu (Refresh) | #322 | built | `F-nav` (Escape returns focus); `F-prod` a11y (Tab order) | — | — | open |
| C12 | Search or paste a PR link | #322 | built | `U` (`parsePrLocator`); `F-nav`; `F-prod` regressions "hostile content" (six unsafe or look-alike links never resolve, open or navigate) | `A-322`, `A-main` (search, links, missing PR) | — | open |
| C13 | "Authored by me" group | #322 | built | `U`; `F-nav`; `F-prod` regressions "incomplete data" (a timed-out search is labelled, never whole) | `A-322`, `A-main` | — | open |
| C14 | "Needs my review" group | #322 | built | As C13 (a hidden repository is labelled, and never shown as "No pull requests") | `A-322` | — | open |
| C15 | PR row: title, author, age | #322 | built | `F-nav`; `F-prod` journey | `A-322` | — | open |
| C16 | Row avatar and badge | needs decision 1 | not built (D1) | — | — | — | — |
| C17 | Row stack icon | #322 | built | `F-nav` (shown only for `stackHint: true`, named "inferred") | — | — | open |
| C18 | Selected and hover rows | #322 | built | `F-nav`, `F-prod` (`aria-current`); visual: captures R1 and R4 | — | — | open: original-reference comparison |
| C19 | Show more | #322 | built | `U` (`knownCount`, `mergePages`); `F-nav` pagination ×3; `F-prod` measure (300 rows, one search per page) | — | — | open |
| C20 | Independent inbox scroll | #322 | built | `F-nav` keyboard test (the inbox scrolls; diff, sheet and document stay at 0) | — | — | — |
| C21 | State pill "Open ▾" | needs decision 2 | state shown, no menu (D7) | `F-nav`, `F-prod` (state pill contrast ≥ 7.77) | — | — | — |
| C22 | Repository and number | #323 | interim D6 (from the row or the link) | `F-nav` (`title` gives `owner/repo`) | — | — | pending #323 binds `overview.locator` |
| C23 | Loading spinner | #322 | built | `F-nav` (stops under reduced motion); `F-prod` regressions "identity" | — | — | — |
| C24 | Pin | #322 | built | `F-nav` (local, per account, survives reload) | `A-322`, `A-main` (pin after reload) | — | open |
| C25 | Copy link | #322 | built | `U` (`canonicalPrUrl`); `F-nav` (clipboard) | — | — | open |
| C26 | Open in GitHub | #322 | built | `F-nav` (`shell.openExternal` gets the canonical link only) | — | — | open |
| C27 | Review with Codex | #325 | unavailable in Gate A | `U` (capability); `F-nav`; `F-prod` regressions "dispatch" (double-click, Enter and Space start no provider and no gh call) | — | pending #325 | open |
| C28 | Review settings (gear) | #325 | unavailable | As C27 | — | pending #325 | open |
| C29 | Merge | #326 | unavailable (D10, no chevron) | As C27; `F-nav` (tooltip and description give the reason) | — | pending #326 | open |
| C30 | Title | #323 | pending | pending #323 | pending | — | pending |
| C31 | Edit title | needs decision 3 | not built | — | — | — | — |
| C32 | Author, age, head → base | #323 | pending | pending #323 | pending | — | pending |
| C33 | Description Markdown | #323 | pending | pending #323 (`F-prod` already serves a hostile body for #323 to render) | pending | — | pending |
| C34 | Reaction under the description | deferred | deviation D3 | — | — | — | — |
| C35 | Edit description | needs decision 3 | not built | — | — | — | — |
| C36 | Summary card: files and totals | #323 | pending | pending #323 | pending | — | pending |
| C37 | Summary card: comments | #323 | pending | pending #323 | pending | — | pending |
| C38 | Summary card: Request review | needs decision 4 | not built | — | — | — | — |
| C39 | Summary card: passing checks | #323 | pending (`U` covers `summarizeChecks`) | `U`; pending #323 | pending | — | pending |
| C40 | Sidebar: Changes | #323 | pending | pending #323 | pending | — | pending |
| C41 | Sidebar: Stack | #323 | pending (main answers `stack` unavailable until #323) | `U`; pending #323 | `A-321`, `A-main` (`stack` unavailable, as designed) | — | pending |
| C42 | Sidebar: comment count | #323 | pending | pending #323 | pending | — | pending |
| C43 | Sidebar: reviewers and + | #323 list; + needs decision 4 | pending | pending #323 | pending | — | pending |
| C44 | Checks with elapsed clock | #323 | pending (`U` covers `summarizeChecks`) | `U`; pending #323 | `A-321`, `A-main` (checks 13 of 13, read only) | — | pending |
| C45 | Check row states | #323 | pending | `U`; pending #323 | pending | — | pending |
| C46 | Show more checks | #323 | pending | pending #323 | pending | — | pending |
| C47 | Independent sidebar scroll | #323 | pending | pending #323 | — | — | — |
| C48 | Activity heading and filter | #323 | pending | pending #323 | pending | — | pending |
| C49 | Commit groups | #323 | pending | pending #323 | `A-321`, `A-main` (activity 36, complete, read only) | — | pending |
| C50 | "opened this pull request" | #323 | pending | pending #323 | pending | — | pending |
| C51 | Bot comment card | #323 | pending | pending #323 | pending | — | pending |
| C52 | Deployment table and preview links | #323 | pending | pending #323 | pending | — | pending |
| C53 | Third-party bot button | #323 | pending (D4: inert) | pending #323 | — | — | pending |
| C54 | Reaction and Add to chat | #325 (reactions deferred, D3) | pending | pending #325 | — | pending #325 | pending |
| C55 | Comment composer | #326 | pending (capability `comment` unavailable) | `U` (capability) | — | pending #326 | pending |
| C56 | Review instructions popover (R3) | #325 | pending | pending #325 (journey step R3 is added when it lands) | — | pending #325 | pending (Escape and focus return in the checklist) |
| C57 | Ask about this pull request | #325 | not built in Gate A | `U` (capability `ask` unavailable) | — | pending #325 | pending |
| C58 | Attach (+) | #325 | pending | pending #325 | — | pending | pending |
| C59 | Model and reasoning effort | #325 | pending | pending #325 | — | pending | pending |
| C60 | Voice input | deferred | deviation D5 | — | — | — | — |
| C61 | Composer clearance | #323 / #324 | pending (no composer built yet) | pending #323, #324 | — | — | pending |
| C62 | Header repeated over Changes | #322 | built | `F-nav`; `F-prod` journey (R4 capture), a11y (both headers in Tab order) | — | — | open |
| C63 | Changes ⋯ menu and view toggles | #324 | pending | pending #324 | pending | — | pending |
| C64 | File header | #324 | pending | pending #324 | pending | — | pending |
| C65 | Viewed toggle | needs decision 5 | not built | — | — | — | — |
| C66 | File ⋯ menu (never Discard) | #324 | pending; the Discard separation already holds at the host | `F-nav`; `F-prod` regressions "local Changes stay local" | — | — | pending |
| C67 | Folded lines, expand | #324 | pending (`U` bounds `context`) | `U`; pending #324 | `A-321`, `A-main` (`context` lines 1–3) | — | pending |
| C68 | Line numbers, add/remove rows | #324 | pending | pending #324 | pending | — | pending |
| C69 | "More unchanged context…" | #324 | pending | pending #324 | — | — | pending |
| C70 | Collapsed file sections | #324 | pending | pending #324 | — | — | pending |
| C71 | Horizontal scroll per file | #324 | pending | pending #324 | — | — | pending |
| C72 | Filter files | #324 | pending | pending #324 | — | — | pending |
| C73 | Folder tree, selected file | #324 | pending (the tree region and its placeholder exist) | pending #324 | — | — | pending |
| C74 | Overview / Changes divider | #322 | built | `F-nav` (keyboard resize persists across reload; fitted to the window) | — | — | open |
| C75 | Diff / tree divider | #322 | built; pointer and keyboard resize not asserted yet | `F-prod` a11y (reached by Tab as a separator); `F-nav` (tree folds behind a toggle when narrow) | — | — | open |
| C76 | Keyboard path, 900×600 and 1440×900 | #327 | partial: automated for CR-3's controls | `F-nav` keyboard test; `F-prod` a11y (Tab reaches all 12 required controls, each with a visible focus indicator) | — | — | **open: [VoiceOver checklist](2026-10-22-cr8-voiceover/checklist.md) for Val** |
| C77 | Overview column scroll | #323 | pending (the region exists with scroll memory) | pending #323 | — | — | — |
| C78 | Diff pane scroll | #324 | pending | pending #324 | — | — | — |
| C79 | File tree scroll | #324 | pending | pending #324 | — | — | — |
| C80 | Closing Changes / leaving the split | #322 | built | `F-nav` back/forward test (PR tab and focus survive) | — | — | open |
| C81 | Timeline and composer avatars | needs decision 1 | not built (D1) | — | — | — | — |
| C82 | Access-mode indicator | needs decision 7 | not built | — | — | — | — |

## Acceptance criteria #321–#326

| AC | Criterion (short) | Fixture | Authenticated | Live provider / write | Status |
| --- | --- | --- | --- | --- | --- |
| #321 AC1 | List → detail → files over real main/IPC, isolated, no local mutation | `U`, `F-ipc`, `F-prod` journey (checkout unchanged) | `A-321` | — | met (issue closed) |
| #321 AC2 | Same PR number across repositories and accounts; account switch drops a delayed result | `U`; `F-prod` regressions "identity" ×2 | — (no second real account) | — | met at fixture level. A real `gh auth switch` mid-read was never run live |
| #321 AC3 | Revoked, denied, malformed, timeout, rate limit, partial, omitted patch, no secret leakage | `U`; `F-prod` "incomplete data" (gh stderr sentinel never reaches the renderer or a reply) | `A-349` | — | met |
| #321 AC4 | Head changes invalidate or label old diff/check data | `U`; `F-prod` "revision" (before the page: `head-changed`, files list never requested; during the page: `stale head-changed`) | — | — | met at service and IPC level. The UI labelling is #324's |
| #321 AC5 | Authenticated read-only smoke, kept separate | — | `A-321`, `A-349`, `A-main` | — | met, and re-run on main |
| #321 AC6 | Existing Changes, connection and login tests green; no new permissions or writes | full suites (see Repository suites) | — | — | met at merge. Re-checked in this branch's full run |
| #322 AC1 | R1 and R4 through real controls; PR and tab identity correct | `F-nav`; `F-prod` journey (rail → row → split, with captures at the references' CSS sizes and geometry within 2 px of CR-3's table) | `A-322`, `A-main` | — | met for the host. **Original-reference comparison is open** (see Visual comparison) |
| #322 AC2 | Rapid switching shows no stale reply; back/forward don't replay | `F-nav` ×3; `F-prod` "identity" ×2, journey (no re-read) | `A-322` (back/forward) | — | met |
| #322 AC3 | Scroll regions independent; resize and reopen keep controls in the window | `F-nav` keyboard test | — | — | met for the inbox and pane dividers. The overview, diff and tree regions hold placeholders until #323 and #324 |
| #322 AC4 | Keyboard-only at 900×600 and 1440×900; focus returns; reference DPR | `F-nav`; `F-prod` a11y | — | — | automated checks met; **human VoiceOver open** |
| #322 AC5 | Local Changes, threads and tabs pass; no remote PR reaches Discard | `F-nav`; `F-prod` "local Changes stay local" (a dirty file at the PR's own path is untouched; `changes:revert` never called) | — | — | met at fixture level; the full-suite result is under Repository suites |
| #322 AC6 | Fixture and authenticated smoke reported separately | this table | `A-322`, `A-main` | — | met, and re-run on main |
| #323 AC1–AC6 | Overview, activity, checks, stack, hostile Markdown, clearance, no writes | pending #323 | pending #323 | — | pending (#323 not started). CR-8 adds R2 to the journey and extends "hostile content" to the rendered body |
| #324 AC1–AC6 | Grouped diff, anchors, delayed-patch isolation, no Discard, coverage, stress | pending #324. `F-prod` measure already records a 1,000-file and a 3 MiB-patch IPC baseline | pending #324 | — | pending (#324 not started) |
| #325 AC1–AC6 | Instructions popover, context isolation, injection boundary, lifecycle, no promotion, live smoke | pending #325 | — | pending #325 (authorized live native smoke) | pending (#325 not started). CR-8 adds R3 to the journey |
| #326 AC1–AC6 | Local drafts, at-most-once dispatch, stale targets, head-guarded merge, draft isolation, mocks and canary | pending #326. `F-prod` "dispatch" proves the unavailable actions start nothing today | — | pending #326 (authorized disposable-target canary) | pending (#326 not started) |

## #327's own criteria

| AC | Where it stands |
| --- | --- |
| AC1 R1–R4 in real Electron | R1 and R4 reached by controls through production reads, and captured. R2 waits for #323 and R3 for #325. The original-reference comparison is open. |
| AC2 every visible control has behaviour or an explicit unavailable state | Met for CR-3's controls (the table above). Pending for #323–#326's. |
| AC3 isolation, injection, incomplete data, at-most-once | Integrated regressions pass for the read path. Provider stop and unknown completion (#325) and lost write responses (#326) wait for their slices. |
| AC4 local Changes, navigation, conversation and approvals intact | See Repository suites. |
| AC5 performance and keyboard/contrast evidence; human screen-reader gate | Measured below. Keyboard and contrast are automated. **The VoiceOver pass is open**. |
| AC6 columns kept separate, tied to SHA and environment | This page. |
| AC7 reproducible, readiness stated, no merge by this task | Commands below. Readiness: read-only inbox and navigation are ready behind the local switch. Overview, diffs, review and writes are not built. |

## Measurements (E1, product `0e674e7`)

From `e2e/code-review-measure.spec.ts` with `MODEX_MEASURE`. These are product fixtures, not GitHub's limits.
GitHub serves at most 1,000 search results and 3,000 files, and omits very large patches. No budget is enforced
yet: #327 agrees budgets from a baseline like this one before gating on them. The machine was under heavy load
(load average 31–34).

| Fixture | Measured |
| --- | --- |
| Empty Code Review | 174 DOM nodes; renderer resident 136.3 MiB |
| 300-row inbox, first page | 877 ms from the rail click to the rows, 2 searches, 5 gh requests, 31 rows, 360 nodes, 145.4 MiB |
| 9 × Show more | 116–192 ms each (median 136); one search per page; 1 lookup of the repository in all; 14 gh requests in total |
| All 300 rows mounted | 301 rows, 1,708 nodes, 192.3 MiB; scrolling to the end and painting took 27 ms; opening the bottom row took 60 ms |
| 1,000-file PR, files over IPC | 10 pages, 31 gh requests (1 overview + 10 × list, plus a PR read on either side of each page), 189 KB of replies, 2.9 s |
| One 3 MiB textual patch over IPC | ready, 3.2 MB reply, 235 ms. No diff is rendered yet: that is #324's |

The inbox mounts every row it has loaded (about 4.7 nodes per row) and doesn't virtualize. At GitHub's
1,000-result cap that would be about 4,900 nodes. #322 and #327 should agree whether that needs a budget.

## Keyboard and contrast (E1, product `0e674e7`)

From `e2e/code-review-a11y.spec.ts`, with `MODEX_A11Y`, over the production read path.

**Contrast**, WCAG 2 against the first opaque background, lowest per theme:

| Text | Graphite | Jev | OpenCoven |
| --- | --- | --- | --- |
| Row meta (login · age), the lowest | 5.12 | 6.43 | 6.39 |
| Group label | 5.99 | 7.61 | 7.68 |
| PR id in the header, pane placeholder | 6.18 | 8.00 | 7.36 |
| Row title, PR tab, search text | 12.48 | 14.04 | 14.27 |

Everything measured is at least 4.5:1. The unavailable actions measure 11.0 or more, though WCAG exempts
inactive controls. The search field shows focus by turning its border the accent colour; its 3:1 non-text
contrast (WCAG 1.4.11) was not measured.

**Tab order.** At 1440×900, starting from the rail button:

> Inbox actions → search → selected row → (PR header) Pin, Copy link, Open in GitHub, Review with Codex,
> Review instructions, Merge → (Changes header) the same six → two separators (pane and tree dividers) →
> PR tab → its close → Changes tab → its close → New tab → split toggle.

At 900×600 the split folds to one pane, so there is one header and one tab. Every stop showed a focus indicator.
Two observations for #322 and for Val's VoiceOver pass, not failures:

- The tab strip is drawn in the title bar above the panes, but it comes **after** the panes in Tab order,
  because it comes later in the DOM.
- At 1440×900 both tabs are Tab stops. At 900×600 only the selected one is, and the arrow keys move between them.

## Visual comparison

`e2e/code-review-journey.spec.ts` writes `test-results/ui-code-review/{R1,R4,split-1440,narrow-900}.png` with a
`manifest.json`. The manifest records viewport, DPR, locale, theme, font and pane geometry.

These launches must leave `MODEX_E2E` unset, because it disables the read service. Without it the window can't
grow taller than the display. `fitWindow` therefore keeps the requested width and caps the height. A capped run
is annotated `display-limited`, and the manifest records the size actually used. On E1 every capture was at its
full size: 1766×1057, 1764×1047, 1440×900 and 900×600. GitHub's macOS runner gives about 677 px of height, so
CI's captures are shorter. Compare them with:

```sh
pnpm run ui:compare --captures test-results/ui-code-review <folder holding R1.png and R4.png>
```

**Blocked: the originals are gone.** Val confirmed on 2026-10-22 that R1–R4 no longer exist. They are not
at the [manifest](../design/code-review.md#references-and-calibration)'s `~/Desktop` path, and Spotlight
finds no file with those names. No capture has been or can be compared with an original, and nothing here
claims pixel fidelity. What remains:

- The journey checks pane geometry against the manifest's measured numbers, through CR-3's built-geometry table.
- `ui:compare` stays ready for new references, if Val re-captures them. Each needs its own manifest row and
  checksums.

The captures are kept outside the repository; they show only synthetic data.

## Repository suites

The branch's full run on E1 checks local Changes/Discard, navigation, threads, conversation and approval:
`pnpm build && pnpm test`, then `pnpm test:e2e`. It ran at product `0e674e7`, with this branch's specs, while
the machine's load average was 30–77 from other sessions.

| Step | Result |
| --- | --- |
| `pnpm build` | passed |
| `pnpm test` | **exit 1.** The suites passed 117/117, 16/16, and 1,804 of 1,821 with 16 skips, but 1 was **cancelled**: `claude-lifecycle` "an unconfirmed stop keeps the worktree…" hit its 6 s timeout. That file passed 25/25 on its own. The chain stopped before the five `.mjs` suites, which passed 21/21 on their own. |
| `pnpm test:e2e` | **exit 1:** 402 passed, 6 skipped (opt-in), 1 **failed**. `conversation-rendering` "Markdown stays usable … keyboard Copy" read "Copy" where it expected "Copied". It passed 1/1 on its own. It asserts the system clipboard, which other sessions on this Mac share. All 29 Code Review specs passed inside the run. |

Neither failure touches Code Review, and this branch changes no product code. Neither counts as passing
here. The clean-machine run of record is `CI` above: the required macOS check on `17f53a5`, with unit 0 failed
and e2e 406 passed, 3 skipped, 0 failed.

## Open gates and owners

1. **Authenticated re-run on `main`: done** (`A-main`, 2026-10-22). Re-run when a slice changes the read path.
   A second real account has never been used.
2. **Original-reference comparison: blocked.** The originals are gone (Val, 2026-10-22). It can resume only
   if Val re-captures references, which would be new references with their own checksums.
3. **Human VoiceOver and keyboard pass:** Val, with the [checklist](2026-10-22-cr8-voiceover/checklist.md).
4. **#323 overview and activity:** add R2 (scroll to activity) to the journey; extend "hostile content" to the
   rendered description and comments; check the composer clearance.
5. **#324 remote diff:** add file selection and context expansion to the journey; check delayed patches during a
   head change in the UI; measure 1,000 files and the 3 MiB patch as rendered; agree budgets.
6. **#325 native review:** add R3 to the journey; provider stop, unknown completion and restart with no duplicate
   start (the `claude`/`codex` recorders are already in place); an authorized live native smoke.
7. **#326 writes:** at-most-once submission, a lost response, and restart reconciliation in fixtures; an
   authorized disposable-target canary.
8. **Staged enablement and rollback** (#327). This waits until a capability beyond reads exists. Today the
   only switch is the local `modex.codeReview` flag, and turning it off hides a read-only surface.

## Reproducing

From `apps/desktop` in a worktree at the SHA under test:

```sh
pnpm run build
npx playwright test e2e/code-review-journey.spec.ts e2e/code-review-regressions.spec.ts e2e/code-review-a11y.spec.ts e2e/code-review-measure.spec.ts
MODEX_MEASURE=/tmp/cr8-measure.json MODEX_A11Y=/tmp/cr8-a11y.json npx playwright test e2e/code-review-measure.spec.ts e2e/code-review-a11y.spec.ts
npx playwright test e2e/code-review-navigation.spec.ts e2e/code-review-ipc.spec.ts
node --test dist/test/code-review-*.test.js
```

The `F-prod` specs need no GitHub login. They remove token variables, point `GH_CONFIG_DIR` at a throwaway
folder, and put a synthetic `gh` first on PATH. They make no network request and start no model.

Evidence from this run (captures, measurement and contrast JSON, logs) is kept outside the repository at
`~/Documents/Codex/artifacts/modex-cr8-acceptance/2026-10-22/`.

## Checkpoint

- **SHA:** product `0e674e7` (main). This branch adds tests, one fixture, a capture option for `ui:compare`, and
  docs.
- **Next action:** when #323 opens a PR, run the journey against its head and add the R2 step.
