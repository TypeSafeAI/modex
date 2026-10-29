# Markdown keyboard scroll sequencing

The Markdown keyboard test reversed direction as soon as `scrollLeft` first increased. That can overlap the end of Electron's native keyboard scroll animation. Hosted PR #433 run `40744863183`, job `123015837463`, failed in Graphite with ArrowLeft leaving `scrollLeft` at 40 instead of returning to 0: 472 desktop tests passed, four skipped, one failed; site tests did not run. The iPhone job passed. This record preserves that first failure.

The repair registers `scrollend` before ArrowRight, retains the assertion that scrolling actually moves right, then waits for completion and two animation frames before sending ArrowLeft. The original return-position, keyboard focus, clipboard, traversal and reduced-motion assertions remain. No application behavior changes, retry, larger assertion tolerance, fixed sleep or synthetic scroll assignment is added to the shipped E2E test. This qualifies sequential keyboard actions; it does not claim rapid reversals in Electron are fixed.

## Diagnostic evidence

All diagnostic scripts and raw output are outside tracked source under `apps/desktop/.probes/` and `/Users/buns/Documents/Codex/artifacts/modex-land-and-prune/`. Earlier application probes used the existing build at `b643617`; the repair worktree subsequently fast-forwarded to main `7a01df2`. Fresh-build validation is required before delivery.

| Experiment | Result | Scope |
| --- | --- | --- |
| Graphite passive event capture, original sequencing | 10 passed | Does not reproduce the hosted failure |
| Graphite with 45 ms additional delay before reversal | 2 failed, 8 passed | Reproduces stuck-at-40 symptom; focus retained and keys not prevented |
| Plain scrollable element replacing the application document | 18/30 stuck at 40 | Removes Markdown rendering, but retains the window environment |
| Separate blank Electron BrowserWindow without preload or application page scripts | 18/30 stuck at 40 | Isolates native behavior from Modex page handlers |
| Same blank window with a 20 ms ArrowLeft key hold | 24/30 stuck at 40 | Key hold is not a remedy |
| Same blank window waiting for scrollend plus two frames | 30/30 returned to 0 | Supports sequencing the completed native actions |
| Full diagnostic Markdown journey with settlement, all three themes, five repetitions each | 15 passed | Preserves the original assertions; existing-build evidence |

In one recorded failure, ArrowLeft reached the focused code element at 5452.3 ms, keyup arrived at 5452.8 ms, and the preceding scroll's `scrollend` arrived at 5452.9 ms. The same connected element remained at 40. The controlled timing and blank-window reproduction narrow the problem to native scroll sequencing; they do not identify a particular upstream browser implementation defect.

## Delivery gates

Fresh `pnpm build && pnpm test` passed with 2,196 passed, 23 skipped, zero failures and exit 0. Independent read-only review found no blockers; it noted that a missing scrollend is bounded by the existing 90-second test timeout and the per-test Electron cleanup. The first actual-test run passed 15/15 on the existing build. The further focused run against the fresh build passed 15/15 in 1.6 minutes, five repetitions per theme. Protected hosted validation remains required. Human accessibility acceptance and broader #277/#327 gates remain open.

## Integration with main at 42e9856

The protected queue removed #435 after main advanced because `docs/status.md` conflicted. The integration preserves the Markdown entry and the newer packaged-harness and landed Notes entries. All tracked source, dependency/build configuration and tests are identical between the resolved #435 and #433 integration trees; only their CF-4 receipt and status documentation differ.

Fresh root `pnpm build && pnpm test` passed on the integrated Markdown worktree: 2,237 passed, 26 skipped, no failures. Full `pnpm test:e2e` passed with 471 desktop cases, seven skips and seven site cases (18.4 minutes desktop, 9.0 seconds site). All three Markdown themes and the Store browser-tools recovery/shutdown case passed. The five-launch transcript median was 206.3 ms on Apple M5 Max, 18 cores, Node v24.22.0, against the unchanged 500 ms limit. Logs and the exact integration-tree comparison are preserved outside the worktrees under `modex-land-and-prune`. These local results do not replace new hosted validation or protected merge-queue delivery.
