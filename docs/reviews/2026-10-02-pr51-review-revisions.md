# PR #51 review revisions

Addresses BunsDev's 2026-10-02 review of `ac1c1dc`. The branch was rebased onto
`origin/main` at `b79e59a`, including approval-rule plumbing and the terminal updates.
The `store.ts` conflict preserves both approval migrations and persistence before
publishing any settings change in memory.

## Findings and changes

| Review item | Change | Regression evidence |
| --- | --- | --- |
| 1. Unspecified pinned effort becomes the ceiling | Prefer the model's advertised default, otherwise medium; still match supported efforts under the active ceiling. Receipts describe selecting or adjusting effort accurately. | Codex and Claude policy cases for no default, low default and a default above the ceiling. |
| 2. Blank CLI-default model is repeatedly blocked | Resolve a blank model to the catalogue's `isDefault` candidate while retaining the blank selection and session. | Default model, ceiling, unknown default and spent premium-budget policy cases. |
| 3. Discovery failures are cached for a minute | Cache only successful non-empty lists. Retry returned errors, thrown errors and empty lists on the next turn; include discovery errors in any stop message. Available backends can still provide a safe route. | Three discovery failure variants followed by immediate recovery and successful caching; runner stop-message check. |
| 4. Fit writes block safe turns | Catch learning persistence failures after a safe decision and when recording outcomes. Keep session learning and premium counts in memory for the next successful write. | A real directory blocks the fit temporary file: the premium turn completes, the next turn is budget-capped, and a later write persists both routes. |
| 5. Blocked receipts say Auto kept | Carry an optional `blocked` flag in route items and render Auto blocked; blank models display CLI default. | Unit receipt flag and Electron display test, including an older pinned receipt without the flag. |
| 6. Repairing a block teaches an older route's tier | Suppress overrides after blocked or unfinished routing; check the latest transcript receipt in the runner, including restored transcripts. A route change during model discovery also invalidates an override. | Safe turn, blocked turn, manual repair with unchanged fit, then normal learning after a later safe route. |
| 7. Executable hints mix drafts with saved status | Show unchecked draft feedback until saved or reverted; use saved transport for executable-status claims. | Saved HTTPS followed by unsaved Auto and CLI choices, then revert. |
| 8. False settings-changed warnings | Require an explicit tested identity and actual invalidation or mismatch. Missing status and rejected IPC calls do not imply a settings change. | Rejected test IPC and failed status refresh without a stale warning; genuine draft changes remain covered. |
| 9. Early actions strand opening status | Represent status failures explicitly and keep Test judge available to retry. Ignore old opening responses after an action owns status. | Delayed opening status, test success plus failed refresh, late opening response, and successful retry; failed immediate key/reset actions also recover. |
| 10. Doubled fallback punctuation | Strip trailing sentence punctuation before adding the heuristic suffix. | The Auto Electron test asserts the contiguous `are all empty; used the built-in heuristic.` text. |
| 11. Repeated save-error instruction and IPC prefix | Normalize Electron's remote-method prefix, including an empty Error, and render the draft-retention sentence once. | Real and empty IPC failures, preserved drafts, and exactly one retry instruction. |

## Smaller cleanups

- One generation-aware `disableOn` helper handles auth/billing failures for judge tests,
  routing, follow-ups and the approval-gate transport.
- `shared/judge-settings.ts` centralizes saved judge identity and explicit-test matching.
- One `keepCurrent` path handles confidence-gated and missing-candidate routes; one
  effort-ceiling helper applies configured and premium limits.
- Removed duplicate `tested.transport`, stored `lastTest.current`, and `savingRef`.
  Test transport and operation ownership each have one source of truth.
- Status documentation describes #51 as in flight until it merges.

## Validation

All checks use fake providers or offline IPC; no live coding or judge request is required.

- `npm run build` and `npm run typecheck`: pass.
- Focused routing, ceiling, settings-update and write-failure unit group: 45/45 pass.
- Relevant app, review, layout and transaction Electron group: 40 pass, one macOS-only skip.
- Full Windows unit command: core 15/15; desktop 154 pass, 11 failures, 10 skips.
  An isolated unchanged rebased PR reproduces the same 11 failures (148 pass, 10 skips).
  They concern POSIX filenames, symlinks, worktree scripts, file modes, PATH and login shells.
- Full Windows Electron command: 55 pass, eight failures, one skip, 11 not run after
  serial-suite failures. The unchanged rebased PR reproduces seven CLI/terminal failures
  (56 pass, one skip, five not run). The additional layout failure was a window-width
  precondition (1920 instead of 1786); the unchanged layout suite passes 14/14 on an
  isolated rerun of the final code. All settings and routing checks pass in the full run.
- Native macOS CI is recorded on the PR after publication. The required native
  `unit + e2e (macOS)` check remains the merge gate.

Ignored local logs are under `apps/desktop/.probes/` in `jev-review51`; unchanged comparison
logs are in the same directory of the separate `jev-review51-baseline` worktree.
If the learning file cannot be written, session counts remain effective, but that new
learning cannot survive an app restart until a later write succeeds.

## Maintainer follow-up, 2026-10-03

Rechecked incoming head `6e31c6a` against every acceptance criterion in issues #40–#50,
all eleven findings in BunsDev's review, and its four smaller cleanups. The source and
regression coverage address the transport, setup invalidation, session-consent and effort
limits; the Settings transaction, status, accessibility and advanced-control paths; and
the default-model, discovery, learning and receipt corrections. The merge from current
main retains approval-rule migrations and transactional persistence. There were no inline
review threads to resolve.

One verification gap remained: the refresh-failure test saved `chat` over a fixture already
set to `chat`, so a stale renderer snapshot could pass. It now checks the initial value,
saves `agent`, and requires `agent` after reopening. The corrected test passed with the
implementation, then failed at the expected `agent`/`chat` assertion when the saved-state
update was temporarily removed. The production source was restored without changes.

The first macOS unit run passed core 15/15 and desktop 174/175. The unchanged terminal test
`supervisor death seen as a failed CLOSE write still reports a missing cleanup receipt`
failed its SIGKILL observation under a machine load average of 129; its complete nine-test
file then passed unchanged. A second parallel run hit the unchanged cleanup-retry timeout.
All 175 desktop tests then passed with `node --test --test-concurrency=1 'dist/test/**/*.test.js'`;
core 15/15, build and typecheck also passed. No assertion or timeout was changed. The local
Electron run timed out during `app.close()` in the unchanged window-persistence test.
The [required hosted macOS check](https://github.com/TypeSafeAI/modex/actions/runs/37035528962)
passed on incoming head `6e31c6a`, including the normal unit and complete Electron commands.
The follow-up test/documentation commit still requires its own green hosted check before
merge; final validation is recorded on the PR.

All provider behavior was exercised with offline fixtures. Automated keyboard and layout
checks do not claim human keyboard-only or VoiceOver acceptance, nor live-provider health.

Before landing, main advanced to `95e7459` (#61). Its send-error IPC and regression tests
merged without conflicts, preserving both immediate send-error propagation and #51's
transactional settings update. The synchronized head must pass a fresh required macOS
check; the earlier green check and approval are not sufficient for that new head.
The combined build and core 15/15 passed locally. Desktop passed 172/176, including the
new busy-send case and all routing/settings regressions; the four failures were in the
unchanged terminal-cleanup tests. Their assertions and deadlines remain unchanged.

The synchronized head `eec32fc` passed its [required hosted macOS check](https://github.com/TypeSafeAI/modex/actions/runs/37138476973):
core 15/15, desktop 176/176 and Electron 75/75, with no skips. Main then advanced through
#60's rename diffs and #62's offline worktree helper to `ef081ff`. Both merged without
conflicts; they do not change Jev routing or Settings transactions. The final combined head
again requires the complete hosted macOS check, recorded on the PR before merge.
The combined build, all 13 Git tests (including four new rename-diff cases), and the focused
Electron send/approve/Changes test passed locally. An isolated offline helper smoke test
also confirmed cached-ref worktree creation and removal with an unavailable remote.
The normal full unit command then passed core 15/15 and desktop 180/180, with no skips.
The documentation-only main update `1c3ec6f` (#67) was reconciled afterward: its status
entries and known rename-diff follow-ups are retained, #51 is recorded as landed, and
duplicate entries are removed. No executable code or tests changed in that reconciliation.
