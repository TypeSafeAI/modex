# Space and Knowledge recovery audit

The seven unfinished Space/Knowledge snapshots contain no product or regression-test
change that needs replaying onto main `6c00c52d372adc0f94c6dd667bcf97b671363248`.
This audit recovers their missing historical verification outcomes. It does not
replace the [integrated review](2026-10-08-space-knowledge.md).

## Source comparison

The comparison covered all tracked changes and non-ignored untracked files in
`knowledge-reuse`, `space-e2e`, `space-integrated`, `space-knowledge`, `space-pages`,
and `space-recovery`, plus the 36 files changed by `space-pr` commit `b95394d`.
Identical content was grouped by SHA-256 before reviewing distinct variants.

Thirty of the 36 `space-pr` files are byte-identical to integration commit
`f5c347b` ([PR #144](https://github.com/TypeSafeAI/modex/pull/144)). The other six
contain canonical fixture paths, selection and autofocus race fixes, additional
styles, and updated status/review evidence. Closed PR #145 therefore does not
represent a lost feature. Later #150 (`39474d1`) and #154 (`5071ce8`) add page
history, scoped agent maintenance, conflict recovery, and resizable panels.

| Snapshot | Disposition |
| --- | --- |
| `space-pages` | Native pages, import/export, and navigation are retained; main adds native save IPC and Markdown boundary fixes. |
| `space-knowledge` | Companion service is retained with stronger folder/content-root and lifecycle checks. |
| `space-integrated` | Guest embedding, native export, and IPC are retained. Its diagnostic console output is superseded by persistence assertions. |
| `space-e2e` | Managed lifecycle, quit veto, copy/export, and Markdown coverage are retained. |
| `knowledge-reuse` | Verified server adoption and external ownership are retained; `knowledge.test.ts` is byte-identical to reviewed main. |
| `space-recovery` | Home geometry and dedented-checklist repairs are retained; `panel-layout.spec.ts` is byte-identical to reviewed main. |
| `space-pr` | Feature delivered in #144 with stronger focus handling; recover the distinct verification record below. |

The 85 upstream OpenKnowledge skill files in `space-integrated` are 17 identical
files copied into five host skill directories by a local `ok init` probe. Its
`.ok/config.yml` points at `apps/desktop/.probes/space/probe-notes`. These are
environment artifacts, not missing Modex application code. Dirty snapshots,
ignored probes, and their archives remain preserved; this audit does not certify
them for deletion.

## Corrected October 8 verification records

The records below were inspected on October 11. An unfinished review document is
not evidence that its process is still running.

| Snapshot | Actual historical result |
| --- | --- |
| `knowledge-reuse` | Full desktop E2E finished with **11 failures and 122 passes**. A separate unit rerun passed 342 tests; the earlier unit run had 12 desktop failures. The focused quit-veto regression passed. |
| `space-recovery` | Final build, typecheck, unit, and E2E commands all recorded exit 0. Unit: **343 passed**. E2E: **134 desktop and 7 site passed**. The earlier layout probe measured 658.328125 px overflow; a separate focused regression run passed 22 tests. |
| `space-pr` | Full desktop E2E finished with **144 passes and one shell-test timeout**. Separate retries passed the shell test, all 14 app-spec tests, and 7 site tests. Unit: **374 passed**. Retries do not erase the full-run failure. |

The integrated review's separate 145-pass result remains a distinct run. These
historical records do not establish current-main health or human keyboard-only
and VoiceOver acceptance. Electron download delays and short Node/TMPDIR paths
documented in the `space-pr` review are historical setup context, not product fixes.

## Evidence locations

On the recovery machine, paths below are relative to the primary checkout unless
an absolute path is shown:

- `.worktrees/knowledge-reuse/apps/desktop/.probes/knowledge-reuse/`:
  `e2e-full.log` lines 667–679, `unit-short-tmp.log`, `unit.log`, and `e2e-quit.log`.
- `/Users/buns/.coven/workspaces/familiars/cody/handoffs/2026-10-08-modex-space-recovery-review/`:
  `checks-final.json`, `e2e-final.log` lines 285 and 324, `unit-final.log`,
  `layout-before.log`, and `regressions.log`.
- `.worktrees/space-pr/apps/desktop/.probes/space-pr/`:
  `e2e-final.log` lines 313 and 327–329, `shell-retry.log`, `app-retry.log`,
  `site-e2e.log`, and `unit.log`.
- `/Users/buns/.codex/recovery/modex-20261011/`: `space-review.json` records every
  compared path and hash; `space-review.md` explains each variant. Separate staged
  and unstaged patches, untracked archives, and hash manifests preserve sources.

The old `verification.json` in the Space recovery handoff still says its review
was running. Successful test logs do not establish a final independent-review
verdict for that historical run.
