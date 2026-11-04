# Local Models v1 workflow candidate

Status: implementation and qualification in progress. This is not product admission, a compatibility pass, a rendered Electron acceptance result, a merge or a release. The full user goal remains open.

## Ownership and source

Base: live GitHub `main` and local `origin/main` at `49ff1e1d214b50adff54799e148669a147f96f7e`. Work is isolated in the newly claimed `lm-v1-workflow` worktree. The primary checkout's unrelated untracked files were preserved. GitHub CLI reads failed to connect; the read-only GitHub connector confirmed main and the three open PRs (#475, #486 and #489).

Committed producer changes were integrated into this branch from `lm5-fixtures-rebased` (`7a38090`) and `lm-ready` (`01101cb`). The admission change from `lm5-admission` (`1276a29`) was inspected and deliberately remains unapplied while its native gates fail. No producer branch, PR or worktree was changed.

Val explicitly authorized integrating snapshots of the separately claimed, dirty `local-model-e2e` and `lmstudio-support` worktrees, leaving their branches and checkouts untouched. Frozen manifests, patches and file hashes are retained outside the worktree at `/Users/buns/.codex/task-evidence/modex-lm-v1-2026-11-04/snapshots/`. Snapshot patch SHA-256 values are `61ee3b39c960d368e3f807cac9cf35fc1c4cc627bf6b78ab801d58afe10a269d` and `7e4aa9eee838a76125662f9fcf287bcdbfd558692f66845b53b0f5f23da9f228`, respectively. The former adds main-owned pending/Retry destination binding and recovery; the latter supplies the starting UI. Integration preserves newer main's Claude account-pool and Code Review changes.

## User-authorized scope and identity

The goal requires exact local connection/model identity, main-owned credentials and isolated native configuration; phone/paired sends are refused and returning to cloud names the destination model in a confirmation. Product execution stays disabled until admission decisions and a real-model smoke pass. Val separately approved downloading `qwen3-coder:30b` (about 19 GB) and local qualification runs. This authorization does not authorize merge, activation or publication.

| Field | Observed value | Meaning |
| --- | --- | --- |
| Host | Apple M5 Max, arm64, 128 GiB; macOS kernel 27.2.0 | This host only |
| Ollama | 0.40.14 | Installed runtime, not coding qualification |
| Codex | 0.166.0 | Native configuration read currently fails |
| Model | `qwen3-coder:30b`, 30.5B, GGUF Q4_K_M | Download completed after explicit approval |
| Digest | `06c1097efce0431c2045fe7b2e5108366e43bee1b4603a7aded8f21689e90bca` | Listed installed model identity |
| Listed bytes | 18,556,700,761 | Stored model size; loaded size remains unknown |
| Context | 65,536 requested; 262,144 advertised by model metadata | Effective loaded context is unverified |
| Support decision | Unverified | No generative turn passed |

## Requirement audit

| Requirement | Current evidence | Status / next proof |
| --- | --- | --- |
| Refresh source, producers, open PRs and ownership; isolate work | Live connector reads, ownership records, new claimed worktree and frozen manifests | Implemented; refresh before delivery |
| Reconcile three producer branches without taking them over | Producer patches on this branch; admission inspected and held | Source integrated; other branches unchanged |
| Settings connection management, metadata, model/context selection | UI source; production store/service tests; two metadata UI journeys | Rendered Electron run blocked |
| Revision identity and stale configuration | Main validation, snapshot destination binding, fixture tests and revision-aware renderer state | Main/fixture checks; UI row unverified |
| Saved credentials stay in main; native isolation | Imported token/global-configuration regressions and streaming redaction | Focused tests pass; real runtime qualification open |
| Paired-client send refusal | Main constructs the caller identity; runner guards send and Retry before transcript mutation | Regression reproduced before fix; focused test passes |
| Cloud return confirmation and exact selected model | UI confirmation; runner honors named cloud model; original Retry stays bound | Runner test; rendered confirmation unverified |
| Live read, approved edit and independent test | Extended opt-in native smoke plus a negative control of the independent check | Native run fails before inference |
| Electron golden journey with diff, Stop, continuation, restart, stale profile and server failure | Four listed journeys in two files, with a temporary-home-only bootstrap and shared scripted app-server | First launch aborts; no UI assertion ran |
| Scripted workflow genuinely edits, checks and stops work | Shared native-transport fixture crosses approval, runs Node check, kills its delayed child, continues, fails and refuses a lost handle | Node integration test passes; not Electron or model evidence |
| Normal CI stays offline and GPU-free | Native tests opt in; Electron bootstrap uses FakeProcess and a loopback metadata fixture | No model download/inference in ordinary CI |
| Product execution stays disabled | Existing production wiring regression and no `LocalExecution` construction in main | Retained |
| Network-denied evidence covers client and inference server | Offline harness denies external TCP, starts its own loopback Ollama and executes native smoke under the same inherited sandbox | External denial `EPERM`; native smoke fails; offline inference unverified |
| Signed review-ready commits and fresh build/test/E2E | Signed implementation checkpoint `047c3ad`; pinned results below | Signed checkpoint exists; acceptance/review readiness remains open |
| Reproducible setup, rollback and compatibility receipt | `docs/local-models.md`, opt-in launchers and the identity table above | Candidate instructions; supported compatibility not established |
| Human acceptance | No person-run keyboard, screen-reader or task-quality result | Open; never inferred from fixtures |
| Merge, activation and publication boundaries | No push, merge, default activation, tag or release performed | Separate authorization retained |

## First failures and validation

The first foundation build passed. Its focused execution, run-policy, global-configuration, token-record and local-runner suites passed 53/53. The new remote-send regression then failed with “Missing expected rejection” before its guard. The integrated runner/draft/recovery run initially found two producer-test integration conflicts: a stale Retry now refuses earlier at destination binding, and an old test omitted the required desktop caller for clearing a target. The revised checks assert the stronger pre-admission refusal and explicit caller. That focused run passed 71 with one platform skip.

The first whole-tree build and typecheck passed. The full unit command passed the worktree suite (147) and core (16), then failed the desktop suite: 2,144 passed, 29 skipped, two failed. Both failures are unchanged Notes watched-read cases, “reads settle” and “reads settle on the last look.” A separate fresh recursive watcher reported `EMFILE: too many open files, watch`. No watcher assertion, timeout, system limit or unrelated process was changed. Later checks must retain this first result and cannot call the root command green.

The shared scripted-workflow integration passed approval, actual file edit and independent test, stopping an actual delayed Node child, explicit continuation, server failure and lost-session refusal. Together with local execution/runner/native-harness checks that focused run reported 37 passed and 12 intentional native skips. A TypeScript readonly-array error in the new shared fixture was corrected before this run; it is preserved in the external build log.

The installed CLI wire check and approved real-model smoke both fail at `config/read`, RPC `-32603`: “failed to read configuration layers: Failed to synchronize managed preferences.” The wire receipt records zero Responses requests and no tools. A private-home configuration-only probe reproduced the same error with and without `USER`/`LOGNAME`; no requirement or managed layer was disabled. A separate OS username query failed with `uv_os_get_passwd` / `ENOENT`; its relationship to Codex's error is unproven. The real model's quality and compatibility remain unknown.

The offline canary proved external TCP denial (`EPERM`), then started a separate owned Ollama on `127.0.0.1:58132`. Its native task failed at the same effective-configuration read. The owned server exited during cleanup; the person's primary Ollama was preserved. This is boundary/startup evidence and a failed coding canary, not offline inference acceptance.

The development Electron executable aborted with `SIGABRT` even for `--version`. Its original signature verification failed; a private copied bundle was ad-hoc signed and passed verification, but still aborted. The targeted Electron command selected four tests and stopped after its first launch failure: one failed, three did not run, no renderer assertion executed. The trace and original logs are outside Playwright's wiped output directory. The underlying launch cause remains unproven; no application assertion or production admission gate was bypassed.

## Outstanding work

Repair the native/OS configuration and Electron launch prerequisites, then run the real read/edit/test smoke and Electron journeys on the final pinned candidate. Complete the fresh required build, typecheck, unit and full desktop/site E2E gates, retaining original failures and skips. Fix any product defect those runs reveal. Qualify the exact configuration's Stop/recovery/failure and network-denied inference behavior, then obtain the outstanding human/admission results before a separately authorized activation. The goal remains active until its full audit passes.

## Pinned implementation checkpoint

Signed commit `047c3ad1009aae658ec221f2f25ef8bc52484df2` has tree `1c85eaa0a028ae5105483d699bd61c2e56f6bdb4`. The following runs name that implementation revision. The later receipt update changes documentation only and does not claim another whole-tree test pass.

| Check | Result at the implementation checkpoint |
| --- | --- |
| `pnpm build` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | Failed: worktree 147 passed; core 16 passed; desktop 2,147 passed, 29 skipped, two unchanged Notes watcher failures |
| Final focused integration run before committing the same code | 98 passed, 13 skipped, zero failed |
| Remaining native/browser script suites, run separately after the root stop | 21 passed, six skipped; these do not make the root command green |
| Site and Store unit suites, run separately | 10 passed and 16 passed |
| Targeted Electron journeys | One launch failure (`SIGABRT`), three did not run; no rendered assertion executed |
| Site E2E, run separately | Seven failed at Chromium startup (`SIGTRAP`); no site source changed |
| Approved native model smoke | Failed at effective configuration, before inference; real user's config fingerprint unchanged |
| Network-denied native canary | External TCP refused with `EPERM`; owned Ollama started, native configuration failed, owned server stopped; offline inference remains unverified |

Standard OpenSSH signing and verification fail this session's OS username lookup with “No user exists for uid 501.” The installed 1Password signer successfully signed the checkpoint using the exact public key found on the producer commit. A separate Node Ed25519 verifier follows the OpenSSH SSHSIG format, verifies namespace `git`, SHA-512 payload and the matching producer key, and rejects a one-byte change to the signed data. Its script and receipt are preserved externally. This establishes the local signature, not GitHub checks or protected delivery.

Evidence home: `/Users/buns/.codex/task-evidence/modex-lm-v1-2026-11-04/`. It contains the frozen source snapshots, original and pinned logs, both Electron failure traces, site browser traces, model/version inventory, signature verifier/receipt, native real-config fingerprint receipt, initial and pinned offline receipts, and an evidence SHA-256 manifest. No push, PR mutation, merge, activation, tag or release occurred. The worktree stays claimed for this active goal.

## Follow-up review: metadata response ordering and receipt preservation

Revalidation after `d99687d` still found native `config/read` failing on managed-preferences synchronization, OS username lookup failing with `ENOENT`, and the private signed Electron copy aborting for `--version`. These are unchanged blockers; no native or rendered gate passed.

Source review found independent renderer defects that could be fixed in this session. A profile-list reply started before an acknowledged create, edit or removal could replace the newer state. A failed Cancel acknowledgement could leave the view permanently checking, and a late successful Cancel acknowledgement could overwrite a newer completed discovery. Five deferred-transport regressions reproduced those cases before repair. The window metadata store now fences list responses by mutation generation and discovery/cancel responses by operation identity, publishes acknowledged profile changes immediately, and exposes uncertain cancellation as a window-operation error while keeping Refresh available. It was separated from React only so the actual state transitions can be exercised without a working Electron launcher; the renderer facade still owns one shared store and invokes the same main channel.

The offline launcher also accepted a populated evidence directory or a final symlink before contacting a runtime. Two negative controls, with network access replaced by a throwing fixture, demonstrated that the original launcher reached metadata lookup before checking either condition. The launcher now refuses both before any runtime request, retaining the earlier receipt and linked target unchanged. Each qualification run needs a new empty evidence directory.

All seven new regressions pass after their observed failures. The expanded focused store/execution/runner/token suites passed 48/48, and the whole build and typecheck passed. These are source and state-machine results, not rendered acceptance or native inference evidence. The next signed checkpoint and its canonical results are recorded separately; earlier pinned results above remain historical.

Signed follow-up implementation checkpoint: `bdd5dd2230687e166f2345818a547672c5c9bf58`. The matching producer key and Ed25519 signature were verified, including a changed-message negative control. Fresh `pnpm build` and `pnpm typecheck` passed on this revision. Fresh `pnpm test` failed only the same two unchanged Notes watcher cases: worktree 147 passed, core 16 passed, desktop 2,154 passed and 29 skipped. Every new regression passed in that whole-tree run. The targeted four Electron journeys again failed at the first process launch (`SIGABRT`); three did not run and no rendered assertion executed. Native and human acceptance remain open, and production execution stays disabled. The subsequent receipt-only commit changes no implementation source.
