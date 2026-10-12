# Local updater and draft recovery acceptance

The updater integration passed local verification on October 12, 2026. This is evidence
for the application and recovery flows, not a signed installed upgrade or a published
release. The base is `fb415b704854e3eff044db086c3cc61eec802ff5`.

## Verification

| Check | Result |
| --- | --- |
| `npm run build` | Passed across the monorepo |
| `npm run typecheck --workspaces --if-present` | Passed |
| `npm test` | 1,341 passed, 15 skipped, zero failures |
| Desktop Playwright suite | All 270 cases passed in 8.9 minutes |
| Site Playwright suite | All seven cases passed in 7.1 seconds |

The tests used Node 24.18.1, CI mode, Open Knowledge acceptance enabled, and one Playwright
worker. Desktop Playwright ran from `apps/desktop`, matching CI; no installed application
was substituted. The full E2E run held all 626 source files unchanged. Later changes only
update this report and the status/behavior documentation.

The passing source archive is retained outside the worktree at
`~/.codex/recovery/modex-20261011`, SHA-256
`303a5d43b4008cf9136e6a94285ee8f7b69e3d3720c1955c99793664fd5b5078`.
The worktree's `.codex/` contains phase logs, source manifests, process identities, and
retained JSON receipts. Checks found all 1,473 observed owned process identities absent
after the run and all 110 explicitly logged fixture path strings absent. Older tests that
do not log fixture paths are outside that temporary-path claim. No process signals were
needed for the passing run.

## Behavior covered

- Raw thread and project drafts, configuration, and attachments survive full process
  relaunch. Clearing a draft stays cleared. Save failures veto ordinary close until retry
  succeeds. Streamer Mode preserves editing, clipboard contents, and submitted originals.
- Failed sends preserve an immutable original separately from newer typing and attachment
  choices. Explicit retry keeps the original identity; startup never sends it automatically.
  File capacity, late staging/pickers, thread switching, and reload are exercised.
- Sent or removed attachments disappear from editable recovery references. Retained staging
  bytes remain recovery evidence and do not reappear as editable chips after reload.
  Thumbnails, transcript metadata, file reveal, and refusal to execute files are covered.
- Thread/project removal and automatic retirement flush and hold live drafts, refuse affected
  unsent work, and preserve unrelated drafts. A retired task can coexist with a restored
  new-chat draft and its exact attachment bytes.
- The real update controller handles progress, cancellation, retry, verification failure,
  cleanup, Settings refusal, and restart preparation. Partial shutdown keeps work held;
  replacement documents receive read-only recovery. Recovery Quit uses fresh preparation
  and preserves the saved record.

Integration testing found and fixed an unset optional reasoning effort reaching strict
native persistence in both initial send and transfer snapshots, plus a startup race where
retired-thread cleanup ran before attachment restoration. Recovery-file validation and
one-shot attachment restoration remain strict.

Earlier failed runs and their traces are retained. Two browser failures came from the test
runner's working directory and passed after matching CI. A Streamer clipboard failure
occurred while another worktree ran Playwright and supplied the same pairing URL observed
in the failed paste. The unchanged real clipboard test passed in the final run; process
checks observed no competing runner during that run.

## Remaining release gates

Updater UI tests substitute download, staging, and publisher verification and trap native
updater calls. They do not prove signing, notarization, Squirrel replacement, or an installed
A-to-B upgrade. The hosted macOS upgrade, native-failure, and interruption scenarios must
pass through the [release workflow](../release-signing.md#native-updater-release-gate).
Its private same-source version-A fixture also does not prove historical schema migration.

Windows signing remains deferred by maintainer choice. Windows/Linux use manual updates;
public installers and the remaining native acceptance limits are tracked in
[native-platforms.md](../native-platforms.md). No tag, release publication, or installed
native update was performed for this local verification.
