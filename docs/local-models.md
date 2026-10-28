# Local models: LM-1 contract and feasibility

Status: narrow Gate A accepted by Val on 2026-10-24 under #377 / #376 for the producer at main `bb0e1a42ac7bb3e11ccfee05a40d8a02f1dc10c4` and the recorded Codex/Strata combination. No local execution option is enabled by this change. Existing `BackendId`, thread persistence, account policy, native execution, approval handling and companion messages are unchanged.

## Identity and migration

`src/shared/local-models.ts` owns the accepted shared data contracts. A harness is `codex` or `claude`, never an inference runtime. Connection IDs are main-generated opaque identifiers; positive integer revisions change whenever endpoint, credential binding, wire configuration or relevant connection settings change. Exact model identifiers are opaque and case-sensitive, including punctuation and whitespace. `LocalModelRef` schema 1 combines the connection revision and model identifier. `modelKey` is an unambiguous tuple serialization, not a credential or authority token.

`LocalConnection` is main-owned configuration. Its credential reference points to secret storage; it is neither a token nor renderer data. LM-2 must validate endpoints, bound metadata requests and define the public projection. This type is not an IPC validator. No direct coding-inference HTTP client is introduced.

### Shared identity with LM-2

`shared/local-models.ts` is the single owner of `ConnectionRef`, schema-1 `LocalModelRef`, `LocalConnectionProfile` and `LocalMetadataRuntime`. LM-2's `shared/local-connections.ts` imports and may re-export these identities; its `LocalRuntime` is an alias for `LocalMetadataRuntime`, and `LocalModelDescriptor.model` is `LocalModelRef`. Both discovered and manual entries use `localModelRef(connection, exactId)`, which copies the connection revision and adds `schema: 1`. The helper assumes main has validated the values; it does not grant admission, qualify a model or normalize its ID.

| Connection profile (kind) | Metadata runtime (adapter) | Mapping |
| --- | --- | --- |
| `ollama` | `ollama` | Both directions preserve the name. |
| `lmstudio` | `lmstudio` | Both directions preserve the name. |
| `llamacpp`, `vllm`, `custom` | `responses` | All use compatible model listings. A generic `responses` profile from LM-2 maps to `custom`; do not infer llama.cpp/vLLM from metadata or an ID. |

`metadataRuntimeForProfile` and `connectionProfileForRuntime` define this mapping. The mapping is deliberately many-to-one: selecting an explicit llama.cpp/vLLM preset remains separate from the metadata protocol and must be retained in the main-owned profile. Responses is the coding wire in each case; neither the adapter nor the connection kind changes the native harness.

#386 and #398 kept the older identity and are superseded. LM-2 adopted this contract in #403, which applies the [consumer adoption patch](reviews/2026-10-24-lm1/lm2-identity.patch) (written against #398 at `954cd5b7d0627333835db41f9b0dfb477b72176f`) unchanged. It imports the canonical identities, aliases the adapter type and uses the canonical model factory. #403 also keys advertised model metadata by `Capability`, with `unknown` for anything a listing doesn't advertise.

`LocalThreadTarget` is the additive schema-1 binding LM-3 persists as `Thread.localTarget`, beside `Thread.localContextTokens`. The pure `threadTarget` reader preserves an absent target as legacy harness/model/account/resume semantics without writing or relabeling history. A present invalid or mismatched target is unavailable, never silently interpreted as cloud. Local selection deliberately does not import a legacy resume handle. [LM-3](#lm-3-local-execution-through-codex) validates the target in main before it is saved and before every turn.

A run snapshots `QualificationConfiguration` and `LocalRunProvenance`. Configuration includes harness/CLI, connection revision, exact model, runtime/model/template/tool-parser revisions, effective context, explicit effective provider/reasoning/service-tier/approval/sandbox/network/writable-root/toolset settings, and a revision of the remaining effective non-secret native configuration. Process reuse and native resume must additionally bind credential generation, account generation, process-configuration revision and process generation. Generations are opaque main-owned IDs, never secrets or hashes of secrets. Record native thread/turn IDs using existing conversation/event identity; do not create a second event log. Snapshot before execution and never mutate past receipts when a profile changes.

## Qualification

Connection health (`unknown`, `reachable`, `unreachable`, `unauthorized`) is independent of model capability. Metadata assertions and native tests remain separate evidence sources. Tools, images, structured output, reasoning, resume and cancellation each have supported/unsupported/unknown status. `capabilityStatus` only reuses dated, receipted native observations for an exact known tested configuration; metadata, conflicting observations and unknown revisions produce unknown. It does not grant tool authority or establish task quality. A greeting is not a tool test.

Advertised context belongs to metadata; effective context belongs to the tested configuration. A model/runtime/template/parser/configuration change invalidates qualification. Producers must issue new revisions even when a model's displayed name stays the same. Unknown revision information cannot certify reusable support. Main owns evidence creation; never accept a model assertion or renderer-supplied receipt as authority.

Loopback endpoint, observed local inference and network-denied verification are distinct. The provenance locality claim needs its own receipt; a local URL alone proves neither inference locality nor offline operation. LM-5 must enforce pinned local selection, deterministic titles, no generated follow-ups, no Jev inference and no unqualified remote tools across the turn and auxiliary work. These policies are requirements, not implemented claims here.

## Source and native interface map

| Consumer | Existing source / interface | Required follow-on boundary |
| --- | --- | --- |
| Discovery (LM-2) | `shared/local-models.ts`; `backends/types.ts` `ModelInfo`; `CodexBackend.listModels` | Main-owned bounded metadata; native catalogue is not local discovery or qualification. |
| Execution (LM-3) | `engine/backends/codex.ts` constructor configuration, `ensure`, `attempt` | Child-scoped args/environment, exact provider/model, no provider fallback, isolated process identity. |
| Account isolation | `engine/backends/account-codex.ts` `use`, `planArgs`, `runTurn` | Preserve per-registration leases and CLI-owned legacy resumes. ChatGPT plan provider overrides must never override a local target. |
| Admission / safety | `main/index.ts` handle wrapper; `engine/runner.ts` `runTurn`, `updateThread`; `CodexBackend.policy` | Preserve trusted sender, desktop-host authorization, recovery/restart fences, main-owned account/resume handles and native approval/sandbox policy. WorkOS app identity remains identity-only. |
| UI / persistence (LM-4) | `shared/types.ts` `Thread`, `ThreadPatch`; Store and existing journal/companion projections | Add fields only with main validation and safe old-client behavior; do not fork conversation identity. |
| Auxiliary policy (LM-5) | `runner.ts` naming/router/follow-up paths; `engine/titles.ts` | Admission must enforce local policy before any auxiliary inference. |
| Stop / recovery | `codex.ts` interrupt handling, `endTerminals`, `forceStop` | Interrupt acknowledgement is insufficient; verify owned background terminals have stopped, otherwise outcome stays unknown. Never replay an uncertain effect. |

Installed `codex-cli 0.163.0` schema was generated (re-checked on 0.164.0 on 2026-10-23: `ThreadStartParams` is byte-identical, `TurnStartParams` adds only Responses client-metadata fields; see the [0.164.0 refresh](reviews/2026-10-22-lm1-feasibility.md#codex-01640-refresh-2026-10-23)) with `codex app-server generate-json-schema --experimental --out apps/desktop/.probes/lm1/schema`. `thread/start` accepts `model`, `modelProvider`, `config` and `allowProviderModelFallback`; the latter must be false. `thread/resume` accepts model/provider/config overrides but has no fallback field. `turn/start` accepts model, effort, service tier, sandbox/approval policy and collaboration mode. Resolve effective settings before launch; native-plan configuration must not retarget the run. Merged PR #385 adds `collaborationMode.settings.model` and `reasoning_effort`, which override turn settings. LM-3 must pin that nested model to the same exact local model, include collaboration-mode changes in the configuration revision, and refuse a missing/mismatched local target rather than inherit a cloud/default thread model. The current probe does not qualify Plan mode. These schema fields prove protocol shape, not provider support.

The existing backend launches `codex app-server -c model_reasoning_summary="detailed"` plus scoped configuration arguments, initializes with experimental API capability, starts/resumes a thread, and sends text/local-image input to `turn/start`. Local providers must qualify or suppress unsupported reasoning/effort/service-tier/image controls. `turn/interrupt` takes thread and turn IDs. Existing terminal list/terminate cleanup must remain in the Stop path.

The [official Codex configuration reference](https://developers.openai.com/codex/config-reference) documents provider overrides. [Ollama's Codex integration](https://docs.ollama.com/integrations/codex) uses a Responses provider and generated catalogue; [LM Studio's integration](https://lmstudio.ai/docs/integrations/codex) documents `/v1/responses`. These references are not runtime acceptance. Do not run launch helpers that rewrite global configuration or implicitly download weights. The isolated schema probe accepted an unlisted exact model without a custom catalogue; actual inference/catalogue requirements still need the real-model probe.

## Gate A probe protocol

Use already installed weights, a disposable fixture and child-scoped configuration, never global CLI settings or cloud credentials. Record exact CLI/runtime/model/template/parser versions, arguments, effective context and schema hashes. Initialize app-server, inspect model catalogue, explicitly select the exact model/provider with fallback disabled, and require an observed native tool result reading a unique fixture sentinel. Capture actual Responses request/event shapes from the runtime's existing diagnostic facility if available; no new protocol proxy or inference client.

Start a second harmless command long enough to Stop after execution begins. Capture interruption and background-terminal termination evidence, then verify no delayed effect occurs. Continue the same safely settled native thread with a new read-only request; do not automatically replay the interrupted request. Missing native capabilities, unsupported tool shapes, unknown command completion or an unavailable local service leave qualification of the tested runtime/model combination blocked; they do not broaden or invalidate the separately accepted Strata receipt. Record real native results separately from contract fixtures and schema-only acceptance. Offline qualification requires separately denying network access to both Modex and the inference service.

## LM-3: local execution through Codex

Status: main-only, no UI, not admitted in the product (#379). A thread gets a local target through
`thread:update` with `localTarget` and `localContextTokens`; LM-4 (#381) will offer that in the interface.
Nothing in the app sets one today, and a paired desktop's patch never carries one. `main/index.ts` does not
construct `LocalExecution`: until LM-5 (#380) qualifies Codex's redirect handling and managed-policy
precedence (AC6), the runner has no execution seam, so it refuses a selection before writing it and ends a
persisted target's turn with a notice, without starting a child or routing to a cloud backend. The
description below is of the module and its fixture-proven behaviour once wired.

**Admission.** `ThreadRunner.updateThread` accepts a target only after `LocalExecution.validate` resolves
exactly its connection revision, with the token readable, and the context window is 4,096–262,144 tokens.
Selection pins the thread: backend `codex`, the exact model ID, Auto off, Plan off, no effort; the native
handle and account binding are dropped, so the next turn starts a fresh native conversation. While the
target is set, `model`, `backend`, `effort`, `auto`, `plan` and the context window cannot be changed
except by selecting another target or clearing it (`localTarget: null`), which returns the thread to the
default Codex model with a fresh handle. Settings are locked while a local turn runs. Every send validates
again: a changed or deleted connection, a mismatched model, Plan, an image or a build without local
execution ends the turn with a notice and never routes to a cloud backend or account.

**Isolation.** `engine/local-models/execution.ts` keeps one `CodexBackend` child per thread, keyed by
connection revision (which moves with the address or token), model, context window and working directory.
The child runs `codex app-server` with a private, empty 0700 home (`HOME`, `CODEX_HOME`, `XDG_CONFIG_HOME`,
`APPDATA`), so the person's `~/.codex` configuration, plugins, MCP servers and sign-in are not read; an
environment allowlist of path, temp, locale and Windows shell variables; `NO_PROXY=*` with no proxy
variables inherited; and the connection token, when there is one, in `MODEX_LOCAL_TOKEN` only, named by
`env_key` and excluded from the tool shell by `shell_environment_policy`. The provider is `modex_local`
at `<origin>/v1` on the Responses wire with `requires_openai_auth=false` and retries off; the model and
provider are named on every `thread/start` and `thread/resume` with `allowProviderModelFallback=false`,
and Codex's reply must confirm both before any turn content is sent. A stale sign-in is never retried. A
resume handle the child did not itself open, including every handle after a restart or target change, is
refused rather than resumed. A project `.codex` directory in or above the working directory and a
`localhost` endpoint are refused (precedence and resolver behaviour are unqualified). One turn at a time
reaches any one loopback port, so IPv4, IPv6 and mapped aliases share a slot; a Stop while waiting starts
nothing. Force-stop ends only the thread's own child. Deleting the thread, clearing the target or quitting
removes the child and its private home.

**What a local turn does not get.** Auto routing, Jev for approvals, generated titles, follow-up
suggestions, the credit fallback, Modex's note and knowledge tools, images, Plan, web search, image viewing
and Codex's sub-agents. Effort, fast mode, service tiers and reasoning summaries are not sent. Deterministic approval rules
and the thread's approval and sandbox policy still apply, as do native approvals, questions, Stop and the
background-terminal cleanup.

**Evidence.** Fixtures prove the admission, isolation and session rules; the installed Codex 0.164.0 ran a
real shell read through this path against a scripted loopback Responses server, with the sentinel returned
in the next request, no token in model input and no unqualified tool offered. Both are recorded in the
[LM-3 review](reviews/2026-10-26-lm3-local-codex.md). A turn against a real local server (AC1) is a human
gate: `MODEX_LM3_LIVE=1` with `MODEX_LM3_URL` and `MODEX_LM3_MODEL` runs it, and Modex starts, installs and
downloads nothing. Loopback stays a destination, not verified locality: Codex's HTTP client follows
redirects, and a server may forward requests. Offline operation, managed-policy precedence, Plan, images,
other runtimes and resume across restarts are unqualified.

## Accepted boundary and follow-up runtime availability

Val accepted narrow Gate A and separately approved the AGENTS metadata boundary in this task on 2026-10-24. The [acceptance and runtime-availability receipt](reviews/2026-10-24-lm1-acceptance.md) records the exact producer SHA, approval scope and authorized installed-model inventory. The accepted producer and Strata evidence may be consumed by LM-2/LM-3; acceptance does not qualify Plan, fresh-process resume, other runtimes, offline operation or UI.

Ollama 0.40.10 has no installed models. LM Studio's only model on this machine is an embedding model; its generative entries belong to a linked device. The additional app-server probe was authorized but has no eligible installed local target; Val explicitly deferred it until a local coding model exists. No inference was attempted, and no model was downloaded or imported. This is an availability gap, not a failed tool-compatibility result or authorization blocker.
