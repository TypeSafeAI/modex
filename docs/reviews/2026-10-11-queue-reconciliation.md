# Queue reconciliation, 2026-10-11

The queue remains open until its implementation, verification, and acceptance gates pass.
This review started from `main` at `6c00c52` and fresh GitHub REST reads of issues, PRs,
reviews, checks, and branch rules. Existing session worktrees were preserved. Work happens
in `.worktrees/queue-composer-audit`.

## Queue and acceptance gates

| Item | Reviewed head | Current disposition and next gate |
| --- | --- | --- |
| [#158](https://github.com/TypeSafeAI/modex/pull/158) | `00d2d6b` | Code review passed. Land the half-open TLS shutdown fix after current-base macOS CI passes. |
| [#160](https://github.com/TypeSafeAI/modex/pull/160) | `b57ace2` | Code review passed. Both iPhone jobs logged hardware keyboard `0` and passed. Preserve its status paragraph alongside #158. |
| [#161](https://github.com/TypeSafeAI/modex/pull/161) | `a2ced31` | Documentation review passed. Clarifies the Jev CLI is unofficial. Required macOS CI is mixed; PR title and description now describe the actual one-word change and the CI gate. |
| [#157](https://github.com/TypeSafeAI/modex/pull/157), [#159](https://github.com/TypeSafeAI/modex/issues/159) | `5d79f2e` | Changes required for copying/send coordination, failed-send draft merging, storage boundaries and transactional claiming, main-process limits, development commands, and composer sizing. Live Claude/Codex acceptance remains open. |
| [#152](https://github.com/TypeSafeAI/modex/pull/152) | `8c7e5b9` | Changes required for navigation-bound credential filling, passkey cancellation, and signed-build provisioning. Conflicts with current main. Real 1Password and signed Touch ID acceptance remain release gates. |

Issue #159 must remain open until all its criteria are met: picker, drop overlay, paste,
removable chips, copy errors, blocking send during copying, attachment-only send, drafts
across thread switching and failed sends, sanitized unique private byte-preserving storage,
main-process limits, both CLI backends, development commands, 960px responsive width, and
109px resting height. Required commands are `npm run build`, `npm test`,
`npm run typecheck`, and `npm run test:e2e`. Record live image and file checks with each CLI
here or in a linked review. Store attachments remain explicitly unavailable, including
when connected to a host, until a separate supported transport exists.

## CI failure evidence

- **#158 required macOS job:** [job 114100687058](https://github.com/TypeSafeAI/modex/actions/runs/38014173707/job/114100687058)
  passed 163 desktop E2E tests and timed out locating `Show Files` in the real
  OpenKnowledge test. The trace shows a nonzero count followed immediately by a locator
  that never resolved. OpenKnowledge 0.83.2 changes that label to `Hide Files` when its
  responsive sidebar opens across 1024px. A synthetic Chromium reproduction confirmed
  the count/click race. The retained CI trace has no DOM snapshots, so its final label
  cannot be established retrospectively. The helper now retries the file-visibility
  outcome, with bounded actions, and the test waits for the native guest to be visible.
- **#160 and #161 required macOS jobs:**
  [job 114122678156](https://github.com/TypeSafeAI/modex/actions/runs/38021303381/job/114122678156)
  and [job 114376499966](https://github.com/TypeSafeAI/modex/actions/runs/38107667505/job/114376499966)
  failed reference capture at 1380×880 instead of 1786×1049. #161's trace confirms the
  initial width poll passed before the viewport returned to launch size. A local
  regression reproduced the rollback after the first successful resize. Layout tests
  now reapply the requested native size on mismatch and require native and renderer
  dimensions to match for 200ms of polling observations, within the existing 15-second
  bound. A permanently clamped window still fails. Captures retain exact geometry
  assertions. An earlier attempt to await native `show` was rejected after broad
  testing found that macOS may omit that event for an inactive window; no production
  window code or packaged-app marker is changed.
- **#157 iPhone job:** [job 114377065533](https://github.com/TypeSafeAI/modex/actions/runs/38023101741/job/114377065533)
  timed out waiting for the Mac fixture to resume at `CompanionFlowTests.swift:169`.
  This matches the shutdown path addressed by #158. Land #158 first, then verify the
  integrated head. This is not image-attachment acceptance evidence.
- **#160 simulator setting:** both
  [job 114122689280](https://github.com/TypeSafeAI/modex/actions/runs/38021306991/job/114122689280)
  and [job 114122677942](https://github.com/TypeSafeAI/modex/actions/runs/38021303381/job/114122677942)
  printed `0` before the first simulator boot and passed the iPhone flow.

Local broad verification also exposed the packaged-demo unit test depending on the
maintainer's login shell. It failed twice at the demo's 8-second readiness deadline.
An instrumented run spent about 4.9 seconds in the scripted `git status` step; that step
awaits the core's login-PATH probe, whose own timeout is 10 seconds. Disabling that probe
with the existing `MODEX_NO_LOGIN_PATH` option made the isolated test pass. The packaged
fixture now sets and restores that option, retaining the real script, Git, sandbox, and
approval assertions. No production timeout was increased.

No unexplained failed job was rerun during diagnosis. Required branch rules remain signed
commits and a successful `unit + e2e (macOS)` check against current main, with no overrides.

## Verification record

- Clean baseline `6c00c52`: `npm run build && npm test` passed locally on macOS.
  Core 15 passed; desktop 431 passed, 1 skipped; development bridge 1 passed;
  site 10 passed; Store 9 passed. The skipped case is not live acceptance.
- The delayed native rollback regression failed against the original one-shot sizing
  helper: expected 1786×1049, observed 1380×880. Focused verification of the replacement
  passed 25 tests in 3.5 minutes across layout, window-lifecycle, and Knowledge, including
  the downloaded local OpenKnowledge runtime. Provider turns use fixtures, not live
  CLI acceptance. All content-size callers now use the helper; outer-window size
  callers retain their existing semantics.
- Fresh `npm run build`, `npm test`, and `npm run typecheck` passed. Unit results:
  466 passed, 1 skipped. Independent review found no blockers in the sizing helper,
  Knowledge retry, isolated demo fixture, or additional content-size callers.
- `MODEX_TEST_OPEN_KNOWLEDGE=1 npm run test:e2e` passed: 166 desktop tests in
  8.5 minutes and 7 site tests in 15.9 seconds. This run was based on `6c00c52`.
  #162 landed as `4945b33` during verification. After integrating it, fresh build,
  unit tests (468 passed, 1 skipped), and typecheck passed. The combined full E2E
  run passed 166 desktop tests in 16.0 minutes and 7 site tests in 16.6 seconds.
  Independent review confirmed the integration preserved both changes. Hosted
  checks remain required before landing.
- Read-only environment inventory found the `claude`, `codex`, and `op` executables,
  1Password.app, and Developer ID signing identities. This does not prove a successful
  provider turn, unlocked vault, authorized provisioning profile, or Touch ID interaction.

## Resume

Finish the CI synchronization verification and land that prerequisite. Integrate #158,
#160, and #161 serially, preserving both overlapping status explanations. Then complete
#157/#159 and #152 with targeted regressions and live acceptance receipts. Do not retire
this session's worktree while unlanded work or the local goal ledger remains there.
