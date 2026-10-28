# LM-5 slice 1: effective destination and managed-policy admission — 2026-10-27

Issue [#380](https://github.com/TypeSafeAI/modex/issues/380) under [#376](https://github.com/TypeSafeAI/modex/issues/376);
closes LM-3's open gate on [#379 AC6](https://github.com/TypeSafeAI/modex/issues/379) by qualifying what main can
prove about a local child's inference destination and recording what it cannot. Branch `lm5-policy`, stacked on
`lm3-codex` at `9159eda` (PR #417, rebased on `main` `6c9000f`). Codex: codex-cli 0.164.0 at `/opt/homebrew/bin/codex`;
macOS 27.0.1 arm64; Node v24.22.0. No merge or release is requested; nothing was installed or downloaded.

## The question

Val's review of #417 (2026-10-26): "confirming the provider name does not verify the effective HTTP destination."
LM-3 names `modex_local` on every `thread/start` and checks Codex's confirmation, but a configuration layer above
Modex's session flags could change the provider's `base_url`, the model, the context window or the offered tools,
and Codex's HTTP client follows redirects. Two things had to be established: what Codex reports about its own
effective configuration, and what it does with a redirect from the configured server.

## What codex-cli 0.164.0 reports

The app-server protocol (generated with `codex app-server generate-json-schema`) has `config/read` and
`configRequirements/read`. Run against an LM-3 style child (private empty home, Modex's `-c` flags, no thread):
[receipt](2026-10-27-lm5-destination-policy/config-read-receipt.json).

- `config/read { includeLayers: true, cwd }` returns the **effective configuration** (including
  `model_providers.modex_local.base_url`, which the published `Config` schema omits but the server sends), an
  **`origins` map** naming, for every effective key, the layer that set it, and the **`layers`** in precedence
  order with each layer's contents and a content hash. For the child: `sessionFlags` (Modex's flags, hash
  `sha256:b3932b…`), `user` (the private home's `config.toml`, empty) and `system` (`/etc/codex/config.toml`,
  absent, empty). Every origin was `sessionFlags`.
- Layer sources the schema defines: `packagedDefaults`, `mdm` (macOS managed preferences), `system`
  (`/etc/codex/config.toml`), `enterpriseManaged` (cloud bundle), `user`, `project` (`.codex` folders),
  `sessionFlags` (`-c`), `legacyManagedConfigTomlFromFile` and `legacyManagedConfigTomlFromMdm`
  (`managed_config.toml`, being phased out for `requirements.toml`).
- `configRequirements/read` returned `requirements: null`. A `requirements.toml` placed in the child's private
  `CODEX_HOME` was **not** read (still `null`): requirements come from admin sources only, so the private home
  cannot introduce them and an isolated home cannot evade them.
- This Mac has no `/etc/codex`, no `requirements.toml` and no Codex managed preferences, so no managed layer was
  exercised live. The policy's handling of managed layers is proven on fixtures shaped exactly like this receipt.

## What Codex does with a redirect

A loopback server A, configured as the provider, answered `POST /v1/responses` with a redirect to a second loopback
server B that returns a plain message ([receipt](2026-10-27-lm5-destination-policy/redirect-receipt.json), produced
by the opt-in native test below; the same was first observed with a raw app-server probe, including a redirect to a
`localhost` name):

| Redirect | What reached B | Token | Turn |
| --- | --- | --- | --- |
| 307 | `POST /v1/responses`, the full 29 KB body including the prompt | dropped (`Authorization` absent) | completed with B's answer |
| 302 | `GET /v1/responses`, no body | dropped | completed with B's answer |

Codex's configuration reference documents no redirect setting for model providers, and none exists in the
0.164.0 config schema. So: **the token never follows a redirect**, which the native test asserts; **the request
body does on a 307**, which is recorded, not prevented. A loopback server that redirects can send the turn's
content wherever the redirect points, exactly as it could by forwarding it. This is the "loopback is a
destination, not verified locality" boundary already in `docs/local-models.md`, now with evidence.

## What main now does (`engine/local-models/run-policy.ts`)

Before a local child opens or resumes any thread, `CodexBackend` reads `config/read` (with layers, for the turn's
`cwd`) and `configRequirements/read` from the child and hands both to `admitLocalConfiguration`, which admits the
child only when all of the following hold, and otherwise throws with the layer and key named. Nothing is rewritten
or bypassed; the turn fails with the reason and no content is sent.

1. Every effective key in a **governed** set (`model`, `model_provider`, `model_providers`, `openai_base_url`,
   `oss_provider`, `model_catalog_json`, `model_context_window`, `model_auto_compact_token_limit`,
   `model_reasoning_*`, `service_tier`, `web_search`, `features`, `mcp_servers`, `shell_environment_policy`,
   `plugins`, `hooks`, `marketplaces`, `profile(s)`, `projects`, `notify`, `otel`, `tools`,
   `developer_instructions`, `model_instructions_file`, `agents`, `cloud`, `experimental_*`) originates from
   `sessionFlags`. Keys outside the set (an update preference, approval and sandbox limits) are Codex's to
   enforce and do not refuse.
2. No `project` layer is loaded; the `user` layer (the private home) is empty; no managed layer's contents touch
   a governed key even where its value loses.
3. `requirements` is `null`.
4. The effective values are the ones Modex passed: `model_provider`, the provider's `base_url` (`<origin>/v1`),
   `wire_api = responses`, `requires_openai_auth = false`, `env_key` (only when a token exists),
   `request_max_retries = 0`, no bearer token, auth command, headers or query parameters;
   `model_context_window`; `web_search = disabled`; `openai_base_url` and `model_reasoning_summary` unset;
   `features.view_image = false`; no MCP servers.
5. A Codex that cannot answer `config/read` is refused ("needs codex-cli 0.164.0 or later").

The admitted configuration's provenance (the session-flags hash and each layer's source, hash and file; no
secrets) is kept with the child and exposed by `LocalExecution.provenance(threadId)` for diagnostics.

Separately, a `model/rerouted` notification on a local turn (Codex's own notice that it switched the model)
interrupts the turn at once and reports it **failed** with the models and reason; running terminals are ended as
on Stop, and the turn is never continued on the other model.

## Checks

- RED: with the implementation at LM-3's head `9159eda`, the extended execution tests fail to build
  (`provenance` missing on `LocalExecution`) and, run anyway, the reroute case never ends, because nothing
  interrupts the turn.
- GREEN: `local-run-policy` (5), `local-model-execution` (11, three new), `codex-backend`, `runner-local-models`:
  all pass. `pnpm typecheck`, the full desktop unit suite and the core, site, store-desktop and worktree-script
  suites: recorded in the PR.
- Real CLI, `MODEX_LM3_WIRE=1`: the LM-3 wire test passed with the admission in the path
  ([receipt](2026-10-27-lm5-destination-policy/wire-receipt.json): two bearer requests, six built-in tools,
  sentinel in the second request, `succeeded`, provenance `sessionFlags`/`user`/`system` with Codex's hashes), and
  the new redirect test passed with the table above.

## Acceptance against #380

| | Status | Evidence |
| --- | --- | --- |
| Destination and managed-policy admission (#379 AC6 remainder) | Fixtures and real CLI | Effective configuration read from the child; governed keys bound to session flags; managed layers, project layers, a dirty private home and requirements refused by name; redirect behaviour recorded. |
| AC1 no cloud inference for local turns, every failure path | Partly (LM-3) | LM-3 already routes no local turn or auxiliary work to a cloud backend; a refused admission fails before any request. A full network-spy sweep of auxiliary paths is a later slice. |
| AC3 capacity per service, cancelled waits send nothing | Partly (LM-3) | One turn per loopback port with a cancellable wait (LM-3). Shared capacity across profiles and subagent admission: later slice. |
| AC4 truthful outcomes, no silent fallback | Partly | A reroute fails the turn; no retry of an ambiguous turn exists. Overflow, OOM and disconnect states: later slice. |
| AC2, AC5, AC6 (offline canary, entry points, context evidence) | Open | Not in this slice. |

## Open

- Live managed-policy run on a Mac that has one (MDM profile or `/etc/codex`): the refusal is fixture-proven.
- Product admission of local execution stays closed (`main/index.ts` does not construct `LocalExecution`); with
  this slice the refusal boundary Val asked for exists, and wiring it is Val's decision.
- AC1's live local-model turn (LM-3) remains Val's.

## Review repair: reroute versus quiet-final completion

Independent review of `065447f99c18a0448f3f90ed3ecfd29ab7ffdb07` reproduced a local model reroute followed by a final answer and an acknowledged interrupt request without a terminal notification. The quiet-final timer incorrectly returned completed. Both event orders (final answer before and after reroute) now have regressions that first failed by observing settlement before terminal acknowledgement.

The repair refuses quiet-success scheduling and completion after a reroute, clears an existing timer when rerouting arrives, and retains the active turn until native termination or disconnect. The immediate notice says a stop was requested rather than claiming it already happened. After terminal acknowledgement the existing reroute failure path remains in force. Ordinary cloud quiet-final behavior is unchanged.

At the earlier repair checkpoint (source carried by `583a61be94e62629682aec0b4a2cdd7bc93f31d2`), build and typecheck passed in the owned `lm5-reroute-repair` worktree. Focused backend/execution tests passed 53/53; full unit validation passed 2,200 tests, with 25 skips and no failures. E2E was pending behind the active CR-6 desktop run; logs are preserved under `~/Documents/Codex/artifacts/modex-land-and-prune/lm5-reroute-*.log`. No complete verification, merge, local-runtime qualification or product-admission claim is made here. Product admission remains closed and the original live acceptance gates remain open.

## Integrated validation after signed delivery rebase

At `6ca43ed3c5fa206e03e2f561d5e8f7fe9e8014bd`, based on signed LM-3 `4745b729acb5cbd1d59a4f9fd5dcdb83f5ff329f`, root build, full unit tests (2,219 passed, 26 skipped, zero failed) and root typecheck passed. Root `pnpm test:e2e` then passed with 470 desktop cases, seven desktop skips (20.7 minutes), and seven site cases (8.9 seconds), exit 0. Logs are `lm5-main-build.log`, `lm5-main-unit.log`, `lm5-main-typecheck.log` and `lm5-main-e2e.log` in the external artifact directory above. Independent read-only integration review found no critical or important findings. Range comparison preserved the reroute repair; status conflict resolution retained the latest companion evidence and updated delivery references. These are fixture and integration results, not local-runtime, offline, managed-policy or product-admission acceptance. PR #424 remains subject to hosted checks, prerequisite #423 delivery and the protected merge queue.
