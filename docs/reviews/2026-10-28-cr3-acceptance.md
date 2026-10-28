# CR-3 acceptance follow-up, 2026-10-28

Evidence for [#322](https://github.com/TypeSafeAI/modex/issues/322) after the host (#367, `af49881`),
the overview (#393) and the remote diff (#404) landed on `main`. It closes #349's re-review items and
proves independent scrolling with populated panes. It does not close the issue: the original-reference
comparison and the human keyboard/VoiceOver pass remain Val's.

## Candidate

- Base: `main` at `7a01df29660501e8bd6cf94ff697e969c7cac725`.
- Code and tests: `271d9f6876a379defeec176f75360e2d8454e265` (signed), branch `cr3-acceptance`.
- Evidence outside the repository: `~/Documents/Codex/artifacts/modex-cr3-acceptance/2026-10-28/`
  (full logs, the journey captures and their manifest, `compare.html`).

## Step 1: #349's re-review items (AC2, AC3)

Both items were written as red tests first; each failed for the reason it names before its fix.

| Item | Red test | Before | Fix |
| --- | --- | --- | --- |
| `mergePages` must not read a list with a skipped row as complete when a PR closes between pages | `code-review-contract.test.ts`: 31 PRs, first page #100–#129 with total 31, second page empty with total 30 | `complete: true` ("a page that reports a different total than the first proves the list moved": actual true, expected false) | `mergePages` (`src/shared/code-review.ts`) now requires every page that reports a total to report the same one. The same test covers PRs opening between pages (31 then 33) and a stale page kept from a failed retry. |
| A "sign-in changed" refusal is retried once at most, then shown | `code-review-workspace.test.ts`: the `Reader` with a fake main | no retry at all ("one retry, with a new request id…": actual `[inbox t-1]`, expected `[inbox t-1, inbox t-2]`) | The detail is the contract's `SIGN_IN_CHANGED`, used by main's read service and matched by the renderer's `Reader`, which asks once more in the same slot. Covered: refused then answered (applied, two sends); refused twice (the second refusal is applied, no third send); superseded during the retry (dropped unseen); any other failure shown at once. |

Through the production read path (`e2e/code-review-regressions.spec.ts`, "a read refused because gh's
sign-in moved and came back"): with the PR read held, `hosts.yml` is rewritten away and back, so main
refuses the answer; the renderer reads again once (two `pulls/73` calls, no error shown, still
loading); the retry is refused the same way and the notice says "sign-in changed"; after `settle` there
are still two calls; the notice's Retry reads it again and the overview loads. The `gh auth switch`
regression beside it (a real switch, answered `signed-out`) is unchanged: that refusal is not retried.

Unit: the contract, workspace and read-service test files pass 72/72 after the fix.

## Step 2: independent scrolling and focus with populated panes (AC3, AC4)

`e2e/code-review-scroll.spec.ts`, through the production read service with a synthetic `gh`: a 41-row
authored inbox (one search page of 30 and a next cursor), a 40-paragraph description, 60 files with
20-line patches. At 1440×900 and at 900×600:

- The inbox list, the overview (its main column at 1440×900; its body at 900×600, where the pane
  stacks the sidebar under the description), the sidebar where it is its own scroller, the diff and the
  file tree each scroll on a wheel over them and on PageDown with focus in them.
- Scrolling one moves none of the others, nor the window or the sheet.
- The focused control keeps focus throughout: an inbox row, a file heading in the diff, the tree's
  filter field.
- At 1440×900 the split is kept; choosing the last tree file moves the diff to its section and focuses
  it, and the tree keeps its own position. At 900×600 the split folds to one pane and the tree sits
  behind the Changes header's toggle; it is tested on its own there.
- Leaving for the PR tab and returning restores every region's position; the list is untouched.

Both sizes pass (the viewport actually used is recorded in each test's annotation). Chromium animates
keyboard scrolls, so the spec waits for a region to stop moving before reading the others.

## Step 3: R1–R4 comparison

Not run. The design page records Val's confirmation on 2026-10-22 that the original captures are gone
from `~/Desktop`. On 2026-10-28 this Mac was searched again by name, by pixel size (1766×1057,
3536×2102, 3528×2094, 2048×1217), in the Trash and iCloud Drive, and for local Time Machine
snapshots: every hit at the references' CSS sizes is a Playwright capture, and there are no originals.
Asked where they are now, **Val decided on 2026-10-28 to leave Step 3 open for now** rather than
re-capture or substitute. No synthetic capture was substituted. The journey spec's R1 and R4 captures at the references' CSS sizes, plus 1440×900 and
900×600, were taken on this candidate and kept with the evidence; `pnpm run ui:compare --captures`
built `compare.html` from them with every row marked "no reference". Once Val names where the
originals (or re-captures with their own calibration row) live, the comparison is one command:

```sh
cd apps/desktop && pnpm exec playwright test e2e/code-review-journey.spec.ts
pnpm run ui:compare -- --captures test-results/ui-code-review <directory with R1.png … R4.png>
```

Each reviewed deviation then gets a D-row in the design page's Workspace section.

## Step 4: the human keyboard/VoiceOver checklist

[`2026-10-22-cr8-voiceover/checklist.md`](2026-10-22-cr8-voiceover/checklist.md) is updated for the
landed overview and diff: parts C and D, the folded layout at 900×600, and the current build SHA. Its
`seed.mjs` was run on this candidate's build and printed the launch line (synthetic `gh`, throwaway
home, no token). The result row stays empty until Val records it.

## Gates on `271d9f6`

Run from the worktree root on this Mac (macOS 27.0, Node 24, pnpm as pinned; `environment.txt` in the
evidence directory has the exact versions), one after another, each exiting 0:

| Command | Result |
| --- | --- |
| `pnpm build` | passed |
| `pnpm typecheck` | passed |
| `pnpm test` | worktree scripts 117/117; core 16/16; desktop 2,018 passed, 17 skipped, 0 failed; desktop native suites 21 passed, 6 skipped; site 10/10; store-desktop 16/16 |
| `pnpm test:e2e` | desktop 473 passed, 7 skipped (opt-in live cases), 0 failed, 21.4 min; site 7/7 |

The e2e run includes the two new scroll cases, the new retry regression and every existing Code
Review spec. Its journey captures (R1 and R4 at the references' widths, fitted to this display's
915 px of height at DPR 2, plus 1440×900 and 900×600) are kept under `journey-captures/` with their
manifest and the reference-less `compare.html`.

## Still open on #322

- The R1–R4 comparison against Val's originals or re-captures (Step 3), deferred by Val's decision on
  2026-10-28 until references exist.
- The human keyboard/VoiceOver result (Step 4).
- An authenticated run of the sign-in retry is not claimed; the refusal path was exercised only with
  the synthetic `gh` and a rewritten `hosts.yml`.
