# CF-3 native-question keyboard focus regression

This local follow-up to PR #487 starts at `712da73ebf2403081d8864ae3bfe529e4025e5ce`, preserving its native-question composer draft and attachment fixture. It addresses keyboard focus only; it is not human, VoiceOver, live-model, phone or release acceptance, and #276 remains open.

## Reproduction and repair

The first Electron regression submitted an incomplete native question with Enter. Main refused the answer and the card displayed its validation error, but disabling the Token input dropped focus to the page body. The original source also failed a separately gated accepted-answer check: after Enter removed the input, the displayed answer was not focused. Both failures were observed against the real renderer, IPC, runner and scripted Codex app-server fixture.

The card now remembers its submitting control, restores that control after validation fails, and focuses the first answer or closure status when controls are removed. It checks the current active element before restoring focus so a person who moves to the composer keeps focus there. Answer/status elements are programmatically focusable without adding Tab stops. The existing turn-fold handoff continues to move focus to the turn toggle.

The fixture holds turn completion until the answer-focus assertion finishes. Both variants preserve the exact whitespace-bearing draft, staged attachment, persisted recovery and attachment bytes through answer and reload. The moved-focus variant changes focus after the real Enter handler and before its asynchronous reply, then checks that the composer remains focused. Existing approval and Stop keyboard tests are unchanged.

## Validation evidence

Artifacts are retained outside the worktree under `/Users/buns/Documents/Codex/artifacts/modex-land-and-prune/question-focus-*`.

- `question-focus-red.log` and `question-focus-red-results/`: original invalid-submission focus failure.
- `question-focus-accepted-baseline-red.log` and `question-focus-accepted-baseline-red-results/`: original accepted-submission focus failure with the corrected finish gate.
- `question-focus-green-initial.log` and `question-focus-accepted-red-results/`: intermediate test expectation error; the assertion ran after the existing fold handoff. This is not evidence of an additional product bug.
- `question-focus-moved-fixture-failure.log` and its results directory: intermediate fixture error; Enter's default action inserted a newline after the fixture moved focus. The fixture now cancels that default action before moving focus.
- `question-focus-green.log`: all 13 focused native-question and existing keyboard cases passed in 33.5 seconds.

The full `pnpm build && pnpm test && pnpm typecheck` chain exited 0. Unit validation passed 2,300 tests with 26 skips: root 120; core 16; desktop 2,117 plus 20 skips; native checks 21 plus six skips; site 10; Store 16. `question-focus-validation-tail.log` retains the suite totals and typecheck completion; the initial build output is in the tool transcript. Build warnings were the existing bundle-size notices. Full E2E is queued behind another session’s Electron run and remains pending.

The changed Electron spec also passed its separate strict check: `pnpm --filter @modex/desktop exec tsc --noEmit --strict --noUncheckedIndexedAccess --target ES2022 --module ESNext --moduleResolution Bundler --skipLibCheck --types node e2e/human-requests.spec.ts src/renderer/bridge.ts` exited 0 (`question-focus-e2e-typecheck.log`). Workspace typechecks do not include E2E specs.
