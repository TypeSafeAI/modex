# CR-3 acceptance resumed on `main`, 2026-10-30

Evidence for [#322](https://github.com/TypeSafeAI/modex/issues/322) after the acceptance follow-up (#438,
`afec85b`) landed. It re-runs the automated half of the acceptance on current `main`, re-runs the read-only
authenticated navigation probe there, and hands Val the two gates that remain human: the R1–R4 reference
comparison and the keyboard/VoiceOver pass. It does not close the issue.

## Candidate

- `main` at `f51ef7e8caa17e79c9029be0d696f5bb40b3dcf2` (#453). The worktree is `cr3-resume`; it changes no
  product code. Besides this record, the checklist and `docs/status.md`, it changes one spec,
  `e2e/code-review-journey.spec.ts`, so that its R1 and R4 captures hold populated content (below).
- Evidence outside the repository: `~/Documents/Codex/artifacts/modex-cr3-acceptance/2026-10-30/` (logs, the
  probe and its result, journey captures and the reference-less `compare.html`). `environment.txt` has the
  versions: macOS 27.0, Node 24, pnpm as pinned, gh 2.102.0.

## What is already on `main`

| Step | Landed | Where |
| --- | --- | --- |
| 1. #349's re-review items: `mergePages` requires every page to report the same total; a `SIGN_IN_CHANGED` read is retried once by the renderer `Reader`, within the same continuation so a newer read or cancellation wins | #438 `afec85b` (2026-10-28) | `src/shared/code-review.ts`, `src/renderer/code-review/reader.ts`; tests in `code-review-contract.test.ts`, `code-review-workspace.test.ts`, `e2e/code-review-regressions.spec.ts` |
| 2. Independent scrolling and focus with the overview (#393) and the remote diff (#404) in the panes, at 1440×900 and 900×600 | #438 | `e2e/code-review-scroll.spec.ts` |
| 4. The human keyboard/VoiceOver checklist, parts A–D | #438 | [`2026-10-22-cr8-voiceover/checklist.md`](2026-10-22-cr8-voiceover/checklist.md) |

CR-4 (#393, 2026-10-24) and CR-5 (#404, 2026-10-24) have both landed, so Step 2's precondition holds.

## Re-run on `main` at `f51ef7e`

Run from the worktree on this Mac, each exiting 0:

| What | Command | Result |
| --- | --- | --- |
| Build | `pnpm install --frozen-lockfile && pnpm build` | passed |
| Step 1 unit files | `node --test --test-force-exit dist/test/code-review-{contract,workspace,read-service}.test.js` | 75 passed, 0 failed |
| Focused Code Review E2E (the resume prompt's two specs plus the scroll and regression specs) | `pnpm exec playwright test e2e/code-review-navigation.spec.ts e2e/code-review-ipc.spec.ts e2e/code-review-scroll.spec.ts e2e/code-review-regressions.spec.ts` | 24 passed, 0 failed, 1.9 min |
| Typecheck | `pnpm typecheck` | passed |
| Unit | `pnpm test` | worktree scripts 120/120; core 16/16; desktop 2,089 passed, 20 skipped, 0 failed; desktop native suites 21 passed, 6 skipped; site 10/10; store-desktop 16/16 |
| E2E | `pnpm test:e2e` | desktop 476 passed, 7 skipped (opt-in live cases), 0 failed, 40.3 min on a loaded machine; site 7/7 |

The focused run includes the #349 regressions (the one-retry read through the production read service and a
rewritten `hosts.yml`; the `gh auth switch` refusal that is not retried) and both scroll cases.

## Authenticated read-only navigation probe, re-run on `main`

The same probe Val authorized for `main` on 2026-10-22 (`A-main` in the
[acceptance matrix](2026-10-22-cr8-acceptance-matrix.md)), `live-navigation.mjs`, was run again against this
build with the Mac's own `gh` login (account BunsDev, id 68980965, gh 2.102.0), a disposable Modex home and
no `MODEX_E2E` or demo flag. It exited 0 with all six checks passed:

1. authenticated inbox and `repo:TypeSafeAI/modex` search, every row in that repository;
2. public PRs #349 and #348 resolved from their links with overview-derived totals and no overview error;
3. Back, Forward, Changes and the split through their real controls;
4. a pin retained and resolved after renderer reload;
5. an explicit resolve error for a nonexistent public PR;
6. a separate disposable home with an empty `GH_CONFIG_DIR` and no token variables shows signed-out and a
   disabled search field.

Only GET reads of public PRs were made. No GitHub write, coding turn, account switch or private content
export took place; `gh auth status` showed the same active account afterwards. The sign-in retry path was
not exercised live (it would require switching the Mac's gh account), so it stays synthetic-`gh` evidence.

## Step 3: R1–R4 comparison

Still not run. The originals were confirmed gone on 2026-10-22 and were not found on this Mac on 2026-10-28,
and Val decided that day to leave the comparison open rather than re-capture or substitute. Nothing has
changed since: no reference directory has been named. No synthetic capture was substituted for a reference.

**The captures were not populated.** Reviewing the journey spec's R1 and R4 captures from the full E2E run on
this `main` (kept under `journey-captures/`), and the 2026-10-28 ones, showed the same two gaps: R4's Changes
pane read "0 of 4 files loaded" with an empty file tree, because the synthetic world serves no files for
field-guide #91, and R1's Checks section read "not found", because the world serves no check runs for
lending #73's head. The references show grouped diffs with a file tree (R4) and a checks sidebar (R1), so a
comparison from those captures would have measured empty panes. The journey spec's world now carries four
files for #91 (+11 −4, as its PR says) and four check runs and one commit status for #73's head; its
geometry assertions are unchanged and it passes. The populated R1–R4 captures at the references' CSS sizes,
plus 1440×900 and 900×600, are kept under `journey-captures-populated/` with their manifest and a
reference-less `compare.html`. The Stack section still reads "not found" (the world declares no branch
relationships; `stack` was unavailable as designed in `A-main` too). When Val names a directory holding
`R1.png`–`R4.png` (originals, or re-captures with their own calibration row), the comparison is:

```sh
cd apps/desktop && pnpm exec playwright test e2e/code-review-journey.spec.ts
pnpm run ui:compare -- --captures test-results/ui-code-review <directory with R1.png … R4.png>
```

Each reviewed deviation then gets a D-row in the design page's Workspace section.

## Step 4: the human keyboard/VoiceOver checklist

[`2026-10-22-cr8-voiceover/checklist.md`](2026-10-22-cr8-voiceover/checklist.md) now names the landed build
(`afec85b` or later; this run used `f51ef7e`). To run it, from `apps/desktop` in a worktree at the SHA under
test after `pnpm build`:

```sh
node ../../docs/reviews/2026-10-22-cr8-voiceover/seed.mjs /tmp/modex-cr8-voiceover
```

then the printed `env … npx electron .` line, `localStorage.setItem("modex.codeReview", "on")` in DevTools
and a reload. Parts A and B cover CR-3's inbox, tabs, header and dividers; C and D the populated overview,
diff and tree; A1–A6, C1–C3 and D1–D4 are repeated at about 900×600. The result row at the end waits for Val.

## Acceptance criteria, by evidence

| AC | Fixtures / synthetic `gh` (this run) | Authenticated (this run) | Human |
| --- | --- | --- | --- |
| AC1 R1/R4 arrangements through real controls | `code-review-navigation.spec.ts` (R1 test, R1/R4 captures) | probe check 3 (Changes and split) | geometry comparison with the originals: open, deferred by Val |
| AC2 stale replies, back/forward | navigation (identical numbers, slow search, account switch, back/forward) and regressions (identity ×3, revision) | probe check 3 (back/forward) | — |
| AC3 independent scrolling, restored geometry | `code-review-scroll.spec.ts` ×2; navigation keyboard test (persisted panes) | — | — |
| AC4 keyboard at 900×600 and 1440×900 | navigation keyboard test; scroll spec (focus kept) | — | keyboard/VoiceOver checklist: open |
| AC5 local Changes, no remote Discard | regressions "local Changes stay local"; navigation pin/copy test | — | — |
| AC6 fixtures and authenticated smoke reported separately | this table's first column | probe 6/6 on `f51ef7e` | — |

## Still open on #322

- The R1–R4 comparison against originals or re-captures Val names (Step 3).
- The human keyboard/VoiceOver result (Step 4).
- A live run of the sign-in retry is not claimed.
