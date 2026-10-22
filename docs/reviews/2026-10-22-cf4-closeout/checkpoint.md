# CF-4 closeout evidence, 2026-10-22

Issue: #277. Shared human gate: #281. This is a new receipt; historical results remain unchanged.

## Candidate and scope

- Base: current `origin/main`, `0e674e75237f393b8a1ba712061f5b303a61d5b4`, fetched and confirmed through GitHub on October 22.
- Owned worktree/branch: `cf4-closeout`; `scripts/worktree.sh check` passed.
- Machine: Mac17,6, Apple M5 Max (18 cores), 128 GiB, macOS 26.7.1 (25G241), Darwin 25.6.0, Node 24.22.0, pnpm 10.34.5.
- Already landed: typed turns, safe CommonMark/GFM, full replies, continuity, minimum-size fixes, and keyboard answer/Stop/Jump fixes. These are not reimplemented.
- Only renderer changes: explicit named, focusable table and code scroll regions. Existing focus styling now applies to code. No parser or turn grouping change.

## Keyboard and reduced motion

`e2e/markdown-keyboard.spec.ts` uses the same Markdown fixture as the human kit and captures. At 900×600, in all three themes, it traverses links → table → table link → Copy → code → final link and back with Tab/Shift-Tab, checks focus rings, scrolls overflow with arrow keys, checks exact clipboard bytes and no tool/approval, and inspects computed animation/transition/scroll styles under reduced motion.

Two failures were reproduced before repair: a table with a link is skipped by Tab, and Chromium's implicit code-scroll focus has no visible ring. The fixes use `tabIndex=0`, `role=region`, and accessible names. Disabled task checkboxes remain noninteractive.

An intermediate test run was 9 passed / 2 failed: the new test started traversal before the scripted reply finished streaming. Its initially-idle assertion was too early. It now waits for the final link and idle before testing the settled order. The runtime fixes are independently reverted and rebuilt to confirm each red regression with this corrected fixture readiness.

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

**Proposal to Val (pending):** median first open ≤500 ms across five fresh Electron launches of this fixture. Validate on the actual macOS CI runner before claiming CI stability. No timing gate is enforced until Val agrees. Approval was requested in the session; absence of a reply is not approval.

The historical parser-only cost is a different metric. `scripts/benchmark-transcript.mjs` was also rerun with main as its comparison reference, recorded in `parser-measure.json`: main Markdown cold SSR samples 266.8/268.0/172.8 ms; candidate 268.6/195.2/186.1 ms for 200 mixed Markdown messages (306,290 bytes). This script warms module code before cold text-cache measurements, excludes browser layout/IPC, and shares candidate CodeBlock between both variants. Its `head` field is the base SHA; the candidate Markdown source hash identifies the uncommitted variant. Do not present these results as the original 239 KB parser fixture or as an app-open improvement.

## Human gate

Markdown rows C1–C5 extend the existing `../2026-10-20-keyboard-voiceover/checklist.md`; no second checklist exists. The seed adds a saved **Markdown review** thread using `markdown-fixture.json`. Human result cells remain empty. Val must record the VoiceOver result or explicitly defer it before #277 can close.

## Remaining verification

Reference captures, final full commands and delivery receipts are pending at this checkpoint. The performance-budget decision, CI stability evidence and human VoiceOver result remain open.
