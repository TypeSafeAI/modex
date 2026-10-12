# Local updater and draft recovery acceptance

The updater integration passed local verification on October 12, 2026. This is evidence
for the application and recovery flows, not a signed installed upgrade or a published
release. The base is `ef17fc8a41ed0751cee8a74db0b3030c9900d309`.

## Verification

| Check | Result |
| --- | --- |
| `npm run build` | Passed across the monorepo |
| `npm run typecheck --workspaces --if-present` | Passed |
| `npm test` | 1,352 passed, 15 skipped, zero failures |
| Desktop Playwright suite | All 270 cases passed in 9.4 minutes |
| Site Playwright suite | All seven cases passed in 6.9 seconds |

The tests used Node 24.18.1, CI mode, Open Knowledge acceptance enabled, and one Playwright
worker. Desktop Playwright ran from `apps/desktop`, matching CI; no installed application
was substituted. The full E2E run held all 634 source files unchanged. Later changes only
update this report and the status documentation.

The earlier passing source archive is retained outside the worktree at
`~/.codex/recovery/modex-20261011`, SHA-256
`9ab56d8d7ef44130878c3bb5b2d7e3132272fc7e35cc8337668cc757a30c5640`.
The worktree's `.codex/` contains phase logs, source manifests, process identities, and
retained JSON receipts. Checks found all 1,506 observed owned process identities absent
after the run and all 129 explicitly logged fixture path strings absent. Older tests that
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

## Integration with current main

The final run includes the prompt-cache measurement changes from #180. Full build,
workspace typechecks and 1,352 unit tests passed on that combined application source.
Only E2E fixtures changed afterward. The first corrections passed 12 focused cases;
the subsequent corrections below passed six focused cases and the complete
270-desktop/seven-site run in the table above.

Both earlier hosted macOS jobs passed 268 cases and failed two. Directly seeded thread
fixtures now select their target row explicitly because saved New chat selection can
survive relaunch. The held-creation fixture now clicks and focuses the editor before one
fill, records a trusted input event, and requires the exact newer text in native recovery
storage while creation remains held. It retains the rejection, immutable original, newer
draft and full-relaunch assertions. Three focused receipts and the full-run receipt prove
that accepted-edit precondition. The earlier traces lack input-event evidence, so the
original empty-input failure's cause remains unproven.

An intermediate local run passed 269 cases and failed the delayed-window-restoration
fixture: native bounds reached the target while the renderer retained its old dimensions.
That case passed unchanged in three focused runs and the final full run; the permanent
clamp rejection also remains unchanged. One earlier iPhone push job recorded partial
follow-up typing while its parallel PR job passed. These failures and their traces are
retained; current-head hosted checks are still required before merge.

### Hosted fixture follow-up

At `c1f21b0`, the PR macOS job passed, both iPhone jobs passed, and Windows/Linux native
jobs passed. The duplicate push macOS job passed 268 cases and failed two fixtures.
The shutdown test ran the scripted mock backend: its earlier blank launch had saved a
new-chat configuration, which correctly survived changing the global default on disk.
Waiting for that initial draft reproduced the failure locally. The fixture now selects
Claude through the UI and checks the selection before sending; its original CLI termination
and final-transcript assertions pass in three focused runs and the full suite.

The Store fixture expected a native menu action to be ignored while Settings was open,
but closed Settings immediately after the main-process click. Main's return does not
acknowledge renderer IPC delivery. The fixture now observes that delivery and rendered
state before closing the modal, and checks both the visible Settings receipt and unchanged
tab count. The original guest isolation, menu, disconnection and crash-cleanup assertions
remain. Three focused receipts and the full-run receipt record Settings visible when the
shortcut arrived. The older trace has no renderer snapshot, so its exact event ordering
remains unproven. No application code changed for these two fixture corrections.

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
