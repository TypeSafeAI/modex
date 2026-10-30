# CF-4 closeout evidence, 2026-10-22

Issue: #277. Shared human gate: #281. This is a new receipt; historical results remain unchanged.

## Candidate and scope

- Base: current `origin/main`, `0e674e75237f393b8a1ba712061f5b303a61d5b4`, fetched and confirmed through GitHub on October 22.
- Source candidate: signed commit `93cfde3850ffd23acf7adacefb3a016ea174120e`.
- Owned worktree/branch: `cf4-closeout`; `scripts/worktree.sh check` passed.
- Machine: Mac17,6, Apple M5 Max (18 cores), 128 GiB, macOS 26.7.1 (25G241), Darwin 25.6.0, Node 24.22.0, pnpm 10.34.5.
- Already landed: typed turns, safe CommonMark/GFM, full replies, continuity, minimum-size fixes, and keyboard answer/Stop/Jump fixes. These are not reimplemented.
- Only renderer changes: explicit named, focusable table and code scroll regions. Existing focus styling now applies to code. No parser or turn grouping change.

## Keyboard and reduced motion

`e2e/markdown-keyboard.spec.ts` uses the same Markdown fixture as the human kit and captures. At 900×600, in all three themes, it traverses links → table → table link → Copy → code → final link and back with Tab/Shift-Tab, checks focus rings, scrolls overflow with arrow keys, checks exact clipboard bytes and no tool/approval, and inspects computed animation/transition/scroll styles under reduced motion.

Two failures were reproduced before repair: a table with a link is skipped by Tab, and Chromium's implicit code-scroll focus has no visible ring. The fixes use `tabIndex=0`, `role=region`, and accessible names. Disabled task checkboxes remain noninteractive.

An intermediate test run was 9 passed / 2 failed: the new test started traversal before the scripted reply finished streaming. Its initially-idle assertion was too early. It now waits for the final link and idle before testing the settled order. With corrected readiness, `table-traversal-red.log` confirms Tab focuses Evidence link instead of the table when the table fix is removed; `code-focus-red.log` confirms the missing code focus ring when only the code fix is removed. The fixes were restored and rebuilt. `focused-green.log`: all 9 cases pass (the six existing conversation-rendering cases and three theme traversal cases). Earlier accessible-name red runs are separately retained.

The historical `e2e/transcript-continuity.spec.ts` path is absent on this main. Current coverage is the streaming Copy-focus and code-selection case in `e2e/conversation-rendering.spec.ts`; do not count a nonexistent path as executed coverage.

## Performance: current main, before renderer changes were built

The unchanged built main ran `e2e/transcript-measure.spec.ts`, plus four additional fresh-process runs of its 200-turn case. Raw receipts: `main-measure.json`, `main-measure-2.json` through `main-measure-5.json`.

Fixture: 200 turns, 1,400 items, 3,001,221 saved bytes. Each measurement launches a fresh Electron process, opens the short thread first, then times the click through the last answer becoming visible. Every receipt reports `selectedAtLaunch: false`, 1,400 rendered items, and no item/item_update resend.

| Fresh launch | First open (ms) | Median reopen (ms) |
| --- | ---: | ---: |
| 1 | 129 | 58 |
| 2 | 129 | 56 |
| 3 | 127 | 60 |
| 4 | 135 | 64 |
| 5 | 154 | 70 |

Median first open: 129 ms. The 3 MiB / 48-delta log fixture sent 663,894 bytes to the window, with a largest output of 262,144 bytes; main CPU was 219 ms. These are local fixture observations, not provider evidence or universal timing guarantees.

**Approved by Val on 2026-10-22:** “Approve 500 ms median.” The test now enforces median first open ≤500 ms across five fresh Electron launches of this fixture. Each launch uses a fresh home/process and verifies that the long thread was not selected at launch and all 1,400 items rendered. Warm opens are recorded separately and never counted in the gate. There are no retry-to-pass budget samples. Every sample, the median, environment and viewport are retained; CI stability still needs the actual macOS runner result.

The historical parser-only cost is a different metric. `scripts/benchmark-transcript.mjs` was also rerun with main as its comparison reference, recorded in `parser-measure.json`: main Markdown cold SSR samples 266.8/268.0/172.8 ms; candidate 268.6/195.2/186.1 ms for 200 mixed Markdown messages (306,290 bytes). This script warms module code before cold text-cache measurements, excludes browser layout/IPC, and shares candidate CodeBlock between both variants. Its `head` field is the base SHA; the candidate Markdown source hash identifies the uncommitted variant. Do not present these results as the original 239 KB parser fixture or as an app-open improvement.

## Candidate performance

On `3f0f2bc789c1e1c6fb9658a2f2dda23c8515e455`, the enforced five-launch test passed with samples 195.8, 180.3, 193.5, 198.2 and 194.5 ms; median **194.5 ms ≤500 ms**. See `candidate-measure.json` and `candidate-measure.log`. This run overlapped the root worktree-maintenance unit tests on a shared developer machine. It establishes the local gate result, not a controlled speedup or CI stability claim.

## Reference captures and differences

`pnpm --filter @modex/desktop ui:capture` passed all 16 cases, including the new Markdown capture in Graphite, Jev and OpenCoven at the existing **1786×1049 CSS-pixel** reference viewport. The actual PNG pixel dimensions and SHA-256s are recorded in `screenshots/manifest.json`. The fixture includes a heading, formatted text, links, a six-column table, quote, nested/task lists, and overflowing language-labelled code with Copy.

Visual inspection of the initial captures found:

- Jev has navy surfaces and pink links; OpenCoven has charcoal surfaces and purple links. Their Markdown geometry is the same.
- Graphite has its existing wider, denser sidebar and a shifted transcript column; links remain purple. All Markdown content and controls are readable. The long code line clips inside its horizontally scrollable box as intended; it does not widen the transcript.
- At this width, Graphite displays its existing repository overview above the upper-right user bubble, partly covering that bubble. This is `RepositoryOverview` / the `thread-main` container rule, not a popover. It does not cover the Markdown fixture. This pre-existing shell difference is retained and explicitly reported; no universal visual-parity claim is made.
- The table fits at reference width; the new keyboard test separately verifies table/code overflow at 900×600. Captures do not replace keyboard or human VoiceOver evidence.

## Human gate

Markdown rows C1–C5 extend the existing `../2026-10-20-keyboard-voiceover/checklist.md`; no second checklist exists. The seed adds a saved **Markdown review** thread using `markdown-fixture.json`. Human result cells remain empty. On 2026-10-22 Val answered **“Leave open for my review”**. This is not a deferral or a pass. #277 remains open until Val records a result or explicitly defers it. The seed was executed successfully into the worktree-local `apps/desktop/.probes/cf4-voiceover/`; no human review was performed by this session.

## Remaining verification

Final reference captures passed 16/16 and were visually inspected in all three themes. `pnpm build` and `pnpm typecheck` passed. The targeted parser unit run initially failed three exact-markup expectations because the new attributes were not allowed; those expectations now preserve their code-content checks while permitting accessibility attributes, and all 16 parser tests pass. Full workspace unit tests passed on the first pass: worktree 117/117, core 16/16, desktop 1,805 passed / 16 skipped plus 21/21 script tests, site 10/10, store-desktop 16/16 (1,985 passed total, 16 skipped, zero failures). See `full-test.log`. The first full E2E command finished with desktop 390 passed, 6 skipped and 2 failures in `usage.spec.ts`: Chromium crashed while creating the first page, and the next launch reported the shared cache executable for Chromium 1243 missing. Site E2E was not reached because the command chain stopped. See `full-e2e.log`; first-pass traces are preserved in `apps/desktop/.probes/cf4-full-e2e-first-pass/`. After installing Chromium 1243 into the worktree-local `apps/desktop/.probes/cf4-browsers` cache, the focused usage rerun passed 2/2 and site E2E passed 7/7 with `MODEX_SITE_TEST_PORT=5297`. Both commands used `PLAYWRIGHT_BROWSERS_PATH` pointing to that cache. See `usage-recovery.log` and `site-e2e.log`. No source changes were needed for recovery. This is complete local coverage with a documented infrastructure recovery, not a fully green first pass. All three new Markdown keyboard cases and the reference captures passed in the full run. Its five-launch budget samples were 152.6, 149.0, 165.9, 155.3 and 182.4 ms, median 155.3 ms. Production source remained unchanged from `93cfde3`; test and evidence refinements were committed while the full command chain was running. Hosted CI must provide a check tied to a single final commit. Delivery receipts remain pending. The approved budget is implemented; CI stability evidence and human VoiceOver acceptance remain open.

Committed logs preserve command output with trailing spaces removed for patch hygiene; raw copies remain in `apps/desktop/.probes/cf4-raw-logs/`.

## Delivery and the human review candidate, 2026-10-28

Added by the close-out session on 2026-10-28. Everything above is unchanged.

### How the candidate landed

- PR #371 (head `f3f158233b7e900c494ea0babb2528d4c468236f`) was never merged. Its reviewed changes reached protected `main` through #404, merge commit `e3527f457842c6eff9c793f8efe7883013954d93` on 2026-10-24, with [the integration receipt](../2026-10-24-integrated-review.md). #371 was then closed as superseded, so the rebase it once needed never happened and nothing from it was rebuilt.
- The `cf4-closeout` branch and worktree still hold #371's seven commits, which are not ancestors of `main`; they were left untouched.
- `main` at `b64361750983068160fe95293192ccea03000f88` (#422) carries those changes, as does every later `main` build and the `v0.4.0-rc.2` tag.

### Candidate for Val's C1–C5 run

Nothing below is a result. Every row stays open until Val reports it; a row Val cannot run stays open with its reason, or closes on Val's written deferral.

| Item | Value |
| --- | --- |
| Modex build | `main` at `b64361750983068160fe95293192ccea03000f88` (#422), desktop 0.4.0, `pnpm build` in `.worktrees/cf4-voiceover` on 2026-10-28, run from source with `npx electron .` as the checklist prescribes (not a release artifact) |
| Launch | From `.worktrees/cf4-voiceover/apps/desktop`: `MODEX_HOME=$PWD/.probes/cf4-voiceover/home npx electron .` |
| Seeded home | `.worktrees/cf4-voiceover/apps/desktop/.probes/cf4-voiceover/home`, written by `docs/reviews/2026-10-20-keyboard-voiceover/seed.mjs` on 2026-10-28. The sidebar thread **Markdown review** holds `markdown-fixture.json` (SHA-256 `cbb42e222e3dca2fbe5c8ec3fe046caf6ede48634b33bd45e57324a110b674e8`), the fixture the automated keyboard tests and the reference captures use. `~/.modex` is never touched |
| Window and themes | 900×600 with Review open, so the table and the `ts` code block overflow. Repeat in Graphite, Jev and OpenCoven. macOS Reduce Motion on for C3 |
| Machine | Mac17,6, Apple M5 Max (18 cores), macOS 27.0.1 (26A434), Node v24.22.0, pnpm 10.34.5 |
| VoiceOver voice, macOS version at run time | Val records |

Automated checks on this exact head, run focused on 2026-10-28 before the candidate was handed over (`human-candidate-2026-10-28-e2e.log`):

- `e2e/conversation-rendering.spec.ts` 6/6, `e2e/markdown-keyboard.spec.ts` 3/3 (Graphite, Jev, OpenCoven), `e2e/transcript-measure.spec.ts` 2/2: 11 passed, 0 failed, 43.9 s.
- Five-launch cold-open samples 176.2, 182.3, 144.4, 158.1 and 170.0 ms, median **170 ms ≤ 500 ms**, no retries (`human-candidate-2026-10-28-measure.json`).
- Launch smoke with exactly the command above, no `MODEX_E2E` flag: the seeded thread opened; the regions named **Markdown table** and **ts code** were present and both overflowed at 900×600; the links were Review link, Evidence link and End link; **Copy ts code** was present. Screenshot `screenshots/human-candidate-2026-10-28-900x600.png` (900×600 px, SHA-256 `353f623f052fb31634bec21171b325d33bf912efe9eb0955c233be1f8c15f4ff`). The probe lives in the git-ignored `apps/desktop/.probes/cf4-voiceover-smoke.mjs`.

These are keyboard and launch checks by a script. They are not a VoiceOver result and fill no human cell.

| Row | Result | Reported by Val |
| --- | --- | --- |
| C1 | open | |
| C2 | open | |
| C3 | open | |
| C4 | open | |
| C5 | open | |

Val posts the filled rows on #277 (or #281, the shared gate). They are copied here exactly as reported, in a docs-only signed PR, and never ticked on Val's behalf. A failing row gets a red E2E test and a fix in a new worktree. #277 closes only when every row has Val's result or Val's written deferral.

### Hosted CI on the candidate record, PR #427

Added after #427 merged as `8ab2072` on 2026-10-28. The earlier sections are unchanged. #427 changed only
documentation, so these runs exercised `main` at `b643617` plus this receipt.

- **Attempt 1, [run 40683102316](https://github.com/TypeSafeAI/modex/actions/runs/40683102316/job/122798535618), head `3f80fdf`: `unit + e2e (macOS)` failed.** Desktop E2E 472 passed, 4 skipped, 1 failed in 30.7 min. The failure was `e2e/code-review-agent.spec.ts:195` "Stop ends a running review, and a crash mid-run reads as unknown after a relaunch with nothing replayed": `expect(runs()).toHaveLength(2)` at line 217 received 1 spawn after the second Start review click. That spec arrived with #422 and is outside CF-4; the same job had passed on `main` at `b643617` ([run 40675863660](https://github.com/TypeSafeAI/modex/actions/runs/40675863660/job/122773990064)). In this same attempt the CF-4 gates passed: `markdown-keyboard` and `conversation-rendering` 9/9, five-launch samples 295.5, 300.7, 305.4, 360.8 and 274.2 ms, median 300.7 ms ≤ 500 ms, on Apple M1 (Virtual), 3 cores, Node v24.22.1. The iPhone companion job passed; Upload TypeScript coverage was skipped.
- **Attempt 2, [same run](https://github.com/TypeSafeAI/modex/actions/runs/40683102316/job/122825356588), same head, no change: passed.** Desktop E2E 473 passed, 4 skipped, 0 failed in 33.6 min, including the `code-review-agent` case. Five-launch samples 344.4, 264.0, 322.9, 305.3 and 509.4 ms, median 322.9 ms ≤ 500 ms. One sample on its own exceeded 500 ms; the approved gate is the median, and the sample is kept here as measured.
- The queue run for `8ab2072` merged the PR after Val's go-ahead on 2026-10-28.

The attempt 1 failure is a first-pass result and stays recorded; it was not a Markdown or docs defect. It is not tracked as a CF-4 item.

### Val's decision on C1–C5, 2026-10-30

Added on 2026-10-30. The earlier sections, including the open C1–C5 table above, are unchanged.

On 2026-10-30 Val chose **“Defer C1–C5 for now”** in the close-out session. The option they selected read: *Recorded word for word as your written deferral ("Val deferred C1–C5 on 2026-10-30") in a docs-only signed PR. #277 closes after it lands, and the rows stay unpassed.*

| Row | Result | Reported by Val |
| --- | --- | --- |
| C1 | deferred, not run | Val deferred C1–C5 on 2026-10-30 |
| C2 | deferred, not run | Val deferred C1–C5 on 2026-10-30 |
| C3 | deferred, not run | Val deferred C1–C5 on 2026-10-30 |
| C4 | deferred, not run | Val deferred C1–C5 on 2026-10-30 |
| C5 | deferred, not run | Val deferred C1–C5 on 2026-10-30 |

No row passed and none failed: no human VoiceOver run of C1–C5 happened. The deferral satisfies #277's closing condition but is not acceptance. The rows remain in the shared checklist (`../2026-10-20-keyboard-voiceover/checklist.md`) and can still be run on a later build. The seeded candidate in `.worktrees/cf4-voiceover` stays available. Its other rows (A1–A8, B1–B7) and #281 are not affected by this decision.

### Full suite on main after the deferral, 2026-10-30

Added on 2026-10-30. Earlier sections are unchanged. This is a first pass of the goal's `pnpm build && pnpm test && pnpm test:e2e` on protected `main` at `907ba08aa3b449e706ce49b4aa2706a861c58cc5` (#444), which contains #404's CF-4 changes. It ran in a fresh `.worktrees/cf4-full-suite` after `pnpm install --frozen-lockfile`, on Apple M5 Max (18 cores), macOS 27.0.1, Node v24.22.0, pnpm 10.34.5. Nothing was retried or rerun.

- `pnpm build`: exit 0 (`full-suite-2026-10-30-build.log`).
- `pnpm test`: exit 0. 2,244 passed, 26 skipped, 0 failed, 0 cancelled: worktree 117/117, core 16/16, desktop 2,064 passed / 20 skipped, desktop scripts 21 passed / 6 skipped, site 10/10, store-desktop 16/16 (`full-suite-2026-10-30-test.log`).
- `pnpm test:e2e`: exit 0. Desktop 475 passed, 7 skipped, 0 failed in 26.6 min, including the `markdown-keyboard` and `conversation-rendering` cases; site 7 passed (`full-suite-2026-10-30-e2e.log`).
- Five-launch first-open budget: samples 239.0, 250.5, 261.3, 233.1 and 227.2 ms, median 239.0 ms ≤ 500 ms (approved by Val, 2026-10-22).

This local result does not address the hosted budget variance recorded in `docs/status.md`. It is not human acceptance: C1–C5 remain deferred and unrun.
