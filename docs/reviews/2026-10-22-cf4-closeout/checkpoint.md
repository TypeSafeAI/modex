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

Final reference captures passed 16/16 and were visually inspected in all three themes. `pnpm build` and `pnpm typecheck` passed. The targeted parser unit run initially failed three exact-markup expectations because the new attributes were not allowed; those expectations now preserve their code-content checks while permitting accessibility attributes, and all 16 parser tests pass. Full workspace unit tests passed on the first pass: worktree 117/117, core 16/16, desktop 1,805 passed / 16 skipped plus 21/21 script tests, site 10/10, store-desktop 16/16 (1,985 passed total, 16 skipped, zero failures). See `full-test.log`. The full E2E command is running; delivery receipts remain pending. The approved budget is implemented; CI stability evidence and human VoiceOver acceptance remain open.

Committed logs preserve command output with trailing spaces removed for patch hygiene; raw copies remain in `apps/desktop/.probes/cf4-raw-logs/`.
