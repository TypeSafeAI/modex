# LM-1 acceptance and authorized runtime inventory — 2026-10-24

Issue #377 under #376. Owned worktree/branch: `lm1-native-approval`, created from main `bb0e1a42ac7bb3e11ccfee05a40d8a02f1dc10c4` with `scripts/worktree.sh new lm1-native-approval --no-install`; `scripts/worktree.sh check` passed. Primary checkout was not edited.

## Accepted decisions

[Gate A acceptance on #377](https://github.com/TypeSafeAI/modex/issues/377#issuecomment-6382280214) identifies the accepted producer at main `bb0e1a42ac7bb3e11ccfee05a40d8a02f1dc10c4`: original LM-1 #397 plus #400's shared identity/runtime reconciliation. The original implementation head was `cb7ca6c30a3aa68012187aaf508cc552c84445d3`; `git diff --exit-code` confirmed its contract and contract-test files are identical to this main. PR #400 merged as `bb0e1a4`, and every hosted check at `cb7ca6c` passed: required macOS unit/E2E, iPhone companion, coverage upload, and Windows/Linux native-platform jobs.

In this LM-1 task, Val subsequently approved the recommendations with “i approve with your recommendations please work to unblock.” The pending questions explicitly separated narrow Gate A, the AGENTS metadata proposal, and an installed-model probe. This records acceptance of narrow Gate A, approval of the metadata boundary and authorization for the probe. The original questions excluded merge authority; this record grants no authority to merge downstream PRs.

Accepted native scope remains exactly the [recorded Codex/Strata receipt](2026-10-22-lm1-feasibility.md): codex-cli 0.163.0, refreshed on 0.164.0, Strata engine 0.1.47, `qwen3.8-flash-next-iq3_s`, effective context 32768, loopback, fallback disabled, exact unlisted model selection, native sentinel read, interrupted command with owned-background-terminal cleanup, and same-thread continuation. Plan, fresh-process resume, account/profile isolation, edit/test, other runtimes, images, structured output, network-denied/offline operation and UI remain unqualified by that native probe.

## Approved metadata boundary

AGENTS.md now records the approved exception: main-owned, bounded reads from an explicitly configured loopback metadata endpoint, connection-specific credentials only, refusal of redirects/proxy routing/non-loopback destinations, and no prompts/files/cloud credentials. Metadata discovery does not perform inference, model downloads/load/unload or tool execution. Coding inference stays inside the native CLIs. Approval of this boundary does not itself enable a product route or qualify a model.

## Authorized inventory and explicit deferral

Commands were executed using the installed CLIs, with no model pulls or inference calls:

```sh
ollama --version
ollama list
/Users/buns/.lmstudio/bin/lms --version
/Users/buns/.lmstudio/bin/lms ls
/Users/buns/.lmstudio/bin/lms ls --json
/Users/buns/.lmstudio/bin/lms ps
/Users/buns/.lmstudio/bin/lms server status
codex --version
```

Ollama reports version 0.40.10 and an empty installed-model list. LM Studio's CLI reports commit `43d4b26`; its model list initially showed one local Nomic embedding model. After linked-device discovery settled, its inventory also showed two generative models and another embedding model on a linked device. The JSON `deviceIdentifier` distinguishes the one entry on this machine from those linked entries. Local host identity was checked independently and differs from the linked device. Device identifiers, hostnames and private paths are omitted from the [sanitized inventory](2026-10-24-lm1-approval/runtime-inventory.json). The HTTP server is not running and no model was loaded by this session. The CLI started its installed local model service while enumerating inventory; no coding turn was started.

The only model on this machine is `text-embedding-nomic-embed-text-v1.5`, which is not a generative coding target. Linked-device LLMs are outside local v1 scope; a loopback entry point would not establish local inference. The installed Codex CLI remains 0.164.0. LM Studio inference-runtime version, local coding-model identity and native Responses/tool compatibility remain unverified because no eligible local target exists.

After these results were presented, Val explicitly selected **“Defer until a local coding model exists.”** The additional Ollama/LM Studio app-server probe is therefore deferred by user decision, not claimed as passed or failed compatibility. No model was downloaded or imported, no direct inference client was used, and `~/.codex/config.toml` was not edited. The accepted Strata receipt remains separate. A future probe needs a pre-existing local generative target and a new exact configuration/runtime/model receipt; no model-brand allowlist is introduced.

## LM-2 handoff

LM-2 [#403](https://github.com/TypeSafeAI/modex/pull/403), head `2956c1a011fe3a54ed8839d87544056fbad0bd57`, applies the LM-1 consumer patch unchanged and imports/re-exports `ConnectionRef` and schema-1 `LocalModelRef` from `shared/local-models.ts`. Its `LocalRuntime` aliases `LocalMetadataRuntime`, and descriptors use `localModelRef`. It also aligns advertised capabilities with the shared capability vocabulary. The producer's acceptance gate is cleared; the consumer's review, stack order and landing remain owned by LM-2. No LM-2 worktree or branch was edited by this session.

The approved metadata policy is available for that handoff. This inventory is not a production LM-2 discovery/IPC acceptance run, and the probe deferral does not qualify Ollama or LM Studio coding execution. LM-3 may consume the accepted contract while retaining native isolation, account safety, both model-pin locations and its own implementation/acceptance gates.

## Fresh verification and delivery

On base `bb0e1a42ac7bb3e11ccfee05a40d8a02f1dc10c4`, `pnpm install --offline --frozen-lockfile` passed using pnpm 10.34.5, reusing 510 cached packages with no downloads. Node is v24.22.0. `pnpm build && pnpm test` and `pnpm typecheck` completed with exit 0. Results: worktree guards 117 passed; core 16 passed; desktop 1,858 passed and 16 skipped; native/package 21 passed and 5 skipped; site 10 passed; Store desktop 16 passed. Total: 2,038 passed, 21 skipped, zero failures/cancellations. Vite's existing chunk-size warnings remain. No local UI E2E was run because this changes documentation/evidence only, as directed.

`git diff --check`, sanitized JSON parsing/locality classification, and one-logical-line-per-prose-paragraph preflight passed. Raw inventory and verification logs are preserved outside the worktree under `/Users/buns/Documents/Codex/artifacts/modex-lm1/2026-10-24-approval/`; the published inventory omits linked-device identifiers and hostnames. The full signed commit/tree identity is recorded in the external checkpoint and PR. This worktree retains the reviewable changes and its ownership until delivery is reconciled.
