# Closeout integration qualification — 2026-11-11

The executable candidate is signed commit `7d6094e9ffc501b8d99f673cc2e9604b5c7bf5fe`, tree `f997226f508c9ad778ba38db0bbcdf08299e3375`, based on main `d7650e4c54cdd15e4ee4f14b9f4dec3455ba1e77`. It integrates the complete local-model implementation history through `ff99bbab0d15f43e737ead5cde2c1497b22e8890`, preserving later main conversation-fidelity changes. Subsequent memory-test and documentation changes do not change this executable candidate. Qualification, product admission, hosted CI, protected delivery, release and human acceptance remain separate.

## Repairs and executed gates

Packaged main selects the OS cipher even when `MODEX_E2E` is inherited; only unpackaged E2E uses the reversible fixture cipher. Ordinary secrets and app-owned authentication share that main-owned cipher. Main-assembly regressions cover packaged fixture flags, unavailable OS encryption and unpackaged controls. The follow-up button's accessible name includes its proposed text. Independent reviews found no findings in the original integration or six-file repair delta; unrun native and human gates were excluded.

The host was Apple M5 Max, 18 cores, 128 GiB, macOS 27.2.0 arm64, Node 24.22.0, pnpm 10.34.5 and Electron 44.4.5. The initial Ollama preflight observed 0.40.15; actual native stages ran 0.40.16 with fresh binary identities. These are distinct runtime observations.

| Gate on the executable candidate | Result and limits |
| --- | --- |
| `pnpm build`, `pnpm typecheck` | Passed |
| `pnpm test` | 2,407 passed, 35 skipped, zero failures |
| Focused Local Models Electron journeys | Four passed, no skips or retries; scripted transport |
| `pnpm test:e2e` | 508 desktop passed, 11 opt-in skips; seven site passed; zero failures |
| Separate CI Open Knowledge opt-in | Three Electron cases and one pinned-runtime unit passed; synthetic coding CLI, real pinned companion runtime |
| Native Code Review confinement | Six passed on Claude Code 2.1.322 and Codex 0.167.0; scripted loopback provider and synthetic credentials |
| Network-denied real local read/edit/check | Passed on Codex 0.167.0, Ollama 0.40.16 and the approved model digest; personal configuration unchanged |
| Real-model Electron lifecycle | Four passed: read/edit/check/rendered diff, Stop, Codex loss and server loss; zero recorded cloud calls, owned service stopped, personal configuration unchanged |
| Packaged credential storage | Not accepted: first Settings click timed out while main waited in `SecItemCopyMatching`; teardown also timed out. Native Keychain interaction needs the person |

The approved `qwen3-coder:30b` digest was `06c1097efce0431c2045fe7b2e5108366e43bee1b4603a7aded8f21689e90bca`, verified by the offline service before and after inference. Its kernel profile denied external TCP and outside-file writes with `EPERM` and applied to the owned model service and Codex descendants. The server log records `n_ctx = 65536`; the ordinary Electron golden receipt independently reports 65,536 loaded context tokens. The ordinary Electron run makes no offline claim. These narrow workflows do not qualify compaction, overflow/OOM, managed policy, other runtimes or product activation.

The original offline attempt failed before inference because its workspace was beneath home and the existing ancestor `.codex` refusal applied. A separate retry moved only that gate's workspace to private system temp. Policy, assertions and product source stayed unchanged. Both attempts remain retained, and the original `qualification.json` remains failed. Passing unchanged-source build/unit/E2E stages and the separately bound native retry form the composite evidence.

## Memory and output observations

The [same-host comparison](2026-11-11-closeout-qualification/memory-comparison.json) uses pre-CF source `89c98f280292b13fd9b1c7af1bf2fe65cd2fa0d1` and the executable candidate. All 724 original baseline blobs matched Git after building; core source was identical. Installed pinned dependencies were reused, with later Markdown-parser additions documented. Five fresh processes per source each opened the saved 200-turn transcript five times; the log workload streamed 3 MiB in 48 deltas. Native main private memory, actual renderer PIDs and per-process working sets were observed; shared memory is not summed.

| Observation | Pre-CF baseline | Candidate |
| --- | ---: | ---: |
| Cold-open median, ms | 61.7 | 82.6 |
| Main private KiB before → after transcript, median of five processes | 72,577 → 79,889 | 76,257 → 82,161 |
| Renderer working-set KiB before → after transcript, median of five processes | 134,576 → 321,680 | 133,712 → 350,080 |
| Main private KiB before → after log stream, one process | 71,521 → 145,617 | 74,785 → 151,377 |
| Renderer working-set KiB before → after log stream, one process | 134,816 → 160,704 | 134,656 → 157,328 |
| Stream bytes sent to the window | 80,224,695 | 664,016 |
| Largest output payload, bytes | 3,145,728 | 262,144 |

The unchanged 500 ms cold-open gate passed; complete E2E separately observed an 81.7 ms median. Candidate output passed the existing 256 KiB bound; the historical baseline failed that new bound as the negative control. Memory observations establish neither a strict ceiling nor leak freedom or lower use: transcript renderer working set was higher and main log-stream growth was similar. No memory budget was invented. Process-lifetime peak working set is not an operation high-water measurement.

The first memory collection accidentally included the nested baseline export: three passes and one historical output-bound failure across four cases. Both candidate cases passed, and their final measurement matches their logged samples. The baseline worker's incorrect parent-worktree source label was retained as a setup error and excluded. A separate baseline run used its correct explicit source identity, producing one cold-open pass and the expected output-bound failure. The canonical memory probe now retains these counters for future runs; its focused verification is recorded separately from the original full suite.

The canonical `e2e/transcript-measure.spec.ts` with memory instrumentation passed both cases with no skips; its five fresh-process cold-open samples had a 76.4 ms median against the unchanged 500 ms gate. This verified the test/documentation increment, not a second full-suite run. A hash audit of 788 previously tracked app/package/script/workflow inputs found only this measurement spec changed; all executable inputs remained equal to the qualified candidate.

## Historical evidence and remaining gates

The [October 22 CF-8 review](2026-10-22-cf8-integrated-candidate.md)'s missing [capture manifest](../screenshots/conversation-fidelity/2026-10-22-candidate/manifest.json) is restored at its original path. The original owner authorized copying its 33 PNGs and manifest while retaining their claimed worktree. All hashes and dimensions matched. Privacy review used whole-set local OCR, PNG text-metadata inspection and six visual samples; only scripted content and disposable temporary paths were found. These remain `0e674e7` fixture captures, not current-candidate captures, live-provider evidence, independent original references or human acceptance.

Production still does not construct `LocalExecution`; Code Review's default is unchanged. The ad-hoc packaged app passed signature-integrity verification and its ASAR main matches the executable candidate. It is not a notarized release or installed-app acceptance. Computer use refused SecurityAgent access; no Keychain prompt was bypassed or approved. A coordinated person-run retry remains pending.

PR #497 remains unmerged after its second queue attempt: Store Settings recovery passed its functional assertions, then stalled in `client.close()` during `finally`; worker teardown timed out and the job reached its 45-minute limit. The [failure report](https://github.com/TypeSafeAI/modex/pull/497#issuecomment-6793802530), first queue failure and traces remain separate. These passing local integration checks do not justify another unchanged requeue. PR #496's no-reset context evidence and PR #475's replacement scope require actual protected delivery before reconciliation. Product decisions, physical-phone/two-subnet procedures, human accessibility, live Code Review and named-disposable-repository writes, platform and release gates remain open.
