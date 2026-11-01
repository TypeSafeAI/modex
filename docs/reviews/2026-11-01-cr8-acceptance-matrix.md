# Code Review acceptance matrix (CR-8), refreshed 2026-11-01

CR-8 ([#327](https://github.com/TypeSafeAI/modex/issues/327)) for the Code Review workspace
([#319](https://github.com/TypeSafeAI/modex/issues/319)). This page refreshes the
[2026-10-22 baseline](2026-10-22-cr8-acceptance-matrix.md) to `main` at `0a8c513`. The baseline stays as written
for product `0e674e7`; its environments (`U`, `F-nav`, `F-ipc`, `F-prod`, `CI`, `A-main`, `A-321`, `A-349`,
`A-322`), measurements, contrast table and E1 description still apply to that SHA and are not repeated here.

**Code is on `main` for every slice; acceptance is not complete.** CR-2 #366; CR-3 #367 `af49881`, #438
`afec85b`; CR-4 #393 `6c40547`; CR-5 #404 `e3527f4`; CR-6 #396 `03ce71a`, #422 `b643617`, #426 `d0482a0`; CR-7
#410 `deb373a`, #416 `b3aad0d`; CR-8 #440 `d1cc80a`, #441 `eca2bd9`; #464 `3d72c6e`. All of it shipped in v0.4.0
and v0.4.1 except #464, which is evidence only. Nothing has been run against a live provider, written to GitHub
live, compared with the original references, or checked by a person with VoiceOver. No row below is "not
started". A cell that names no run says **open** and who owns it. No cell says "pass" for a check that didn't run.

Columns as in the baseline: **Fixture** (Node tests, or real Electron with synthetic `gh`/`claude`),
**Authenticated** (read-only through a real `gh` login), **Live provider / write** (an authorized native-CLI turn,
#325; an authorized write on a disposable target, #326), **Human** (a person, keyboard/VoiceOver or references).

## Environments added since the baseline

| ID | What ran | SHA | Result |
| --- | --- | --- | --- |
| `A-323` | CR-4 authenticated **service** smoke (`CodeReviewService` + `ghTransport`), BunsDev, TypeSafeAI/modex PR #334 head `5106c0d` ([cr4-overview](2026-10-23-cr4-overview.md)) | candidate `485391a` (branch `cr4-overview`, before #393 merged) | overview, activity (35 objects, complete) and 13 checks ready. One current-head deployment read through the real deployment/status endpoints. `stack` unavailable (the PR is closed). Not rendered in Electron |
| `A-324` | CR-5 authenticated **service** smokes ([cr5-remote-diffs](2026-10-23-cr5-remote-diffs.md), [cr5-merge-base](2026-10-24-cr5-merge-base.md)) on PR #393 head `52375d4` | CR-5 integration candidate (before #404 merged) | (1) 15/15 files, 15/15 patches parsed complete, an exact-head anchor, first context line matched. (2) 2026-10-24 merge-base probe: target `2824ed7`, base `68860a0`. Deleted line, base context and anchor matched the merge base. Not rendered in Electron |
| `A-main-2` | #464's re-run of the read-only navigation probe (`live-navigation.mjs`), BunsDev, gh 2.102.0 ([cr3-acceptance-resume](2026-10-30-cr3-acceptance-resume.md)) | main `f51ef7e` | 6/6: inbox and repo search; #349 and #348 resolved with overview totals; back/forward, Changes and split; pin after reload; missing-PR error; signed-out |
| `U-1101` | `node --test --test-force-exit dist/test/code-review-*.test.js dist/test/claude-backend.test.js dist/test/desktop-service-drain.test.js` after `pnpm -s run build:main` | `main` `0a8c513` | 224 tests: 223 passed, 0 failed, 1 skipped (Windows-only) |
| `N` | `MODEX_CR6_NATIVE=1 node --test --test-force-exit test/code-review-isolation.native.test.mjs`: installed CLIs in a disposable home under `sandbox-exec`, scripted loopback provider, synthetic key; no account, no real inference | `main` `0a8c513`; **Claude Code 2.1.316**, **codex-cli 0.166.0** | 6 of 6 passed, 0 skipped. Production argv advertises only `Read`; Bash, Write, WebFetch and MCP calls refused; outside and symlink reads refused by `--restricted`. Codex read-only still allows shell and outside reads (why it is not offered). [Record](2026-10-28-cr6-native-review.md#re-run-on-claude-code-21316-2026-11-01) |
| `F-1101` | `pnpm exec playwright test` on the journey, regressions, a11y, measure, agent, actions, navigation and scroll specs: real Electron, production preload/IPC/services, synthetic `gh` and `claude` | `main` `0a8c513` | 51 of 51 passed in 6.2 min (journey 1, regressions 9, a11y 5, measure 2, agent 6, actions 14, navigation 12, scroll 2). Journey captures R1–R4, split-1440 and narrow-900 with populated R1 checks and R4 diff |
| `S-1101` | `pnpm build && pnpm test && pnpm test:e2e` | `main` `0a8c513` + this page's docs | FULLSUITE |

**E2** (2026-11-01): Mac17,6 (Apple M5 Max), macOS 27.2 (Darwin 27.2.0), Node v24.22.0, Electron 44.4.5,
Playwright 1.63.0, gh 2.102.0. Other sessions were running: load average about 37–43, so no timing here is a
budget. Logs and captures are outside the repository at `~/.claude/task-evidence/lane-c-2026-11-01/`.

"journey" is `code-review-journey.spec.ts` (R1 → R2 → R3 → R4; R2/R3 from #440, R1 checks and R4 diff from
#464). "review-flow" is the `code-review-agent.spec.ts` case from #441 (populated diff → synthetic native
finding → anchored draft → explicit submit → crash recovery, exactly one provider run and one synthetic write).
The baseline's `F-prod` regressions test named "dispatch" no longer exists; its no-dispatch loop now sits in
"hostile content" and covers the New tab button only, because Review, instructions and Merge are built.

## Controls C01–C82

Status values: *built*, *unavailable*, *deviation Dn*, *needs decision N*, *unchanged*, or *not built* where the
inventory left a control out. "unverified" in a Fixture cell means the control is in the code but no spec was
found that asserts it; it is not a pass.

| ID | Control | Owner | Status | Fixture | Authenticated | Live provider / write | Human |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C01 | Traffic lights, window drag | native chrome | deviation D5 | — (macOS) | — | — | — |
| C02 | Back / forward | #322 | built | `code-review-navigation.spec.ts` "back and forward…"; journey (no re-read) | `A-322`, `A-main`, `A-main-2` | — | open (VoiceOver) |
| C03 | Inbox pane toggle | #322 | built | `code-review-navigation.spec.ts` back/forward test | — | — | open (VoiceOver) |
| C04 | Top-right buttons | shell | deviation D9 (only the split toggle applies) | `code-review-navigation.spec.ts`; journey (split toggle) | `A-322`, `A-main`, `A-main-2` (split) | — | open (VoiceOver) |
| C05 | PR tab: icon, title, close | #322 | built | `code-review-navigation.spec.ts`; journey; `code-review-a11y.spec.ts` | — | — | open (VoiceOver) |
| C06 | Changes tab with +/− | #322 | built | `code-review-navigation.spec.ts`; journey (totals from the production overview) | `A-322`, `A-main`, `A-main-2` (overview totals) | — | open (VoiceOver) |
| C07 | New tab (+) | needs decision 6 | unavailable | `code-review-navigation.spec.ts` (aria-disabled); `code-review-regressions.spec.ts` "hostile content" (double-click, Enter and Space dispatch nothing) | — | — | open (VoiceOver) |
| C08 | Code Review rail button | #322 | built | `code-review-navigation.spec.ts`; journey (`aria-current`) | `A-322` | — | open (VoiceOver) |
| C09 | Other rail icons | shell | unchanged | full `pnpm test:e2e` | — | — | — |
| C10 | Account monogram | shell | unchanged | full `pnpm test:e2e` | — | — | — |
| C11 | Inbox title and ⋯ menu (Refresh) | #322 | built | `code-review-navigation.spec.ts` (Escape returns focus); `code-review-a11y.spec.ts` | — | — | open (VoiceOver) |
| C12 | Search or paste a PR link | #322 | built | `code-review-contract.test.ts` (`parsePrLocator`); `code-review-navigation.spec.ts`; `code-review-regressions.spec.ts` "hostile content" | `A-322`, `A-main`, `A-main-2` (search, links, missing PR) | — | open (VoiceOver) |
| C13 | "Authored by me" group | #322 | built | contract test; `code-review-navigation.spec.ts`; `code-review-regressions.spec.ts` "incomplete data" | `A-322`, `A-main`, `A-main-2` (inbox) | — | open (VoiceOver) |
| C14 | "Needs my review" group | #322 | built | as C13 | `A-322` | — | open (VoiceOver) |
| C15 | PR row: title, author, age | #322 | built | `code-review-navigation.spec.ts`; journey | `A-322` | — | open: reference comparison |
| C16 | Row avatar and badge | needs decision 1 | needs decision 1 (not built; D1 login only) | — | — | — | — |
| C17 | Row stack icon | #322 | built | `code-review-navigation.spec.ts` (only for `stackHint: true`, named "inferred") | — | — | open (VoiceOver) |
| C18 | Selected and hover rows | #322 | built | `code-review-navigation.spec.ts`, journey (`aria-current`, R1/R4 captures) | — | — | open: reference comparison |
| C19 | Show more | #322 | built | contract test (`knownCount`, `mergePages`, #438 same-total rule); `code-review-navigation.spec.ts` pagination ×3; `code-review-measure.spec.ts` | — | — | open (VoiceOver) |
| C20 | Independent inbox scroll | #322 | built | `code-review-navigation.spec.ts` keyboard test; `code-review-scroll.spec.ts` ×2 (#438 `afec85b`) | — | — | — |
| C21 | State pill "Open ▾" | #326 (decision 2 settled 2026-10-25) | built (#416 `b3aad0d`); D7: no menu until main answers, none for merged | `code-review-actions.spec.ts` "the state menu closes and reopens a PR, and converts it to draft…", "a state change GitHub may have made stays in doubt…"; `code-review-writes.test.ts`, `code-review-write-ipc.test.ts`; `code-review-a11y.spec.ts` (pill contrast) | — | open (needs disposable repo Val names, #326) | open (VoiceOver) |
| C22 | Repository and number | #323 | deviation D6 (interim): the header still reads `pr.locator` from the row or resolved link (`PrPane.tsx` `PrHeader`), not `overview.locator` | `code-review-navigation.spec.ts` (`title` gives `owner/repo`) | — | — | open (VoiceOver) |
| C23 | Loading spinner | #322 | built | `code-review-navigation.spec.ts` (reduced motion); `code-review-regressions.spec.ts` "identity" | — | — | — |
| C24 | Pin | #322 | built | `code-review-navigation.spec.ts` (local, per account, survives reload) | `A-322`, `A-main`, `A-main-2` (pin after reload) | — | open (VoiceOver) |
| C25 | Copy link | #322 | built | contract test (`canonicalPrUrl`); `code-review-navigation.spec.ts` (clipboard) | — | — | open (VoiceOver) |
| C26 | Open in GitHub | #322 | built | `code-review-navigation.spec.ts` (canonical link only) | — | — | open (VoiceOver) |
| C27 | Review with **Claude** (no longer "with Codex"; Codex is not offered) | #325 | built (#422 `b643617`, #426 `d0482a0`) | `code-review-agent.spec.ts` (5 cases + review-flow #441 `eca2bd9`); `code-review-regressions.spec.ts` "hostile content" (opening the panel starts nothing); `code-review-agent.test.ts`; opt-in `code-review-isolation.native.test.mjs` (`N`, 2.1.316) | — | open (needs repo Val names, #325) | open (VoiceOver) |
| C28 | Review settings (gear) | #325 | built (#422 `b643617`) | `code-review-agent.spec.ts` "the instructions popover states its scope…"; journey R3 (#440 `d1cc80a`); `code-review-regressions.spec.ts` | — | open (needs repo Val names, #325) | open (VoiceOver) |
| C29 | Merge | #326 | built (#416 `b3aad0d`); D10: one button and a panel, no chevron | `code-review-actions.spec.ts` ×4 ("Merge offers only the repository's methods…", "…rules block it…", "a head that moves between preview and merge…", "a crash during a merge…"); `code-review-merge-preflight.test.ts`; `code-review-writes.test.ts`; `code-review-navigation.spec.ts` (disabled under `MODEX_E2E`) | — | open (needs disposable repo Val names, #326) | open (VoiceOver) |
| C30 | Title | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` "R1 metadata and R2 pagination…", "hostile Markdown is inert and narrow content remains reachable"; journey | `A-323` (service read only) | — | open: reference comparison |
| C31 | Edit title | #326 (decision 3 settled) | built (#416 `b3aad0d`) | `code-review-actions.spec.ts` "an edit saves only the changed field, and never overwrites a change made on GitHub meanwhile"; `code-review-writes.test.ts` | — | open (needs disposable repo Val names, #326) | open (VoiceOver) |
| C32 | Author, age, head → base | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` "R1 metadata…"; journey | `A-323` (service read only) | — | open: reference comparison |
| C33 | Description Markdown | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` "hostile Markdown is inert…"; `code-review-regressions.spec.ts` "hostile content" | `A-323` (service read only) | — | open (VoiceOver); open: reference comparison |
| C34 | Reaction under the description | deferred | deviation D3 | — | — | — | — |
| C35 | Edit description | #326 (decision 3 settled) | built (#416 `b3aad0d`) | as C31 | — | open (needs disposable repo Val names, #326) | open (VoiceOver) |
| C36 | Summary card: files and totals | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts`; journey (R4) | `A-323` (service read only) | — | open: reference comparison |
| C37 | Summary card: comments | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` | `A-323` (service read only) | — | open: reference comparison |
| C38 | Summary card: Request review | #326 (decision 4 settled) | built (#416 `b3aad0d`) | `code-review-actions.spec.ts` "reviewer requests go to others, need triage, and show on the PR…"; `code-review-writes.test.ts` | — | open (needs disposable repo Val names, #326) | open (VoiceOver) |
| C39 | Summary card: passing checks | #323 | built (#393 `6c40547`) | contract test (`summarizeChecks`); `code-review-overview.spec.ts`; journey R1 checks (#464 `3d72c6e`) | `A-323` (13 checks, service) | — | open: reference comparison |
| C40 | Sidebar: Changes | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts`; journey | `A-323` (service read only) | — | open: reference comparison |
| C41 | Sidebar: Stack | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` ("Inferred"); `code-review-overview.test.ts` "stack duplicates and invalid positions never invent an order…"; journey shows "not found" (no branches in that world) | `A-323` (closed PR: `stack` unavailable, as designed) | — | open (VoiceOver) |
| C42 | Sidebar: comment count | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` "stale checks and unavailable collections do not become empty…" | — | — | open (VoiceOver) |
| C43 | Sidebar: reviewers and + | #323 list; + #326 (decision 4 settled) | built: list #393 `6c40547`, + #416 `b3aad0d` | `code-review-overview.spec.ts`; `code-review-actions.spec.ts` "reviewer requests…" | — | +: open (needs disposable repo Val names, #326) | open (VoiceOver) |
| C44 | Checks with elapsed clock | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` ("Elapsed at read"); journey R1 (#464) | `A-main` (13/13 read, pre-render), `A-323` (13 ready) | — | open (VoiceOver) |
| C45 | Check row states | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` (pending state, keyboard expand); contract test | `A-323` (service read only) | — | open (VoiceOver) |
| C46 | Show more checks | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` ("Show all checks") | — | — | open (VoiceOver) |
| C47 | Independent sidebar scroll | #323 | built (#393 `6c40547`) | `code-review-scroll.spec.ts` (#438 `afec85b`, where the sidebar is its own scroller) | — | — | — |
| C48 | Activity heading and filter | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` "refresh does not mix fresh and pending cached pages…" (filter keeps focus) | — | — | open (VoiceOver) |
| C49 | Commit groups | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` ("7 commits"); `code-review-overview.test.ts` (dedup) | `A-main` (activity 36, read), `A-323` (35, complete) | — | open (VoiceOver) |
| C50 | "opened this pull request" | #323 | built (#393 `6c40547`; rendered in `PrOverview.tsx`) | unverified: no spec found that asserts the text | `A-323` (opening enrichment read) | — | open: reference comparison |
| C51 | Bot comment card (⋯ menu: Copy comment link, Add to chat) | #323 | built (#393 `6c40547`) | `code-review-overview.spec.ts` (cards); the ⋯ menu's Copy comment link is unverified (no spec found); its Add to chat is covered under C54 | — | — | open (VoiceOver) |
| C52 | Deployment table and preview links | #323 | built (#393 `6c40547`) | `code-review-overview.test.ts` "preview destinations reject credentials…"; `code-review-read-service.test.ts`; `code-review-overview.spec.ts` | `A-323` (one real deployment and status) | — | open (VoiceOver) |
| C53 | Third-party bot button | #323 | deviation D4 (inert) | `code-review-overview.spec.ts` "hostile Markdown is inert…"; `code-review-regressions.spec.ts` "hostile content" | — | — | — |
| C54 | Reaction and Add to chat | #325 (reactions D3) | built: Add to chat (#422 `b643617`); reactions deviation D3 | `code-review-agent.spec.ts` "a question is answered by a run of its own, with 'Add to chat' quoting a comment into it" | — | open (needs repo Val names, #325) | open (VoiceOver) |
| C55 | Comment composer | #326 | built (#416 `b3aad0d`) | `code-review-actions.spec.ts` "a comment stays a local draft across a reload…", "navigating before the draft debounce…", "a denial and a moved head…", "a crash mid-send…", "a send GitHub may or may not have received…"; `code-review-writes.test.ts`, `code-review-write-ipc.test.ts`, `code-review-draft-buffer.test.ts`, `code-review-intents.test.ts` | — | open (needs disposable repo Val names, #326) | open (VoiceOver) |
| C56 | Review instructions popover (R3) | #325 | built (#422 `b643617`) | `code-review-agent.spec.ts` instructions case; journey R3 (#440 `d1cc80a`: focus, Escape, scroll kept) | — | open (needs repo Val names, #325) | open (VoiceOver) |
| C57 | Ask about this pull request | #325 | built (#422 `b643617`); an inline field in the overview's review section, not a floating composer | `code-review-agent.spec.ts` question case; `code-review-agent.test.ts` | — | open (needs repo Val names, #325) | open (VoiceOver) |
| C58 | Attach (+) | #325 | not built (left out; no numbered decision covers it) | — | — | — | — |
| C59 | Model and reasoning effort | #325 | built: model select only, effort left out (#422 `b643617`) | `code-review-agent.spec.ts` (runs with `--model`); `code-review-agent.test.ts` (unknown model refused) | — | open (needs repo Val names, #325) | open (VoiceOver) |
| C60 | Voice input | deferred | deviation D5 | — | — | — | — |
| C61 | Composer clearance | #323 / #324 | built at fixture (#393 `6c40547`): bottom clearance; final Comment in viewport at 900×600 | `code-review-overview.spec.ts` "hostile Markdown is inert and narrow content remains reachable"; `code-review-scroll.spec.ts`. Unverified against CR-6's inline Ask/review section | — | — | open (VoiceOver) |
| C62 | Header repeated over Changes | #322 | built; now repeats the live C21 and C27–C29 | `code-review-navigation.spec.ts`; journey (R4); `code-review-a11y.spec.ts` | — | — | open (VoiceOver) |
| C63 | Changes ⋯ menu and view toggles | #324 | built in part (#404 `e3527f4`): "Wrap lines" and "Highlight changes" toggles. The ⋯ menu and the tree/image/layout toggles are left out, as the inventory allows | unverified: no spec found that toggles them (they show in the diff spec and journey captures) | — | — | open (VoiceOver); open: reference comparison |
| C64 | File header | #324 | built (#404 `e3527f4`) | `code-review-diff.spec.ts` "grouped diffs, both gutters, hierarchy, filter…"; review-flow (#441) | `A-324` (service: 15/15 files) | — | open (VoiceOver); open: reference comparison |
| C65 | Viewed toggle | needs decision 5 | needs decision 5 (not built) | — | — | — | — |
| C66 | File ⋯ menu (never Discard) | #324 | built (#404 `e3527f4`): Copy path and Open in GitHub only | `code-review-regressions.spec.ts` "local Changes stay local"; `code-review-diff.spec.ts` "…use remote data only". The menu items themselves are unverified (no Code Review spec found that opens them) | — | — | open (VoiceOver) |
| C67 | Folded lines, expand | #324 | built (#404 `e3527f4`) | `code-review-diff.spec.ts` "expanding context asks the exact remote revision…", "review: context expands adjacent to both ends…", "context text budget is shared…"; `code-review-diff.test.ts` "context windows reveal both ends…" | `A-main` (context read), `A-324` (base context matched the merge base) | — | open (VoiceOver) |
| C68 | Line numbers, add/remove rows | #324 | built (#404 `e3527f4`) | `code-review-diff.test.ts` ×9; `code-review-diff.spec.ts` "line anchors have one keyboard entry per file…", "old-line anchors name the merge base…"; review-flow | `A-324` (15/15 patches parsed; anchor) | — | open (VoiceOver) |
| C69 | "More unchanged context…" | #324 | built (#404 `e3527f4`; `ContextFold` when `count` is null) | unverified: no spec found that asserts the text (`code-review-diff.spec.ts` clicks `/Expand.*unchanged/`) | — | — | open (VoiceOver) |
| C70 | Collapsed file sections | #324 | built (#404 `e3527f4`) | `code-review-diff.spec.ts` (Collapse a file; "1,000 files keep… mounted patch bodies bounded") | — | — | open (VoiceOver) |
| C71 | Horizontal scroll per file | #324 | built (#404 `e3527f4`; `.cr-patch { overflow-x: auto }` with wrap off) | unverified: no spec found | — | — | — |
| C72 | Filter files | #324 | built (#404 `e3527f4`) | `code-review-diff.spec.ts` (Filter remote files) | — | — | open (VoiceOver) |
| C73 | Folder tree, selected file | #324 | built (#404 `e3527f4`) | `code-review-diff.spec.ts` "…hierarchy, filter and keyboard selection…", "narrow tree selection returns to the diff…"; `code-review-scroll.spec.ts`; journey R4 populated (#464 `3d72c6e`) | — | — | open (VoiceOver); open: reference comparison |
| C74 | Overview / Changes divider | #322 | built | `code-review-navigation.spec.ts` (keyboard resize persists across reload) | — | — | open (VoiceOver) |
| C75 | Diff / tree divider | #322 | built; pointer and keyboard resize still not asserted | `code-review-a11y.spec.ts` (reached by Tab as a separator); `code-review-navigation.spec.ts` (tree folds when narrow) | — | — | open (VoiceOver) |
| C76 | Keyboard path, 900×600 and 1440×900 | #327 | partial: the a11y spec still requires only CR-3's 12 controls | `code-review-a11y.spec.ts`; `code-review-navigation.spec.ts` keyboard test; `code-review-scroll.spec.ts` (focus kept); per-slice keyboard cases in the overview, diff, agent and actions specs | — | — | **open: [VoiceOver checklist](2026-10-22-cr8-voiceover/checklist.md) parts A–D for Val (result row empty)** |
| C77 | Overview column scroll | #323 | built (#393 `6c40547`) | `code-review-scroll.spec.ts` (#438 `afec85b`); journey R2 (overview moves, inbox doesn't) | — | — | — |
| C78 | Diff pane scroll | #324 | built (#404 `e3527f4`) | `code-review-scroll.spec.ts`; `code-review-diff.spec.ts` "returning from Overview preserves… overall scroll position" | — | — | — |
| C79 | File tree scroll | #324 | built (#404 `e3527f4`) | `code-review-scroll.spec.ts` (#438 `afec85b`) | — | — | — |
| C80 | Closing Changes / leaving the split | #322 | built | `code-review-navigation.spec.ts` back/forward test | — | — | open (VoiceOver) |
| C81 | Timeline and composer avatars | needs decision 1 | needs decision 1 (not built; D1 login only) | — | — | — | — |
| C82 | Access-mode indicator | needs decision 7 | needs decision 7 (not built; the review panel states the confinement in words) | — | — | — | — |

`A-322` keeps its baseline meaning: CR-3's authenticated navigation smoke on candidate `65e86dd` + `4dd5bb5`.
Decisions 2–4 (C21, C31, C35, C38, C43's +) were settled by Val on 2026-10-25 and built in #416. Decisions 1
(C16, C81), 5 (C65), 6 (C07) and 7 (C82) are still open.

## Acceptance criteria #321–#326

| AC | Criterion (short) | Fixture | Authenticated | Live provider / write | Status |
| --- | --- | --- | --- | --- | --- |
| #321 AC1 | List → detail → files over real main/IPC, isolated, no local mutation | `U`, `F-ipc`, `F-prod` journey (checkout unchanged) | `A-321` | — | met (issue closed) |
| #321 AC2 | Same PR number across repositories and accounts; account switch drops a delayed result | `U`; `F-prod` regressions "identity" ×2 | — (no second real account) | — | met at fixture level. A real `gh auth switch` mid-read was never run live |
| #321 AC3 | Revoked, denied, malformed, timeout, rate limit, partial, omitted patch, no secret leakage | `U`; `F-prod` "incomplete data" (gh stderr sentinel never reaches the renderer or a reply) | `A-349` | — | met |
| #321 AC4 | Head changes invalidate or label old diff/check data | `U`; `F-prod` "revision" (before the page: `head-changed`, files list never requested; during the page: `stale head-changed`) | — | — | met. The UI labelling landed with #324 (#404 `e3527f4`; `code-review-diff.spec.ts` "a new head cannot be overwritten by a delayed file page") |
| #321 AC5 | Authenticated read-only smoke, kept separate | — | `A-321`, `A-349`, `A-main` | — | met, and re-run on main |
| #321 AC6 | Existing Changes, connection and login tests green; no new permissions or writes | full suites (see Repository suites) | — | — | met at merge. Re-checked in this branch's full run |
| #322 AC1 | R1 and R4 through real controls; PR and tab identity correct | `F-nav`; `F-prod` journey (rail → row → split, with captures at the references' CSS sizes and geometry within 2 px of CR-3's table) | `A-322`, `A-main`, `A-main-2` | — | met for the host; R1 checks and R4 diff populated since #464 (`3d72c6e`). **Original-reference comparison is open** (see Visual comparison) |
| #322 AC2 | Rapid switching shows no stale reply; back/forward don't replay | `F-nav` ×3; `F-prod` "identity" ×2, journey (no re-read) | `A-322` (back/forward) | — | met |
| #322 AC3 | Scroll regions independent; resize and reopen keep controls in the window | `F-nav` keyboard test; `code-review-scroll.spec.ts` ×2 (#438 `afec85b`) | — | — | met at fixture: list, overview, diff and tree scroll alone and keep focus at 1440×900 and 900×600 (#438) |
| #322 AC4 | Keyboard-only at 900×600 and 1440×900; focus returns; reference DPR | `F-nav`; `F-prod` a11y | — | — | automated checks met; **human VoiceOver open** |
| #322 AC5 | Local Changes, threads and tabs pass; no remote PR reaches Discard | `F-nav`; `F-prod` "local Changes stay local" (a dirty file at the PR's own path is untouched; `changes:revert` never called) | — | — | met at fixture level; the full-suite result is under Repository suites |
| #322 AC6 | Fixture and authenticated smoke reported separately | this table | `A-322`, `A-main`, `A-main-2` | — | met, and re-run on main |
| --- | --- | --- | --- | --- | --- |
| #323 AC1 | R1 and R2 by selecting and scrolling the same PR; real adapter or labelled fixtures | `code-review-overview.spec.ts` "R1 metadata and R2 pagination…" (replaced fixture handler); journey R1→R2 through the production service with synthetic gh (#440 `d1cc80a`; R1 checks #464 `3d72c6e`). Evidence: [cr4-overview](2026-10-23-cr4-overview.md), [cr8-journey-refresh](2026-10-28-cr8-journey-refresh.md) | `A-323` (service, PR #334) | — | met at fixture (#393 `6c40547`). **Open:** original R1/R2 comparison (originals gone, Val) |
| #323 AC2 | Pagination and refresh: no duplicates, lost scroll or cross-PR bleed; partial never zero | `code-review-overview.spec.ts` ×8 (failed pages, refresh, delayed bleed, partial first page, retry cursor); `code-review-overview.test.ts`; [cr4-overview](2026-10-23-cr4-overview.md) | `A-323` (activity complete) | — | met at fixture (#393 `6c40547`). A live account switch was not exercised |
| #323 AC3 | Stale checks, inferred stack and comment-derived previews kept distinct | `code-review-overview.spec.ts` "stale checks and unavailable collections…"; `code-review-overview.test.ts` (stack, preview destinations, stale retention); `code-review-read-service.test.ts` | `A-323` (deployment; stack unavailable) | — | met at fixture (#393 `6c40547`) |
| #323 AC4 | Hostile Markdown/HTML, unsafe schemes, misleading previews inert | `code-review-overview.spec.ts` "hostile Markdown is inert…"; `code-review-regressions.spec.ts` "hostile content"; `code-review-overview.test.ts` "preview destinations reject…" | — | — | met at fixture (#393 `6c40547`). No live untrusted PR content was run |
| #323 AC5 | Long titles, large descriptions, narrow windows readable; composer clearance | `code-review-overview.spec.ts` (900×600, final Comment in viewport); `code-review-scroll.spec.ts` (#438 `afec85b`) | — | — | met at fixture (#393). Clearance next to CR-6's inline review/Ask section is unverified. **Open:** VoiceOver (Val) |
| #323 AC6 | Every visible write control is connected to a verified CR-7 capability or is unavailable; no mutation by #323 | At #393 all writes were unavailable ([cr4-overview](2026-10-23-cr4-overview.md)). Since #416 `b3aad0d` they are connected through `code-review:write` (`code-review-actions.spec.ts`) | — | see #326 AC6 | met at fixture |
| #324 AC1 | R4 overview-plus-diff, tree, folds, selected file through real controls; match approved reference geometry | `code-review-diff.spec.ts` "captures populated R4 diff geometry and narrow keyboard file selection"; journey R4 populated (#464 `3d72c6e`); review-flow (#441 `eca2bd9`). Evidence: [cr5-remote-diffs](2026-10-23-cr5-remote-diffs.md) | — | — | met at fixture for the controls (#404 `e3527f4`). **Open:** approved-reference geometry, since the original R4 is missing (Val) |
| #324 AC2 | Old/new line references for additions, deletions, renames, no final newline; context keeps them | `code-review-diff.test.ts` ×9; `code-review-diff.spec.ts` "review: deleted ranges and renamed paths retain base anchors…", "old-line anchors name the merge base…"; [cr5-merge-base](2026-10-24-cr5-merge-base.md) | `A-324` (anchor; merge-base match) | — | met at fixture (#404 `e3527f4`), plus an authenticated service probe |
| #324 AC3 | PR, account or head change during a delayed patch can't overwrite; old anchors outdated | `code-review-diff.spec.ts` "head change cancels delayed context…", "a new head cannot be overwritten by a delayed file page", "sign-out during a delayed patch page…", "review: changing PR during a delayed patch request…", "payload mismatch is rejected…"; `code-review-regressions.spec.ts` "revision" | — | — | met at fixture (#404 `e3527f4`) |
| #324 AC4 | No Discard, arbitrary workspace read or code execution; local Changes tests pass | `code-review-diff.spec.ts` "expanding context asks the exact remote revision and never a local file"; `code-review-regressions.spec.ts` "local Changes stay local"; full suites | — | — | met at fixture (#404 `e3527f4`) |
| #324 AC5 | Binary, omitted, oversized and truncated disclosed; no invented code or false zeros | `code-review-diff.spec.ts` "binary, omitted, oversized and truncated patches disclose…", "review: closed omitted and oversized fifth files…", "a 3 MiB textual patch…"; `code-review-diff.test.ts` | `A-324` (15/15 complete) | — | met at fixture (#404 `e3527f4`) |
| #324 AC6 | Keyboard and narrow navigation; measured stress on a named environment; any agreed budget enforced | `code-review-diff.spec.ts` "1,000 files keep requests and mounted patch bodies bounded", "accepted token-dense patches…", "line anchors have one keyboard entry…", "narrow tree selection…"; `code-review-measure.spec.ts`. The named environment is in [cr5-remote-diffs](2026-10-23-cr5-remote-diffs.md) | — | — | met at fixture for the product bounds (#404). **Open:** VoiceOver (Val). Whether #327 has agreed a performance budget is unverified |
| #325 AC1 | R3 popover accessible, states scope, persists only the intended settings, records the version per run | `code-review-agent.spec.ts` "the instructions popover states its scope…"; journey R3 (#440 `d1cc80a`); `code-review-agent.test.ts` "instructions are versioned…". Evidence: [cr6-native-review](2026-10-28-cr6-native-review.md) | — | — | met at fixture (#422 `b643617`). **Open:** VoiceOver (Val) |
| #325 AC2 | No wrong-account or wrong-repository context; findings bound to the revision; new head marks results outdated | `code-review-agent.test.ts` "a start is refused when the account, head or target differ…"; `code-review-agent.spec.ts` "a scripted reply shows its findings bound to the head…"; review-flow (a later head disables promotion) | — | — | met at fixture (#422 `b643617`) |
| #325 AC3 | Adversarial content stopped by the real capability/isolation boundary | Opt-in `code-review-isolation.native.test.mjs` (6/6 on Claude 2.1.312, and again 6/6 on **2.1.316** with codex-cli 0.166.0 on 2026-11-01, `N`; scripted SSE provider, shipped `REVIEW_CONFINEMENT_ARGS`); `claude-backend.test.ts` (argv, `confinedEnvironment`); [cr6-isolation](2026-10-23-cr6-isolation.md) (#396 `03ce71a`; Codex refused, so not offered) | — | — | met at fixture (#396, #422). The confinement is the CLI's own flags with no OS sandbox. The native suite runs only with `MODEX_CR6_NATIVE=1` |
| #325 AC4 | Explicit start, streaming, stop, failure, unknown and restart; no duplicate inference | `code-review-agent.spec.ts` "a review starts only on Start…", "Stop ends a running review, and a crash mid-run reads as unknown…"; review-flow; `code-review-agent.test.ts` (unconfirmed exit, #426 `d0482a0`) | — | — | met at fixture (#422 `b643617`, #426 `d0482a0`) |
| #325 AC5 | Omitted files and unsupported references visible; no promotion to evidence, approval or merge | `code-review-agent.spec.ts` (coverage "file list cut short"; "Not found in the diff"; Add to review draft only for an anchored current-head finding); `code-review-agent.test.ts` `planSnapshot`/`bindFindings` | — | — | met at fixture (#422 `b643617`) |
| #325 AC6 | Native-CLI fixture tests through the real app; one authorized live smoke | `code-review-agent.spec.ts` (synthetic `claude`), native fixture as AC3 | — | open (needs repo Val names, #325). None is recorded ([cr6-native-review](2026-10-28-cr6-native-review.md) "Live evidence: None") | fixture half met (#422). **Open:** live smoke (Val names the repo) |
| #326 AC1 | Local until an explicit submit; main checks permission and identity; denials surfaced | `code-review-actions.spec.ts` "a comment stays a local draft…", "a denial and a moved head are shown as such…"; `code-review-writes.test.ts`; `code-review-write-ipc.test.ts`. Evidence: [cr7-write-submit](2026-10-25-cr7-write-submit.md), [cr7-write-repair](2026-10-26-cr7-write-repair.md) | — | — | met at fixture (#416 `b3aad0d`) |
| #326 AC2 | A double click sends at most one request; an ambiguous restart sends none and shows reconciliation | `code-review-actions.spec.ts` (double clicks for comment, merge and close; "a crash mid-send restarts in doubt…", "a send GitHub may or may not have received is never resent…"); review-flow (#441 `eca2bd9`); `code-review-intents.test.ts` (SIGKILL) | — | — | met at fixture (#416 `b3aad0d`) |
| #326 AC3 | Wrong account or repository, stale head, changed target, revoked permission and outdated anchor rejected or reconfirmed | `code-review-writes.test.ts` (rechecks, login change, withdrawn permission); `code-review-actions.spec.ts` "a head that moves between preview and merge…", "a denial and a moved head…"; inline-anchor validation in [cr7-write-repair](2026-10-26-cr7-write-repair.md) | — | — | met at fixture (#416 `b3aad0d`) |
| #326 AC4 | Merge passes the reviewed head, offers only supported methods, ignores checks and findings as permission; safe fallback | `code-review-merge-preflight.test.ts`; `code-review-actions.spec.ts` merge ×4; `code-review-write-ipc.test.ts` (one PUT carrying the intent's head). Evidence: [cr7-merge-preflight](2026-10-24-cr7-merge-preflight.md), [cr7-merge](2026-10-25-cr7-merge.md) | — | — | met at fixture (#416 `b3aad0d`). Limit: a queue set by classic branch protection is invisible to the rules read, so it falls back to GitHub's refusal |
| #326 AC5 | Drafts survive errors, stay isolated, aren't overwritten by stale responses; no credentials in output | `code-review-intents.test.ts` (CAS, isolation); `code-review-draft-buffer.test.ts`; `code-review-actions.spec.ts` "navigating before the draft debounce preserves the latest text"; `code-review-writes.test.ts` ("no token text in any reply") | — | — | met at fixture (#416 `b3aad0d`) |
| #326 AC6 | Mock main/IPC and Electron cover success, rejection, timeout, crash, reconciliation; live canary only on an authorized disposable target | `code-review-writes.test.ts`, `code-review-write-ipc.test.ts`, `code-review-actions.spec.ts` (14 cases) | — | open (needs disposable repo Val names, #326). No live write, merge or action has run | mock half met (#416). **Open:** disposable-target canary (Val names the repo) |

## #327's own criteria

| AC | Where it stands on `0a8c513` |
| --- | --- |
| AC1 R1–R4 in real Electron | All four reached through real controls over production reads with synthetic `gh` (`F-1101` journey). **Open (Val):** comparison with the original references, which are gone; needs re-captured references or Val's decision to accept re-captures. |
| AC2 every visible control has behaviour or an explicit unavailable state | Met at fixture: every control is built, a recorded deviation, or a named open decision (table above). Seven built controls have no asserting spec (follow-ups below). |
| AC3 isolation, injection, incomplete data, at-most-once | Met at fixture: read regressions, native denial on 2.1.316 (`N`), agent stop/unknown/restart, write at-most-once and reconciliation (`F-1101`). **Open:** the live smoke (#325) and live canary (#326). |
| AC4 local Changes, navigation, conversation and approvals intact | `S-1101` below, and the hosted required check on every landing PR. |
| AC5 performance, keyboard/contrast; human screen-reader gate | Baseline measurements and contrast stand for `0e674e7`; `F-1101` re-ran measure and a11y green. **Open (Val):** the [VoiceOver checklist](2026-10-22-cr8-voiceover/checklist.md), Result row empty. |
| AC6 columns kept separate, tied to SHA and environment | This page. |
| AC7 reproducible, readiness stated, no merge by this task | Commands below. **Readiness:** the whole workspace (inbox, overview, remote diff, Claude review and questions, writes and merge) is built and fixture-proven; packaged builds still hide it behind `modex.codeReview`. Not ready to show by default until the live and human gates are run or Val accepts them as open. |

## Staged enablement and rollback

Today the only switch is the per-home `localStorage["modex.codeReview"]` (`renderer/code-review/feature.ts`):
development builds show the destination, packaged builds hide it unless the value is `"on"`. Nothing else reads
it, and main's channels answer regardless of whether the destination is visible.

- **Stage 0, now:** hidden in packaged builds. Val (or a tester) turns it on per home from DevTools.
- **Stage 1, after the live smoke and canary pass on repositories Val names:** still hidden by default; testers
  use it on their own repositories. Writes stay preview-bound and at-most-once.
- **Stage 2, after VoiceOver and Val's call on the references and decisions 1, 5, 6, 7:** remove the switch (or
  invert it) in a product PR that Val approves. That PR updates `docs/status.md` and this matrix.

**Rollback:** setting the value to anything but `"on"` (or clearing site data for that home) hides the
destination on the next launch. That hides the surface; it does not cancel a write already sent. An in-doubt
write keeps its record in `<MODEX_HOME>/review-actions/state.json` and an unconfirmed review run in
`<MODEX_HOME>/review-agent/state.json`; both stay until a read-back or the person settles them, whether or not
the destination is visible. A product rollback (removing a capability) is a code change that waits for Val.

## Hand-off to Val, in one list

1. **VoiceOver (AC5, #322 AC4, #325/#326 rows):** from `apps/desktop` on `0a8c513` or later after `pnpm build`:
   `node ../../docs/reviews/2026-10-22-cr8-voiceover/seed.mjs /tmp/modex-cr8-voiceover`, run the printed
   `env … npx electron .` line, then follow the [checklist](2026-10-22-cr8-voiceover/checklist.md) and fill its
   Result row. Since 2026-11-01 the seed puts recorder `claude`/`codex` on PATH, so nothing reaches your login.
2. **R1–R4 references (AC1, #322 AC1, #323 AC1, #324 AC1):** a folder with `R1.png`–`R4.png`, or your decision
   to accept re-captures. Then `pnpm exec playwright test e2e/code-review-journey.spec.ts` and
   `pnpm run ui:compare -- --captures test-results/ui-code-review <folder>`.
3. **CR-6 live smoke (#325 AC6):** name a repository and PR on #325 and say go;
   [procedure](2026-10-28-cr6-native-review.md#live-smoke-procedure-325-ac6-not-run).
4. **CR-7 live canary (#326 AC6):** name a disposable repository on #326 and say go;
   [procedure](2026-11-01-cr7-live-canary.md).
5. **Decisions 1 (avatars C16/C81), 5 (Viewed C65), 6 (new tab C07), 7 (access mode C82).**
6. **The `modex.codeReview` packaged-build switch:** when it goes (stages above).

## Follow-ups found in this refresh (agent work, not gates)

- C22 still shows the repository and number from the inbox row or resolved link (`PrPane.tsx` reads
  `pr.locator`); D6 was meant to end when #323 bound `overview.locator`. Either bind it or record D6 as permanent.
- `code-review-a11y.spec.ts` still requires only CR-3's 12 controls; the overview, diff, review and write
  controls are not in its required Tab set (C76).
- No asserting spec for C50's text, C51's Copy comment link, C63's toggles, C66's menu items, C69's text, C71's
  horizontal scroll or C75's resize.
- C58 (Attach) and C59's effort are left out with no numbered decision; Val may want them recorded as D-rows.
- C61's clearance was planned for a floating composer; CR-6 built Ask inline and clearance was not re-measured.
- CR-4's and CR-5's authenticated evidence is service-level on pre-merge candidates (`A-323`, `A-324`); an
  authenticated Electron read of the overview and diff on `main` needs Val's authorization (GET only).

## Reproducing

From `apps/desktop` in a worktree at the SHA under test:

```sh
pnpm run build
node --test --test-force-exit dist/test/code-review-*.test.js dist/test/claude-backend.test.js dist/test/desktop-service-drain.test.js
MODEX_CR6_NATIVE=1 node --test --test-force-exit test/code-review-isolation.native.test.mjs
pnpm exec playwright test e2e/code-review-journey.spec.ts e2e/code-review-regressions.spec.ts e2e/code-review-a11y.spec.ts \
  e2e/code-review-measure.spec.ts e2e/code-review-agent.spec.ts e2e/code-review-actions.spec.ts \
  e2e/code-review-navigation.spec.ts e2e/code-review-scroll.spec.ts
```

Then `pnpm build && pnpm test && pnpm test:e2e` from the repository root. Copy `test-results/` elsewhere first;
Playwright wipes it.

## Checkpoint

- **SHA:** `main` `0a8c513`. This page changes docs only.
- **Next action:** Val names the two repositories (#325, #326) and answers decisions 1, 5, 6 and 7 on #319.
