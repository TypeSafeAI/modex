# Worktree pruning verification

The [procedure](../worktree-hygiene.md) replaces removal-before-proof with explicit
release, fresh eligibility checks, verified recovery, and guarded local deletion.
The existing `new` and `remove` entry points remain available to Modex threads.

## Current-main verification

The final local gate integrated signed Canvas squash `794010c` and verified frozen
candidate tree `1e9e050e25487dbea152f060e2916e4428660f14` on 2026-10-11.
Only the status page conflicted. All landed Canvas, native, Streamer, Browser, attachment,
and CI changes were retained. The production difference from main is limited to the
runner's worktree retirement guards; the renderer and desktop E2E files are unchanged.

- `npm ci`, `npm run build`, and `npm run typecheck`: passed.
- `npm test`: **779 passed, 1 skipped**: 75 maintenance tests and 704 application tests.
  The skip is the opt-in pinned OpenKnowledge unit integration case. It was not enabled
  by the standard unit command and is not claimed as passed.
- `MODEX_TEST_OPEN_KNOWLEDGE=1 npm run test:e2e`: **234 desktop passed, 7 site passed**,
  with no skips, failures, or retries. This includes the real Knowledge integration cases.
- The gate exited 0 with all 480 tracked-file hashes, the index hash, and candidate tree
  unchanged. Runtime cleanup confirmed the wrapper, phase groups, and recorded children
  had exited, with no process using the owned worktree as its working directory.

The shared Git directory retains `modex-maintenance/evidence/worktree-hygiene/`
`fullgate-20261011T180419Z/`: command/PID receipts, complete logs and hashes, frozen source
hashes, test completion records, and the explicit runtime-release receipt. Subsequent
status and verification-document edits do not change the tested runtime source.
Fresh exact-head hosted macOS and iPhone checks remain required before protected landing;
these local passes do not replace that gate. No local iOS runtime acceptance was repeated.

## Pruning and review evidence

The 75 maintenance tests use real temporary Git repositories, including standalone bundle
restoration and exact restored tips. The desktop unit suite includes seven retirement
regressions, including script-retained branches and missing-script refusal. The required
CI workflow runs maintenance tests through the normal `npm test` command.
Independent specification and code-quality reviews cleared the implementation findings;
reviewers reran paused-operation, symbolic-ref, submodule, alternate-index, and archive-
containment regressions. Independent integration review verified the preserved main paths.

The macOS user job was installed on 2026-10-11 with a 24-hour interval and `RunAtLoad`.
Its loaded state and pinned runtime checksums were verified. The first scheduled run at
08:17 UTC inspected **39 branches and 31 worktrees**, with **zero eligible releases,
zero removals, and no errors**. All existing work was preserved. Scheduled-run results
remain under `modex-maintenance/schedule/reports/`.

## Preservation cases reproduced before fixing

Temporary fixtures demonstrated actual loss from removing a clean unmerged checkout,
hidden index flags, a paused empty merge, symbolic refs redirecting deletion, ignored
submodule changes, an alternate index hiding staged data, and archives redirected into
the removal target. Each now has a passing regression. No existing worktree was used
for destructive verification.

Archive verification includes an empty bare restore with templates disabled, exact ref
comparison, `git fsck --full`, and checksums. Every removal rechecks the release, Git
state, PR evidence, process activity, and archive integrity. Local ref deletion uses
an expected SHA and `--no-deref`. Remote refs remain intact.

## Historical runs

Before the final-main integration, the application unit suites reported **470 passed,
1 skipped**. The original standard E2E retry passed **163 desktop and 7 site cases**, with
three opt-in Knowledge cases skipped. Both required macOS jobs on head `0b0ac133` later
passed; the archived hosted log records **75 maintenance, 166 desktop and 7 site passes**,
including real Knowledge. Those results apply to that earlier head only.

The first desktop E2E attempt passed 28 cases before an intentional stop for host disk
pressure: 1 interrupted, 137 not run, exit 130. Its log and interrupted test results were
retained separately from the passing retry and current-main gate.
The earlier read-only audit found 38 local branches and 30 registered worktrees; another
session created work before the first scheduled run. None of these historical inventories
or test passes releases another owner's work.
