# CF-8 repinned candidate: ec7be57

Candidate: `ec7be578765f9ce54976882853e57ca190252361`, fetched from main on October 22 at 21:45 UTC. This candidate includes #369 and #373 (phone question answers through the broker and the CF-3 decision/acceptance documents). The prior [0e674e7 receipt](2026-10-22-cf8-integrated-candidate.md), images, logs and live observations remain historical evidence for that SHA; they are not passes on this candidate.

Current results: first install/build/typecheck/unit and desktop/site E2E passed; the iPhone classes passed 43/43 on isolated iOS 27.0 after the unavailable default destination. The second screenshot attempt passed after correcting this session’s missing output directory; 33 images and 2/2 measurement tests are recorded. Live Claude’s full probe failed for missing structured plan. Val’s human report, the dated Codex rerun and remaining child acceptance/integration are open.

## Preparation and first attempt

The owned `cf8-integrated-oct22` worktree was fast-forwarded from `0e674e7` after preserving its staged evidence in an external archive and named Git stash. The evidence reapplied cleanly, including status.md. Ownership passed and disk had 6.5 TiB available. No other worktree was edited. No unsigned commit, push, release or tag was performed.

The first explicit sequence started at 21:46:26 UTC: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, and the iPhone script. Logs and append-only command results are in `/Users/buns/.codex/attachments/cf8-integrated-ec7be57-evidence/`; the ignored runner is `apps/desktop/.probes/cf8-gates-ec7be57.py`. Every command records timestamps, exit code and HEAD. Desktop/site E2E artifacts are archived before further Playwright runs.

The iPhone script will first use its default destination, retaining any unavailable-runtime failure, then run the same classes on the isolated iPhone 18 Pro/iOS 27.0 simulator `192B1FDC-0946-43CE-9215-C12305165D36`, with separate derived data. No timeout or class selection is weakened. This is simulator evidence only.

## Candidate acceptance matrix

| Surface | Evidence on ec7be57 | Next action |
| --- | --- | --- |
| Install/build/typecheck/unit | First attempts passed; unit 1,991 passed/16 skipped, no failures or cancellations | Exact times and hashes recorded |
| Desktop/site E2E | First pass exited 0: desktop 388 passed/6 skipped, site 7/7 | Artifacts archived; live-provider and human gates remain separate |
| iPhone UI classes | Default destination exited 70; isolated iOS 27.0 passed 43/43 | Physical-device and human acceptance remain separate |
| Fixture captures and measurement | Second capture attempt 14/14; 33 images validated; measurement 2/2 | First capture-directory failure preserved; five-launch budget acceptance separate |
| Live Claude | 2.1.309 Sonnet: edit/check, Notes/restart and Stop passed; overall probe failed for zero plan items | Native plan evidence or Val’s explicit deferral required |
| Live Codex golden path and Stop | Not run | Required after October 25 09:35; repin guard before use |
| Human keyboard/VoiceOver | Rebuilt seeded ec7be57 window verified open; no human result | Await Val’s exact report or explicit deferral |
| Native question acceptance | Newly landed checklist, no human results | Include D1–D5, V1–V3 and P1–P6 from the CF-3 acceptance document |
| Remaining dependencies | #277/#280 acceptance and integrations remain open | Recheck main and owner decisions before final acceptance |

The [native-question acceptance steps](2026-10-22-cf3-question-acceptance.md) and [Plan-mode decision](2026-10-22-cf3-plan-mode-decision.md) were read from this candidate. Landing the decision document does not itself select a Plan-mode option. The provider feature changes described in the human checklist have not been applied by this session. Physical iPhone/TestFlight and human VoiceOver results are not inferred from simulator tests.

The old seeded app and future Codex probe refer to the prior candidate until explicitly rebuilt/relaunched or regenerated. No human pass or written deferral has been received. Gate #281 remains open.

## First-sequence checkpoint

Install, build and typecheck each exited 0 on `ec7be57`; the full unit command started at 21:47:08 UTC and remains running. No unit, E2E or iPhone pass is claimed until a terminal command result is recorded.

| Command | Started UTC | Ended UTC | Exit |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 2026-10-22T21:46:26.391802+00:00 | 2026-10-22T21:46:30.720620+00:00 | 0 |
| `pnpm build` | 2026-10-22T21:46:30.748292+00:00 | 2026-10-22T21:46:53.088291+00:00 | 0 |
| `pnpm typecheck` | 2026-10-22T21:46:53.105434+00:00 | 2026-10-22T21:47:08.443310+00:00 | 0 |

The separate `run-codex-after-reset-ec7be57.py` now pins this candidate and retains the date, remote-main and source-diff guards. Invoked on October 22, it refused before launching Codex. Candidate-specific capture-manifest and verification scripts are copied outside the worktree under this candidate’s evidence directory. The prior scripts remain preserved.


## First full unit result: passed

The first `pnpm test` on this candidate exited 0 at 21:52:09 UTC. Counts: root 117/117, core 16/16, desktop primary 1,811 passed and 16 skipped (1,827 total), desktop secondary 21/21, site 10/10 and Store 16/16. Combined: **1,991 passed, 16 skipped, zero failures and zero cancellations**. No rerun, timeout change or source change was needed. The logged analytics “disk full” message is an injected failure in a passing ledger test, not a host ENOSPC result. Exact command times and log hashes are in [the candidate command record](2026-10-22-cf8-ec7be57-command-results.json).

The first `pnpm test:e2e` started at 21:52:09 UTC. Its terminal result and both iPhone attempts are still pending; this unit result does not establish those gates.

## Fixture fidelity checkpoint

The first E2E log records all **8 conversation-fidelity cases** and **7 conversation-evidence cases** passing on this candidate. Coverage includes the fixture golden path, denial, failing check, Stop, native withdrawal, exactly-one desktop/phone answer, journal reconnect after the decision, and a question saved to Notes and restored inertly after restart. These are fixture/automated results; they do not satisfy the live-provider or human rows. The full desktop/site command remains running.

## First desktop/site E2E result: passed

`pnpm test:e2e` exited 0 at 22:13:00 UTC: desktop **388 passed, 6 skipped** in 20.2 minutes; site **7/7 passed** in 10.5 seconds. Both first-pass `test-results` directories are archived in the candidate evidence directory as `desktop-first-e2e` and `site-first-e2e`. The default iPhone script started next; no iPhone outcome is claimed yet.


## Native and capture checkpoint

The default iPhone script exited 70 because no device matched iPhone 16 Pro/iOS 26.5. The original log is retained. The same script then ran on the explicitly selected isolated iOS 27.0 simulator: CompanionFlowTests passed 23/23 in 98.372 seconds; DemoWorkspaceTests remains running, so there is no combined native pass yet.

The first separate capture run exited 1 with 10 passed and 4 failed: this session omitted creating `MODEX_SCREENSHOTS`' target directory, and the four screenshot-writing cases threw ENOENT. Its log, result and artifacts are preserved as `captures.*` and `captures-artifacts`; this does not replace the original full E2E pass. A second attempt, `captures-second`, creates the directory first and reruns unchanged tests. Its result is pending.

The separate transcript measurement command exited 0. The [candidate measurement](2026-10-22-cf8-ec7be57-transcript-measure.json) records a 222 ms cold open, 85 ms repeated-open median, a 175 ms cold renderer long task, 663,894 stream bytes sent to the window and zero streaming renderer long tasks. It ran while native UI verification was active, on the M5 Max with load averages about 20–21. This is one cold-open observation with warm repeats, not the approved five-fresh-launch median protocol or a claim of performance-budget acceptance.


## Capture recovery and visual inspection

After creating the missing output directory, the unchanged second capture run passed **14/14** in 48.6 seconds. All 33 expected PNG filenames, dimensions and SHA-256 values passed the candidate manifest check. The complete set and manifest are in `docs/screenshots/conversation-fidelity/2026-10-22-ec7be57/`; first-failure artifacts remain separate. The measurement spec passed **2/2** in 6.7 seconds.

Agent visual inspection sampled waiting/Graphite/900×600, completed/Jev/1440×900 and typed-turn/OpenCoven/900×600. Approval actions fit, the completed transcript and file diff are present, and superseded/denied typed outcomes remain distinct. No blank capture or obvious clipping was observed in those samples. This is sampled agent inspection, not pixel parity, exhaustive visual acceptance or Val's human report.

A candidate-bound live Claude golden-path attempt is now running with the existing adapter, Claude's Sonnet alias, and unchanged required plan/edit/check/Notes/restart/Stop assertions. Its log/report/artifacts use this candidate's evidence directory; no result is yet claimed.

## iPhone terminal result

The explicit iOS 27.0 script exited 0 at 22:18:59 UTC: CompanionFlowTests **23/23**, DemoWorkspaceTests **20/20**, combined **43/43 with zero failures**, in 251.588 seconds of selected tests. Xcode reported `TEST EXECUTE SUCCEEDED`; its xcresult bundle is copied outside the worktree beside the original logs. The default iOS 26.5 destination failure remains recorded separately. This establishes simulator execution of both requested classes, not physical-iPhone or human acceptance.


## Live Claude result and human handoff

The candidate-bound [Claude report](2026-10-22-cf8-ec7be57-live-claude.json) records CLI **2.1.309**, requested model alias **sonnet**, two approvals, a real file edit and successful grep check, Notes save/open, identical transcript and Note after restart, and Stop in **814 ms**, outcome `interrupted`, exact notice “Stopped.” and zero failure notices. The probe's delayed-file check passed after 31 seconds. The model also ran sed for the edit and `echo $?`; this is not a claim that it followed the requested shell-command restriction exactly. The resolved model revision was not captured in the report.

The required structured-plan assertion was the sole reported test failure: zero plan items and ToolSearch output “No matching deferred tools found.” Overall exit is 1, not a golden-path pass. No plan requirement was removed, and no deferral has been received.

The old seeded review process was stopped and the rebuilt candidate relaunched using `MODEX_HOME=/tmp/modex-cf8-ec7be57-voiceover/home pnpm exec electron .`. Native UI inspection confirmed the candidate renderer path, that exact review-repo path, No threads, Message, Read only and Scripted mock. No checklist steps were performed on Val's behalf. Val was asked for exact A1–A8/B1–B7 results or named deferrals; the question's delivery acknowledgement is not an answer. Native-question D/V/P rows remain separate human/live gates.


## Completion audit, 22:20 UTC

Remote main still equals this candidate. Ownership, disk preflight, first command attempts and results, separate fixture/live/human matrix, screenshot evidence, status update and seeded review launch are recorded. All automated runner handles are terminal; the remaining seeded review app is an awaiting-human surface, not an automated acceptance run.

Completion remains unproven: the October 25 09:35 Codex golden path and Stop have not run; Val has not supplied a keyboard/VoiceOver report or written deferrals; live Claude emitted no required structured plan; and #277/#280 decisions/integrations and native-question human acceptance remain open. Current issue checkpoints contain no new decision resolving those rows. Recheck main before acceptance and repin if relevant code lands. The prepared dated runner is `apps/desktop/.probes/run-codex-after-reset-ec7be57.py` and refuses premature execution or main/source drift.

Signed delivery remains unavailable: `gpg` is still absent following the previously recorded signed-commit failure. No unsigned substitute, push, PR, merge, closure, tag or release was performed. The owned worktree stays retained. A complete current staged patch, documentation archive and probe copies are saved outside the worktree for recovery; earlier candidate archives remain unchanged.
