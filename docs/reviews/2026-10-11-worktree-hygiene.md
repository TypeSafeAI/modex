# Worktree pruning verification

The [procedure](../worktree-hygiene.md) replaces removal-before-proof with explicit
release, fresh eligibility checks, verified recovery, and guarded local deletion.
The existing `new` and `remove` entry points remain available to Modex threads.

## Verified

- `npm run test:worktrees`: **75 passed**. These use real temporary Git repositories,
  including standalone bundle restoration and exact restored tip checks.
- `npm run build`, the repository unit suite, and `npm run typecheck`: passed.
  The application suites reported **470 passed, 1 skipped**. The final maintenance suite
  above includes the additional findings fixed after the first full unit run.
- `npm run test:e2e`: **163 desktop passed, 3 opt-in integration cases skipped;
  7 site passed**. The retry completed with exit 0 after host resources recovered.
- Desktop retirement regressions: **7 passed**, including script-retained branches and
  refusal to bypass a missing project script.
- Independent specification and code-quality reviews cleared the final fixes. Reviewers
  independently reran paused-operation, symbolic-ref, submodule, alternate-index, and
  archive-containment regressions.
- The required CI workflow invokes `npm test`, which now includes maintenance tests.
- The macOS user job was installed on 2026-10-11 with a 24-hour interval and `RunAtLoad`.
  `schedule status` confirmed the job loaded and the installed runtime checksums valid.
- The first scheduled run completed at 08:17 UTC with **39 branches, 31 worktrees,
  zero eligible releases, zero removals, and no errors**. All existing work was preserved.

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

## Hosted gate and evidence

The required macOS CI sets `MODEX_TEST_OPEN_KNOWLEDGE=1`, enabling three real upstream
integration cases skipped by the standard local command. Their result on this branch
remains a hosted acceptance gate before protected landing.

The first desktop E2E attempt passed 28 cases before an intentional stop for host disk
pressure: 1 interrupted, 137 not run, exit 130. The complete standard retry above passed.
Both logs and the interrupted test results were retained.
The earlier read-only audit found 38 local branches and 30 registered worktrees; another
session created work before the scheduled run. Scheduled-run results remain under
`modex-maintenance/schedule/reports/`.
