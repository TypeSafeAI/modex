# CF-7 saved task reopen, 2026-10-22

Implementation receipt for #280, under tracker #273. This is a local candidate, not a landed change or closure of either issue.

Base: `0e674e75237f393b8a1ba712061f5b303a61d5b4`. Owned worktree/branch: `cf7-note-reopen`, owner `01a164ff-3a16-74a0-8a8c-03caa7e21256`. The implementation and this receipt are saved together in a local signed commit. Tests started on the working-tree patch before that commit; the external source manifest identifies their inputs. This is not a pinned integrated main candidate.

## Behavior and evidence

- A task note offers **View saved task**, displaying the Markdown revision written by its explicit task save. Plans, clarifications, files and verification are rendered as saved. The view never rebuilds from current transcript items or calls a provider.
- Task saves retain original project provenance in the existing Notes history. Opening the view reconciles current Notes placement and reports later edits or cross-project moves, even when a move preserved the revision. Replacement saves keep the old note's receipt.
- Legacy notes use their saved revision association where available; orphaned historical task saves show their saved Markdown and explicitly unknown original-project placement. A task-like title or backlink alone does not create a task receipt.
- The UI has no editing or execution controls in the saved task region. Close restores focus to the opening button. Ordinary notes retain their existing editing behavior.
- Storage tests assert byte-identical Notes/history on an unchanged reopen, preserved saved text after edits/replacement/restart, and fresh ownership after a synchronous Finder move with a watcher active. Runner tests compare thread and transcript before/after reads.
- UI tests check saved content, no editable controls in the view, unchanged note/transcript, focus restoration, and a later edit kept separate from the historical view.

## Verification log

Environment: macOS `26.7.1` (`25G241`), arm64 `Mac17,6`, 128 GiB RAM; Node `v24.22.0`, pnpm `10.34.5`.

- `pnpm install --frozen-lockfile`: passed.
- Red storage regression: failed with `notes.taskView is not a function` before implementation.
- First UI attempt: timed out in `beforeAll` during initial Electron startup; no feature assertion ran. This is not evidence of a red UI feature test.
- Desktop build: initial implementation failed because this TypeScript target lacks `Array.findLast`; changed to reverse-and-find. Subsequent desktop build passed.
- Focused storage/task tests: 59 passed, 0 failed.
- Initial focused task-to-Notes UI run after build: 6 passed. Further edit/focus assertions were added afterward and require the full run below.
- First full build: failed because the Store demo's exhaustive handler map lacked `task:read-note`. Added its read-only null result.
- Full build after the Store handler correction: passed. Typecheck: passed.
- Expanded task-to-Notes plus plan-clarification E2E: 7 passed, 0 failed (16.3 s), including later edits and close-button focus. Visual inspection found a duplicate title and an invalid border token; both corrected for the final full E2E run.
- Full test sequence: repository workflow tests 117/117 (585.6 s), core 16/16. Desktop first pass: 1,823 tests, 1,806 passed, 16 skipped, one cancelled by its 6,000 ms timeout; command exited 1 after 351.8 s. All new saved-task tests passed. The cancelled case was `claude-lifecycle`: "runner: an unconfirmed stop keeps the worktree, and the old process cannot touch the next turn". Load averages during that run were 202.64 / 184.34 / 106.67. This is a failed first-pass gate, not excused by load.
- Isolated diagnostic rerun: `node --test --test-name-pattern='runner: an unconfirmed stop keeps the worktree' dist/test/claude-lifecycle.test.js` passed unchanged, 1/1, in 2.9 s (4.6 s process duration). This narrows the failure to a non-reproducing timeout under the full run's conditions; it does not turn the original run green.
- The failed unit command prevented the later desktop native tests, site/Store unit tests and E2E chain from starting. Those stages were started explicitly afterward: desktop native checks 21/21, site unit 10/10, Store unit 16/16. `pnpm test:e2e` completed its desktop stage on the compiled `27ca1c3` implementation: 389 passed, 6 opt-in skips, 32.0 minutes. The site stage could not start because port 5187 was occupied. A supported `MODEX_SITE_TEST_PORT=51945` rerun then reached browser launch and failed all seven cases because Playwright Chromium headless shell 1243 was absent. After installing the pinned Chromium dependency, the isolated site rerun passed 7/7 in 23.9 s. No other session's listener was stopped.
- The second complete compiled desktop unit run, `node --test --test-concurrency=4 'dist/test/**/*.test.js'`, passed: 1,823 tests, 1,807 passed, 16 skipped, zero failures or cancellations, 444.3 s, exit 0. It preserved every test and timeout while reducing concurrent test files. The formerly timed-out Stop case passed in 4.2 s. This successful rerun does not replace the failed default-concurrency first pass.
- iPhone gate preparation only: Xcode 27.1 (`27A9275`). Available runtimes are iOS 27.0 (including iPhone 18 Pro) and iOS 27.1 (iPhone Duo). The script's default iPhone 16 Pro / iOS 26.5 destination is absent. An integrated candidate run must name an available `MODEX_IOS_DESTINATION` and isolated `MODEX_IOS_DERIVED_DATA`; this is not an iPhone test pass.

These checks are local scripted evidence, not live-provider, physical-device or human VoiceOver acceptance. Logs are retained outside Playwright's disposable test-results folder.

## Legacy-save correction after the initial run

A read-only local fixture reproduced a compatibility defect in `27ca1c3`: save revision 1 with new project metadata, then save revision 2 using the old task-save format without metadata. The view returned revision 1. The red probe failed with `First task save` versus expected `Later legacy task save`.

The source correction selects the newest recognized task save in history order rather than prioritizing the presence of metadata. A permanent NotesStore test covers both a surviving thread association and an orphaned legacy save, retaining unknown project provenance for the latter. The original E2E process finished on its unchanged compiled build; its green desktop result is not evidence for this follow-up. The correction passed `pnpm build`, `pnpm typecheck`, the formerly failing probe, 61 focused storage/task tests, and all seven task-to-Notes/plan-clarification E2E cases. It is retained as a follow-up signed commit. The fresh standard `pnpm test` on `b5fae399d01123d695b6aea0b938d94e157d9407` exited 1: desktop 1,824 tests, 1,806 passed, 16 skipped, and two timeout cancellations (the existing Claude Stop case at 6,000 ms and demo slow-approval case at 5,000 ms), with zero assertion failures. This remains a failed gate. The chained E2E command did not start. The complete desktop rerun with four-file concurrency passed: 1,824 tests, 1,808 passed, 16 skipped, no failures or cancellations, 162.8 s. The unchanged Claude Stop case passed in 822 ms and demo slow-approval case in 2,468 ms. Explicit remaining native checks passed 21/21, site unit tests 10/10 and Store unit tests 16/16. Full `pnpm test:e2e`, with `MODEX_SITE_TEST_PORT=51945`, passed: desktop 389 passed, six opt-in skips (22.4 minutes); site 7/7 (9.9 s). These reruns do not replace the failed standard-concurrency gate.

## Decisions and remaining gates

Recommend retiring plan-step linking. Neither supported CLI reports which check verifies a specific step. The existing turn-level check evidence is honest; inferring a step relationship would contradict the documented provenance boundary. No step-linking change or closure is made without Val's explicit decision.

All unspecified gates remain required: final integrated candidate, live Codex after 2026-10-25 09:35, live Claude, physical iPhone, Windows/Linux, 8 MB slow-stream drop, power-loss behavior, human keyboard/VoiceOver, and remaining child-specific acceptance. A new candidate must be pinned after this and the phone-answer changes land.

Phone answers are owned by `cf3-phone-answers` for both #276 and #279 and now published as [PR #373](https://github.com/TypeSafeAI/modex/pull/373), head `16e94c963f7e7c544ee99de55b66708b048138c1`. Its owner reports successful full unit/E2E reruns and iPhone simulator tests, retaining the initial unit timeout; macOS and iPhone CI were still running at this refresh. These are the owner's results, not an independent rerun by this session. Later inventory also found `cf4-closeout`, `cf8-integrated-oct22`, and a newly claimed `cf7-reopen`. The `cf7-reopen` owner subsequently [handed this slice to `cf7-note-reopen`](https://github.com/TypeSafeAI/modex/issues/280#issuecomment-6349982765) and confirmed its alternative would remain unpushed. Ownership overlap is resolved; the alternative commit remains preserved. None of those worktrees was modified by this session.

A later external-state refresh found documentation-only PR [#369](https://github.com/TypeSafeAI/modex/pull/369), head `6739186d85e7b0a28f956fd78904910067e6ee25`, for the CF-3 native Plan-mode decision and human question acceptance. Its reported live capture is separate from this candidate; it is unmerged and awaits Val.

This receipt was finalized before publishing the branch for review. No merge, tag or release has been made by this session. Signed commits `27ca1c3e3462d6bf504b4f03c2d0c57e51b26c8d` and `b5fae399d01123d695b6aea0b938d94e157d9407` preserve the tested implementation. A subsequent documentation-only commit records the final results without changing tested code. The initial GPG/configuration check found no signer, but a subsequent read-only SSH-agent inventory found a loaded key matching BunsDev's registered "Buns Mac commit signing" key (ID 1259375, fingerprint `SHA256:YprOIgLzN6V1HRC23ZBFfarWcT8LC3y45AMN4QDe9rs`). A local `ssh-keygen -Y sign`/`verify` probe succeeded for the `git` namespace and `val@opencoven.ai`. Signing is available through invocation-scoped SSH configuration; no key or account permission was changed. Val's go-ahead and the merge guard remain mandatory for any landing.
