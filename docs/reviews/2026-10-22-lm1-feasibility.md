# LM-1 feasibility checkpoint — 2026-10-22

Issue: #377 under #376. Owner: Codex session `01a165f8-e270-7c50-8a82-fc2212df7a88`, branch/worktree `lm1-contract`, created and claimed with `scripts/worktree.sh new lm1-contract --no-install`; `scripts/worktree.sh check` passed. Base and pre-commit HEAD: `ec7be578765f9ce54976882853e57ca190252361`. GitHub main matched this SHA via `git ls-remote origin refs/heads/main`. Primary checkout was clean and unchanged. Open PRs #370, #371, #372, #374 and #375 were inspected; a final refresh also inspected newly opened #385 and its backend diff; none implements LM, but account/native-plan seams remain shared integration concerns. No prior LM-1 goal-turn work was available to classify; this turn makes new implementation and native evidence progress.

## Changes and acceptance boundaries

Added `apps/desktop/src/shared/local-models.ts`, seven contract tests, `docs/local-models.md` and an in-flight status entry. Contracts separate harness/connection/model/credential reference/run provenance; metadata and tested capability are independent. Unknown tested versions or changed configuration invalidate support. Legacy fixtures preserve account/model/resume semantics and malformed additive local targets fail closed. These are proposed interfaces, not a production local executor or completed migration.

| Criterion | Current evidence | Remaining gate |
| --- | --- | --- |
| AC1 | Seven contract tests include duplicate-name/revision separation and pure legacy migration fixtures. | Review contract; actual Store/IPC adoption belongs to LM-3/LM-4. |
| AC2 | Installed schema captured; real app-server initialized and selected an unlisted arbitrary model with fallback disabled. | Real Strata tool/Stop/continuation passed; inspect the native summary. Gate A still awaits contract/evidence review. |
| AC3 | Additive contracts/tests/docs only; existing native execution unchanged. | Review; no brand allowlist, direct inference client or tool executor added. |
| AC4 | Tests distinguish metadata, per-capability observations, unknown versions and conflicting results. | Real qualification receipt and review. |
| AC5 | Source/interface/account/safety map in `docs/local-models.md`. | Consumer review and exact native runtime findings. |

## Commands and results

- `pnpm install --offline --frozen-lockfile`: passed, pnpm 10.34.5; 510 packages added from cache, zero downloads.
- Red: `pnpm --filter @modex/core build && pnpm --filter @modex/desktop build:main`: core passed, desktop exited 2 with TS2307 for missing `local-models.js`.
- First implementation compile: exited 2, TS2532 on unchecked `matching[0]`; repaired. The additive-target test then produced TS2353 for missing `localTarget` support; repaired. These attempts are not green claims.
- Green: `pnpm --filter @modex/desktop build:main && node --test apps/desktop/dist/test/local-model-contract.test.js`: passed, six tests, zero failures/skips.
- `pnpm build`: passed; Vite chunk-size warnings remain.
- `pnpm test`: passed (exit 0): worktree 117/117, core 16/16, desktop 1,817 passed with 16 skips, native/package checks 21/21, site 10/10, Store desktop 16/16. Total 1,997 passed, 16 skipped, zero failures/cancellations.
- `pnpm typecheck`: passed (exit 0) across the workspace.
- `git diff --check`: passed before receipt creation; rerun before commit.
- UI E2E: not run; no UI changes. Native/runtime results do not establish Electron, companion, human or network-denied acceptance.

Node v24.22.0; pnpm 10.34.5; macOS 26.7.1 arm64, Mac17,6, 128 GiB RAM; Codex CLI 0.163.0. Initial signing discovery found no GPG executable or configured key. The user subsequently loaded the existing SSH identity `/Users/buns/.ssh/id_ed25519`; `ssh-add -l` and its public key both identify fingerprint `SHA256:YprOIgLzN6V1HRC23ZBFfarWcT8LC3y45AMN4QDe9rs`. Delivery uses per-command SSH signing configuration, with no global configuration changes.

## Native schema and selection evidence

`codex app-server generate-json-schema --experimental --out apps/desktop/.probes/lm1/schema` passed. SHA-256: `ThreadStartParams.json` = `80a40a7fac15b4bf70efb7f893fb353acc0a0d30c68f54aee4f01923deca85de`; `TurnStartParams.json` = `abf0d6d29d223b38c650ff1155cb9c9f9b4211e6d0e20c57d750a9e1babfdb41`.

Reproducer: [schema-probe.py](2026-10-22-lm1/schema-probe.py). It creates disposable HOME/CODEX_HOME and fixture directories, initializes real app-server, requests `model/list`, then `thread/start` with `modelProvider=lm1_probe`, `model=lm1-unlisted/Exact-ID:Q4`, `allowProviderModelFallback=false`, read-only sandbox and ephemeral history. Child provider URL is intentionally unavailable loopback port 1, Responses wire, OpenAI auth and websocket support disabled, web search disabled. No inference is attempted. Native catalogue contained eight entries and did not contain the requested ID; returned model/provider exactly matched the request. This proves selection without a custom catalogue, not coding compatibility.

## Installed Strata target

The user directed the probe to use what Strata uses. Strata desktop 0.2.2 ships engine 0.1.47, source `f-022-rel 76f90e58436d`, Metal. Saved installed configuration is `/Users/buns/.local/share/strata/install/strata-iq3_s.json`; model ID is `qwen3.8-flash-next-iq3_s`. Existing GGUF shards under `~/Documents/Strata/Models/IQ3_S/` are `Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-00001-of-00002.gguf` and `...00002-of-00002.gguf`; tokenizer is the installed `packs/iq3_s/tokenizer`, and MTP is the installed `mtp/rt`. No weights or runtime downloads were performed. The saved app profile pointed to a missing transient native-instance file; the persistent installed configuration was used instead.

Probe instance uses the bundled Python/control server, bundled engine executable, existing arguments with effective `--max-context 32768`, text-only (vision omitted), isolated log/config/ready paths and loopback port 18501. `--offline --no-api-key` is child-scoped on this disposable loopback instance. It does not modify Strata's saved authentication/settings and does not constitute network-denied proof. An initial launch from the wrong working directory failed with `ModuleNotFoundError: serve`; launching from the bundled control directory succeeded. Initialization took over a minute; the confirmed live process was polled, not restarted on observation timeout.

Strata implements Responses natively in its installed inference service; no Modex protocol proxy was added. Runtime Responses adapter SHA-256 `5215aafab91eea1b77b4c81a1405731cd175fcbdcc9b0e56aa64db701a7100f4`; chat template SHA-256 `12827f24b742ea4e80cdc12dbcf9622227056b9f797252a3149263d4f9aaadce`. Exact SHA-256 hashes of both model shards, tokenizer, MTP weights, engine binary, tool parser/frontend, server, Responses adapter, template and expert profile are in [runtime-sha256.txt](2026-10-22-lm1/runtime-sha256.txt). These identify this tested combination; they do not qualify other versions.

The [native probe](2026-10-22-lm1/native-probe.mjs) is copied into `apps/desktop/.probes/lm1/` before running so generated events/receipts remain ignored. It uses real app-server and native shell tools against a disposable sentinel. It requests a read, starts `sleep 30`, interrupts after observing its owned OS sleep child, lists/terminates owned background terminals and continues with a new read only after safe settlement. It declines additional authority. It records real protocol events; it does not emulate model output or run its own tool executor. Attempt 3 passed with observed native command results and background-terminal cleanup; see the summary.

## Next step

Review the signed LM-1 contract and native receipts before accepting Gate A or starting dependent execution work. Local implementation and native verification are complete; the reviewer must preserve the explicit unsupported/unverified capability boundaries. No merge, release, publication, global configuration change or model download is authorized by this checkpoint.

## Native probe corrections

Attempt 1 reached the real model but its diagnostic harness declined all native approvals, including `cat ./sentinel.txt`. The model reported it could not read; no successful tool result was claimed. Attempt 2 limited approvals to exact fixture reads and the authorized Stop-marker command. The read succeeded with exit 0 and `LM1_TOOL_SENTINEL_829173`; the Stop trigger did not fire because the native command item buffered output until the 30-second command finished. Its completed turn is not cancellation evidence. Both failures and their raw events are preserved outside tracked prose.

Attempt 3 observes a `sleep` process descended from its own app-server before sending `turn/interrupt`, checks native background terminals and the owned OS process tree before continuing, and retains the exact-command approval restriction. It changes only probe instrumentation, not runtime/native policy. No uncertain request is replayed; each diagnostic attempt uses a fresh disposable native thread and fixture.

## Native result (attempt 3)

Real app-server with Strata completed read → interrupted Stop → completed continuation. Both read commands exited 0 and returned `LM1_TOOL_SENTINEL_829173`. Before interrupt, the probe observed an owned running OS sleep process. After `turn/interrupt`, Codex still listed that command as a background terminal; explicit `thread/backgroundTerminals/terminate` removed it. The next terminal list was empty and the owned sleep process was gone before continuation. The fixture contained only its original sentinel file. This supports retaining Modex's existing `endTerminals` path; interruption alone is insufficient. [Filtered native command/turn receipt](2026-10-22-lm1/native-summary.json) excludes model reasoning and private payloads.

The CLI warned that the arbitrary model was absent from native metadata and used fallback metadata. Actual tool execution worked without a custom catalogue, but this is not proof that inferred context/image/reasoning metadata is correct. Effective context was explicitly 32768. Continuation was on the same native thread; fresh-process `thread/resume` remains unqualified. No images, structured-output task, Claude route, Electron/companion UI or network-denied qualification was tested.

The owned first Strata instance was stopped cleanly (session 6940, exit 0) after native evidence collection. A separate diagnostic rerun enables Strata's existing API monitor to capture actual Responses request/response shapes; it does not add a proxy or edit provider code. The diagnostic rerun also passed all three stages; the second server stopped cleanly (session 24608, exit 0).

## Wire evidence and remaining boundaries

The monitor recorded five actual `POST /v1/responses` requests with `stream: true`, `store: false`, native function tools, reasoning settings and exact model selection. Subsequent requests replayed `function_call`, `function_call_output`, message and reasoning items. The [deduplicated wire shapes](2026-10-22-lm1/wire-shapes.json) preserve field/type names without prompt bodies. The monitor does not retain raw SSE response frames; this is not a byte-for-byte streamed-wire capture. Native command/turn response objects are retained separately. No Chat Completions route was used by the probe.

Gate A is implemented with real native evidence, awaiting review; this is not broad-runtime, UI, account-isolation, offline or quality qualification. Product routes remain unchanged. Downstream LM-2/LM-3 must not treat these proposed contracts as accepted until review. Signed commit creation and signature verification follow final evidence assembly; contract/evidence acceptance remains a review gate.

## Evidence preservation

Raw schema, native events, per-attempt diagnostics, generated configuration and check logs are preserved outside the worktree under `/Users/buns/Documents/Codex/artifacts/modex-lm1/2026-10-22/`. Raw diagnostic payloads are not part of the commit. Each runtime used only pre-existing model/runtime files, child-scoped configuration and disposable data. Both inference-server sessions and all app-server probes are terminal; no background execution is claimed. The native fixture remains unchanged except for its original sentinel file.

The final remote-main check still returned `ec7be578765f9ce54976882853e57ca190252361`. No push, PR publication, merge, release, global configuration change or model download was performed. The branch and worktree are retained for review; ownership is released at the final signed HEAD after evidence preservation. Final full commit SHA, staged-tree identity and signature verification are recorded in the external `checkpoint.txt` to avoid a self-referential commit hash in this file.

## Final contract audit correction

A final audit found that a settings revision alone did not snapshot the actual effective settings. Added `EffectiveLocalSettings` to qualification/run configuration and a seventh regression covering provider, reasoning effort/summary, service tier, approval policy, sandbox, network, writable roots and toolset changes with the revision held constant. The regression first failed with actual `supported` versus expected `unknown`; the configuration key now binds those values explicitly. This changes only the contract and invalidation helper, not the already-probed native execution path. Final targeted tests passed 7/7. `pnpm build && pnpm test` passed again: worktree 117/117, core 16/16, desktop 1,818 passed with 16 skips, native/package checks 21/21, site 10/10 and Store desktop 16/16: total 1,998 passed, 16 skipped, zero failures/cancellations. Final `pnpm typecheck` also passed (exit 0). Final `git diff --check` and diagnostic-script syntax checks passed.

## Concurrent native-plan integration

PR #385 opened during this work. Its reviewed diff adds a per-thread reported-model cache and sends the explicitly selected model/effort inside `collaborationMode.settings`; that nested model takes precedence over the turn-level field. LM-1 does not modify that backend, and current main remains the recorded base. LM-3 must bind both model locations to the exact pinned local target, include collaboration settings in its configuration revision and preserve provider/process isolation. Missing selection must be unavailable for a local run, never a cloud/default-model fallback. The present native qualification covers ordinary turns, not native Plan mode.

## Codex 0.164.0 refresh, 2026-10-23

Under the contract's own rule, a native-CLI change invalidates qualification. The installed CLI moved
from 0.163.0 to `codex-cli 0.164.0` (`/opt/homebrew/bin/codex`), so the receipt above no longer
qualified the installed combination. This session claimed the released `lm1-contract` worktree and
rebased the commit onto `main` at `203a3505bfa46b67ea4cb47254ece26ac0f2da88`. The only conflict was
in `docs/status.md`, where both entries were kept. The contract and tests are unchanged. The same
probes were then rerun with nothing else changed.

**Runtime identity.** `shasum -a 256 -c` against [runtime-sha256.txt](2026-10-22-lm1/runtime-sha256.txt)
passed for all ten files: both model shards, tokenizer, engine binary, MTP weights, frontend, server,
expert profile, Responses adapter and chat template. Strata desktop is still 0.2.2 with engine 0.1.47.
The probe instance reused the earlier child-scoped configuration (loopback 18501, `--max-context
32768`, vision omitted, `--offline --no-api-key`), with only its log path moved to
`apps/desktop/.probes/lm1-0164/`. Nothing was downloaded. Saved Strata settings were not touched.

**Schema.** Generated with a disposable `HOME`/`CODEX_HOME`:

| File | 0.164.0 SHA-256 | Against 0.163.0 |
| --- | --- | --- |
| `v2/ThreadStartParams.json` | `80a40a7fac15b4bf70efb7f893fb353acc0a0d30c68f54aee4f01923deca85de` | Identical |
| `v2/TurnStartParams.json` | `f671d01c24995e99fcc110862ff3251c26d334fba212c7dc12857fb939506e47` | Was `abf0d6d2…`. Adds `responsesapiClientMetadataPatch` and changes `responsesapiClientMetadata`. Model, effort, collaboration mode, sandbox and approval fields are unchanged |
| `v2/ThreadResumeParams.json` | `8152ea774ace4eb5623081abd64a1135f28cbff1e73ca641cfb80ac16f6eed32` | Not hashed on 0.163.0 |

**Selection.** [schema-probe.py](2026-10-22-lm1/schema-probe.py) ran unchanged. The native catalogue
had eight entries without the requested ID. `thread/start` returned
`lm1-unlisted/Exact-ID:Q4` on provider `lm1_probe` exactly as requested, with fallback disabled and no
inference attempted ([result](2026-10-23-lm1-0164/schema-probe.json)).

**Tool, Stop and continuation.** [native-probe.mjs](2026-10-22-lm1/native-probe.mjs) ran unchanged and
passed on its first attempt. Initialize reported user agent `modex_lm1_probe/0.164.0`, and the thread
selected `qwen3.8-flash-next-iq3_s` on `lm1_strata`. The results:

- **Read:** `cat ./sentinel.txt` completed with exit 0 and returned `LM1_TOOL_SENTINEL_829173`.
- **Stop:** the probe saw an owned OS `sleep` (PID 38264) before sending `turn/interrupt`, and the
  turn ended `interrupted`.
- **After Stop:** as on 0.163.0, the interrupted command was still listed as a background terminal
  (process 35739). An explicit `thread/backgroundTerminals/terminate` removed it. The list was then
  empty and no owned `sleep` remained.
- **Continuation:** on the same thread, the read completed again with exit 0 and the same sentinel.

[Filtered receipt](2026-10-23-lm1-0164/native-summary.json): command items and turn completions only,
no reasoning. Raw events, receipt, Strata logs, the schema and a SHA-256 manifest are preserved
outside the worktree under `/Users/buns/Documents/Codex/artifacts/modex-lm1/2026-10-23-cli-0.164.0/`.
The Strata instance was stopped after the run, and nothing was left listening on 18501.

This qualifies exactly codex-cli 0.164.0 with Strata 0.1.47 and the hashed files, at an effective
context of 32768, for ordinary turns. Every boundary listed above for 0.163.0 still applies.
