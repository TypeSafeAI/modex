# Real-model Electron lifecycle qualification

This candidate contributes a bounded Ollama/Codex pilot slice to #380 AC4 and #383 AC1. Product main still constructs no `LocalExecution`. The test-only admission bootstrap is unpackaged, explicitly opted in, confined to disposable mock homes and projects, and pinned to the approved model and context. Whole-issue acceptance, activation and publication retain their separate gates.

## Protocol and assertions

The existing Electron fixture runs the production main, preload, IPC, store, runner and renderer. Its opt-in native transport uses the existing `LocalExecution`, `CodexBackend` and real installed Codex CLI. Codex talks directly to an owned Ollama server. A passive observer records native method names, lifecycle/error events and owned child identity; it does not rewrite protocol frames, proxy inference or execute tools. Ordinary CI skips the four native cases before starting a server or CLI. Five GPU-free fixture checks exercise opt-in/admission refusals and independently demonstrate that incorrect edited bytes fail the seeded checker.

Each case has its own disposable project. Only exact predeclared shell commands in that project may be approved. Delayed commands synchronously write an exclusive start marker and dispatch record, then schedule their effect for 10 seconds later. Fault injection must occur at least two seconds before that deadline. Observation extends 1.5 seconds beyond it. Script hashes and the read sentinel must remain unchanged. The golden case separately approves the exact edit and independent check, asserts the actual bytes and exit code, and inspects the rendered diff.

Stop must leave zero delayed effects. Codex/server-loss cases allow zero or one original effect, reflecting what actually happened; neither outcome permits replay. Restart must preserve thread identity, target and history, refuse a stale native handle before spawning, and leave original dispatch/effect counts unchanged. An explicit fresh target selection and command must produce exactly one fresh dispatch and effect. Cloud-backend invocation counts must remain zero.

## Reproduced defect and repair

The original real server-loss run left the turn running through repeated native connection errors until the 90-second observation limit, despite zero provider retry settings. The original receipt remains under `loss-3/` in the external evidence root. Separate failing regressions showed that a local retry error with a final answer in either event order could be settled as success by the quiet-final timer before cancellation was acknowledged. The cloud control passed.

The repair is confined to configured local Codex turns: a native `error` with `willRetry: true` requests interruption, suppresses quiet-final success and retains ownership until a terminal event. The result remains failed, including when native cancellation reports interrupted. Existing background-terminal cleanup still handles open commands. Cloud retry handling is unchanged. The [official error contract](https://learn.chatgpt.com/docs/app-server#errors) describes `willRetry` as an active native retry; its [interrupt contract](https://learn.chatgpt.com/docs/app-server#interrupt-a-turn) distinguishes the RPC receipt from terminal completion.

Preliminary real-model requalification of the server-loss repair passed: one native retry notification, an interruption request 8 ms later, native terminal acknowledgement, failed app state, preserved history/target, stale-handle refusal and one explicit fresh effect. The final revision-bound results are recorded below.

## First complete verification and fixture repairs

The first complete driver pinned staged tree `5b208a4e09abdb89c461cda8d8a0d0b69cfdb590` on input head `f424950a8f1b92c53649a8672936e98e2ac2fc1a`; no new signed commit existed. Build and typecheck passed. Unit results were 2,403 passed, 35 explicit skips and zero failures. Four scripted Electron journeys passed. Desktop E2E ended with 501 passed, 11 skipped, one failed Images test and one worker teardown error; the canonical command therefore did not start site E2E. These are failed whole-build results, retained under `first-pinned-tree-verification-5b208a4/`.

The Images trace reached final app close after its image and relaunch assertions passed, then Playwright's default dialog dismissal raced Electron's native `beforeunload` handling. The fixture was adjusted to the repository's existing native-dialog ownership pattern on both app instances. Ten focused repetitions passed, but the second complete run still timed out on the native close veto. The fixture-only change was therefore insufficient; no close veto was bypassed and no protocol error was swallowed.

The same first driver passed three real-model lifecycle cases. Its server-loss case stopped before approval, execution or fault injection because the model printed a permission-question tool call as assistant text. The harness correctly refused to count that prose as execution. The fixture prompt now names the shell tool and makes native approval the client's responsibility; it neither parses model prose into actions nor retries failed coding work. This qualifies the declared fixture prompts, not general model task quality. The original failure and transcript remain retained.

Focused requalification on staged tree `b90840f086acf65236a8e765b1cc915466fee933` passed all four actual Electron/Codex/Ollama cases. An independent receipt audit checked every tool's exact command, order, count, outcome and exit status, with no undeclared tools. All four observed loaded context 65,536 and zero cloud-backend calls. Personal Codex configuration stayed unchanged and the owned service stopped. The subsequent complete checks are recorded below.

| Native lifecycle case | Original dispatches / effects | Original command outcome | Explicit fresh dispatches / effects |
| --- | --- | --- | --- |
| Stop | 1 / 0 | Interrupted; no late write past the deadline | 1 / 1 |
| Owned Codex loss | 1 / 1 | Unknown to Modex; the surviving original command wrote once | 1 / 1 |
| Owned Ollama loss | 1 / 1 | Command succeeded; the coding turn failed and its native reconnect was interrupted | 1 / 1 |

The golden case ran exactly three commands: one fixture read, one approved edit and one independent check, all with exit code 0. Its rendered diff was inspected. Every recovery case preserved history and target, refused the stale handle before creating a child, and kept original dispatch/effect counts unchanged after the explicit fresh action.

The separate network-denied native read/edit/check canary passed on the first driver tree. That receipt includes denied external TCP and outside-file-write probes, the same enforced sandbox identity in the native workflow, approved model digest observations and owned server cleanup. It is a separate canary, not an offline claim for the Electron lifecycle cases. Model metadata reports GGUF Q4_K_M, 30.5B parameters, 18,556,700,761 bytes and template SHA-256 `b507b9c2f6ca642bffcd06665ea7c91f235fd32daeefdf875a0f938db05fb315`. Native runs used Codex 0.167.0, Ollama 0.40.15, Electron 44.4.5 and Node 24.22.0 on Apple M5 Max arm64, Darwin 27.2.0, 128 GiB RAM.

The signing gate remains open. The approved signing public key is listed by the existing agent, but both standard `ssh-keygen` and the installed 1Password signing helper timed out with that same key in the prior SSH context and again in the functioning Aqua context. Computer-use inspection also timed out; no approval was observed. No unsigned commit, alternate key or signing-policy change was used. The input-history bundle plus staged patch restored the exact qualified tree in an empty bare repository; final signed-head recovery remains pending. The gate needs normal access to the existing signing key, not another unchanged timeout attempt.

## Acknowledged image-draft close repair

The second complete driver pinned tree `4ea1ef378148962445cb378edd02fe85e6ed2b8f`. Build, typecheck, 2,403 unit passes with 35 skips, all four scripted Electron cases, all four real-model lifecycle cases and the separate network-denied canary passed. Desktop E2E again had 501 passes, 11 skips and the Images final-close failure, this time a 90-second timeout with the native veto retained. Site E2E was not reached. These failed whole-build results remain under `second-pinned-tree-verification-4ea1ef3/` and are not relabelled green.

Images queued a write immediately after loading an already acknowledged draft. That redundant pending write could veto ordinary Quit even though the person had made no edit. The deterministic regression holds any such redundant write, restores the actual saved draft through the renderer, requests normal native Quit and checks whether the app exits. Before the repair it failed at the native close assertion in 1.7 seconds (`images-unchanged-red-2/`, tree `9314a7b1d2d6fef24d8fe7e20529f161d57a3c9b`). The renderer now skips a save only when no save is pending and the exact current draft matches its last acknowledgement. Pending or failed changed drafts still keep their close veto.

All eight Images cases passed after the repair (`images-unchanged-green-2/`, tree `4805b857f83b619c44a9a3339e65efa54dc03d0f`), including actual ordinary Quit with exit code 0 and no signal, no redundant write, unchanged saved bytes, and the existing delayed/rejected-save controls. The regression's earlier fixture setup and disposed-process-handle failures remain separately retained. All eight also passed in the subsequent complete desktop suite.

The existing SSH route later stalled during agent authentication. A fresh check found that the current tool process had become a normal Aqua user session with working UID 501 lookup. Private-home Codex configuration and managed-requirements reads both passed directly in that session, and the retained Electron binary still matched SHA-256 `812817f98c3b72ec67efbe7ccec46d650abf3f501568e8b5f75b59b8a116814f`. The failing regression and Images green run then used that normal context. No global configuration, credentials or managed policy were changed.

During verification, upstream main advanced from `49ff1e1d214b50adff54799e148669a147f96f7e` to `d7650e4c54cdd15e4ee4f14b9f4dec3455ba1e77` through #495's question-card focus repair. The comparison touched question-card UI, CF-3 fixtures and documentation, with no local-model backend/admission or Images changes. This qualification continues to name its exact candidate tree; it does not claim a whole-build run on that newer main.

## Complete qualification on 2026-11-08

The final driver ran directly in the functioning Aqua user context from 12:18:19 to 12:45:52 UTC and passed all seven stages without retries. Its exact qualified staged tree is `c7e87f81fe0b4dd95225faa74635f482a55a8aa4`, on signed input head `f424950a8f1b92c53649a8672936e98e2ac2fc1a`. The driver checked the same tree and absence of unstaged edits before and after every stage. The complete report is retained under `qualified-c7e87f8/` in the external evidence root, with an independent SHA-256 manifest. Later evidence/status edits are documentation only and are compared separately against the qualified tree; they do not replace its source identity. A final REST read still found main at `d7650e4c54cdd15e4ee4f14b9f4dec3455ba1e77`.

| Command / scope | Result | Retained receipt |
| --- | --- | --- |
| `pnpm build` | Passed; core, desktop, site and Store desktop | `build.log` |
| `pnpm typecheck` | Passed | `typecheck.log` |
| `pnpm test` | 2,403 passed, 35 skipped, zero failed; 2,438 total | `unit.log`, `unit-counts.json` |
| Scripted Electron local-model acceptance and Settings journeys | Four passed | `scripted-electron.json` |
| `pnpm test:e2e` | Desktop 503 passed, 11 explicit skips, zero failed; site seven passed; no teardown error | `full-e2e.log` |
| Opt-in real Electron/Codex/Ollama lifecycle suite | Four passed; all nine native commands independently audited | `native-electron.json`, `native-cases/` |
| Separate network-denied native read/edit/check canary | Passed; both external-network and outside-file-write probes denied | `offline/`, `offline-independent-audit.json` |

The native run used the approved model digest and template hash above, Codex 0.167.0, Ollama 0.40.15, Electron 44.4.5, Node 24.22.0 and pnpm 10.34.5 on Apple M5 Max arm64, Darwin 27.2.0, 128 GiB RAM. The retained Electron executable still matched SHA-256 `812817f98c3b72ec67efbe7ccec46d650abf3f501568e8b5f75b59b8a116814f`. Each of the four native cases independently observed actual loaded context 65,536 and zero cloud-backend calls. Personal Codex configuration bytes and modification time stayed unchanged.

The golden case executed exactly `cat fixture.txt`, `echo LM3-APPROVED-EDIT-8c42 > result.txt` and `node check.cjs`, each once with exit code 0. The independently read result was exactly `LM3-APPROVED-EDIT-8c42` followed by one newline, and the actual checker ledger contained one successful check. Direct image inspection confirmed that the selected `result.txt` diff visibly contains that line. The screenshot also retains a literal `<tool_call>` fragment in assistant prose after the edit; it was not counted as execution or general model task-quality acceptance.

| Case | Injection before original deadline | Original dispatches / effects | Outcome retained by Modex | Explicit fresh dispatches / effects |
| --- | --- | --- | --- | --- |
| Stop | 9,934 ms | 1 / 0 | Interrupted; no late effect | 1 / 1 |
| Owned Codex loss | 9,919 ms | 1 / 1 | Unknown; the original command completed its one effect | 1 / 1 |
| Owned Ollama loss | 9,926 ms | 1 / 1 | Command succeeded; turn failed | 1 / 1 |

The independent actual-file audit checked all start markers, immutable fixture scripts, dispatch/effect ledgers, exact fresh output bytes and original history IDs. Every fresh command began after the original deadline plus the 1.5-second no-replay observation period. In server loss, one native retry notification was followed by one interruption request 10 ms later and a native interrupted acknowledgement three milliseconds after that; Modex retained a failed turn. The original native turn was started once. Each restarted app refused the stale handle before spawning and admitted only the explicit fresh action. The suite and the independent audits are retained separately as `independent-tool-count-audit.json` and `independent-file-effects-audit.json`.

The separate network-denied canary covered its owned Ollama server and native Codex child under the same enforced boundary, `sha256:aefc366f7c30fc194b1cdc927a61b256ca43287315ce4c14005dd09630af3f91`. Its outside-write positive control succeeded before entering the sandbox; external TCP and the same outside write were then denied with `EPERM`. Read, approved edit and check all completed, with three actual native commands and exit code 0 for each. The approved model digest matched before and after. This remains a separate native canary, not an offline claim for the Electron lifecycle cases.

The driver and observer exited, and a fresh process check found none of the 51 command identities observed under the owned driver still running. All four native fixture repositories and their application state/history were retained as 178 files with per-file hashes. The first retention invocation refused the caller's different temporary-directory namespace before copying anything; rerunning the retention helper with the driver's `/tmp` namespace passed without relaxing its guards. Both attempts remain recorded.

Qualification and recovery of the unsigned candidate are complete; signed review-ready commits and signed-final-head recovery remain open. No feature activation, issue checkbox, hosted CI, PR publication, merge or release is claimed.

## Reproduction

Use the already installed approved `qwen3-coder:30b`, digest `06c1097efce0431c2045fe7b2e5108366e43bee1b4603a7aded8f21689e90bca`, with context 65,536. The native suite starts only its own loopback server with a private home and the existing model store; cloud routing and pruning are disabled for that server. It verifies the digest before inference and records model metadata, template hash, CLI/runtime identities, configured/loaded context and hardware. No model is downloaded.

```sh
pnpm build
cd apps/desktop
MODEX_LM_NATIVE_E2E=1 MODEX_LM_NATIVE_REPORT=/absolute/new/evidence/directory pnpm exec playwright test e2e/local-model-native.spec.ts --workers=1 --reporter=list
```

Run from a functioning macOS user session. An already installed compatible Electron distribution may be selected with `ELECTRON_OVERRIDE_DIST_PATH`; do not let the dependency loader download one. The qualification report must be outside the worktree and unused. `MODEX_KEEP_TEST_TMP=1` retains seeded homes/projects for inspection. The suite checks that personal Codex configuration bytes and modification time stay unchanged. It stops only its owned servers and app children. A failure ends the serial run without retries and retains earlier receipts.

## Evidence limits and handoff

The durable evidence root is `/Users/buns/.codex/task-evidence/modex-lm-native-recovery-2026-11-08`. Initial launcher and fixture failures remain recorded there: missing worktree-local Electron binary-path metadata, an omitted CLI resolver argument, an unhandled exact read approval, a model-requested unapproved preliminary command, and an incorrect Electron evaluation callback argument. These were qualification infrastructure failures, separate from the reproduced native reconnect defect. The owned-PID guard rejected the malformed callback argument without killing a process.

Scripted fixtures, real-model Electron execution, network-denied native execution and human acceptance remain separate evidence classes. This Electron suite uses the ordinary native sandbox and proves no offline boundary. Human keyboard/screen-reader, paired-client, OOM, overflow and broader runtime/platform matrix acceptance remain unrun by this slice. Existing historical receipts retain their original source and runtime identities. No issue checkbox changes, release, hosted CI, merge or feature activation are claimed.
