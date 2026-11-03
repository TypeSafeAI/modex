# CF-3 native-question regression work

Status: local work in progress; not delivered or accepted. Original base: `9ecccc9bcea42ec99cd76092b1fe3bec15d05775`; integrated base: `7cfb29c7b0bfa452c9285f9b85a63a704cda857f`. This receipt concerns #276 and does not close its acceptance matrix.

## Changes and scope

Two runner tests exercise the real CodexBackend protocol fixture with YOLO enabled before a native question arrives and enabled while the question is pending. They require a waiting question with no answer, withdrawal or native reply until an explicit answer is supplied. A duplicate answer is refused, and the native process receives exactly one answer.

The Electron regression creates an idle Codex thread, stages a multiline composer draft and a pasted file, then starts a separate text-only turn through the real main-process `thread:send` channel. A fixture-only gate holds the native question until that turn is running. Assertions cover composer focus when the question arrives, unchanged draft recovery through answering and renderer reload, exact staged attachment identity and bytes, no extra user message, one native reply and no secret answer in app storage. This is a synthetic CLI fixture, not live-provider evidence.

The test initially attempted to stage the attachment while the thread was running. Independent review identified that the UI correctly refuses such staging. The revised setup stages it while idle; a second review found no further actionable defects by inspection. The recovered-host execution and further setup correction are recorded below.

## Initial validation before host recovery

| Check | Result | Limit |
| --- | --- | --- |
| Full build | Passed | Base plus local test changes; no production source changes |
| Workspace typecheck | Passed | E2E files are outside the configured TypeScript projects |
| Changed Electron spec, separate strict TypeScript check | Passed | Checks the spec and bridge types, not GUI behavior |
| Native-question fixture gate probe | Passed | Direct CLI protocol only; no Electron or composer |
| Human-request runner file | 34 passed | Includes both new YOLO cases |
| Temporary automatic-answer mutation | Both new cases failed | Compiled runner restored byte-for-byte; both cases passed again |
| Desktop TypeScript unit phase | 2,094 passed, 20 skipped, 2 failed | Notes watcher failures; full command exited 1 |
| Two Notes files in isolation | Same two failures | No change to these tests or their production source |
| Native JavaScript unit phase, separately invoked | 21 passed, 6 skipped | Does not make the failed full command green |
| New Electron test | Initial setup: launch failed before assertions; corrected setup: not executed | Electron launch exited with SIGABRT |
| Playwright test discovery and whitespace check | Passed | Parsing/discovery only, not UI execution |

The Notes failures occur in the watched-project and watched-folder cache assertions. An independent Node `fs.watch` probe reports asynchronous `EMFILE` for both recursive and nonrecursive watchers. NotesStore responds by removing its watcher and therefore cannot reuse the watcher-backed read cache those tests assert. Ordinary descriptor opens succeed, and raising only the diagnostic child process's file limit to 65,536 does not fix the watcher error. The source of that host limitation is unresolved; no other session's process was terminated.

The same Electron executable also aborts in a standalone GUI `--version` invocation, before Modex starts, while Node mode returns successfully. That reproduces a GUI startup failure outside this test, but does not establish its underlying cause. The first Playwright result directory was copied outside the worktree and checked file-by-file by SHA-256 before any later test run.

A direct probe evaluated the spec's actual fixture generator, started its generated CLI, and observed the turn start without a question while the gate was closed. Opening the gate produced exactly one native question with the two expected schema fields. One explicit answer produced one logged reply and completed the turn. This validates the new fixture's protocol sequencing only; the corrected Electron case has not executed.

Logs and the first-failure archive are retained under `/Users/buns/Documents/Codex/artifacts/modex-land-and-prune/` with the prefix `cf3-question-regressions-`. The external checkpoint records commands, process outcomes and review findings.

## Remaining gates

Deliver the verified candidate through signed commits and protected CI. Focus after answering and approval interactions are not covered by this new case. Human desktop/phone acceptance, VoiceOver decisions and TestFlight acceptance retain their existing separate gates. No issue checkbox is changed by this receipt.

## Host recovery and integrated verification

The host now delivers filesystem watcher events without errors and runs Electron GUI startup. The usual commit-signing identity was loaded successfully. The corrected idle-staging case initially failed because direct `thread:create` returns the new thread to its caller without adding it to renderer state. Reloading before selecting the thread hydrates that state through the normal startup path. This is a test setup correction, not a production change; the failing log and trace are retained under `cf3-question-regressions-recovered-first-results`.

All four human-request Electron cases passed after the correction. The worktree then fast-forwarded to main `7cfb29c`; the status-document conflict retained both upstream content and the CF-3 entry. The four cases passed again against the rebuilt integrated source (17.5 seconds). Independent read-only review found no actionable issue in either changed test file.

Two temporary fault injections exercised the new case. Clearing the composer after question arrival failed its exact-text assertion. Corrupting the staged attachment caused normal reload recovery to refuse the changed file with “A saved attachment is missing or changed; all files were preserved,” and the test failed instead of accepting missing composer state. Both injections were removed; the restored four-case run passed. These are controlled test faults, not reports of production data loss.

Integrated build, workspace typecheck and the separate strict E2E typecheck passed. Full `pnpm test` passed: worktree 120, core 16, desktop TypeScript 2,117 with 20 skips, desktop native/helper 21 with six skips, site 10 and Store 16 (2,300 passes, 26 skips, no failures). Both formerly failing Notes watcher cases passed. Full `pnpm test:e2e` passed: 481 desktop tests passed, seven skipped (23.2 minutes), and seven site tests passed (6.8 seconds). The command exited zero without a retry. Historical failures above remain preserved and do not describe the recovered host's current result.
