# LM-3: local execution through Codex — 2026-10-26

Implements [#379](https://github.com/TypeSafeAI/modex/issues/379) under the #376 tracker, consuming the
accepted LM-1 contract (#405) and LM-2 connections (#403). Branch `lm3-codex`, cut from `main` at
`deb373a` (#410). Main-only: no UI, no new IPC channel, no inference client. [How it works](../local-models.md#lm-3-local-execution-through-codex).

## Reconciliation

#401 (`lm2-land`) was superseded by #403 and had fallen behind `main` (it still read version 0.3.0 and
removed files `main` has). The draft #407 (`strata-integration`) was stacked on it. Both were closed with
comments on 2026-10-26. This branch starts from `main` and carries #407's main-side design, re-derived
against today's `runner.ts` and `codex.ts`: the isolated `LocalExecution` service, provider and model
pinning with Codex's confirmation, runner admission without cloud paths, per-port capacity, and the
refusals of project `.codex` directories and restart resume. Differences from #407: no effort is sent
(it forced `low`), a child's private home is removed with the child, the thread-settings lock applies
while a local turn runs, a paired desktop's `thread:update` cannot carry a target, and the scripted-wire
check is a checked-in opt-in test instead of a probe script. #407's renderer controls are left to LM-4.

## Changes

| Area | Files |
| --- | --- |
| Types | `shared/types.ts`: `Thread.localTarget`, `Thread.localContextTokens`, `ThreadPatch.localTarget` (null clears) |
| Codex seam | `backends/codex.ts`: `configuration.local` pins provider and model, confirms both from `thread/start`/`thread/resume`, refuses a foreign resume and a different model before spawning, never retries a stale sign-in |
| Execution | `local-models/execution.ts` (new): per-thread child, private home, env allowlist, token handling, per-port capacity, keyed sessions |
| Admission | `engine/runner.ts`: local dispatch; no account, Auto, Jev, title, follow-up, credit fallback, note or knowledge tools; settings lock; target switching and clearing; thread-scoped force-stop; forget on delete and dispose |
| Wiring | `main/index.ts`: `LocalExecution` built on the LM-2 connection store; plugin-revision fence skipped for local threads (their child loads no plugins) |
| Tests | `test/codex-backend.test.ts` (+3), `test/local-model-execution.test.ts` (8), `test/runner-local-models.test.ts` (6), `test/local-codex-native.test.ts` (2, opt-in) |

## Acceptance criteria

| | Status | Evidence |
| --- | --- | --- |
| AC1 real local model completes a tool fixture without cloud auth | **Human gate** | The harness path is proven with the installed CLI and a scripted server (below). The live run is `MODEX_LM3_LIVE=1 MODEX_LM3_URL=… MODEX_LM3_MODEL=… node --test dist/test/local-codex-native.test.js` against a server Val already runs; Modex starts nothing. |
| AC2 cloud and local share no credentials, handles or provider configuration; stopping one leaves the other | Fixtures | Execution tests: private home and env allowlist, `OPENAI_API_KEY`/proxy absent, token only in `MODEX_LOCAL_TOKEN`; force-stop reaches one child. Runner tests: a local turn carries no account and binds none; force-stop counts. |
| AC3 edits, rotation and restart cannot rebind a session silently or replay | Fixtures | Rotation moves the revision, so the old target fails before spawn and the new one spawns with the new token; a changed context window refuses the old handle and starts a fresh child; a new `LocalExecution` refuses a persisted handle; `CodexBackend` refuses a handle it did not open. No path re-sends a prompt. |
| AC4 existing regressions pass; global configuration unchanged | See checks | The child's `CODEX_HOME` is private; nothing writes `~/.codex` or shell files. |
| AC5 unsupported options omitted or rejected; outcomes from native observations | Fixtures and wire | Effort, fast and service tier not sent; Plan, images, note and knowledge tools refused; `view_image`, web search and sub-agents off and absent from the offered tools; tool outcome `succeeded` comes from Codex's item status. |
| AC6 inherited config, proxy, redirect and plan presets keep or refuse the target; no bypass or leak | Partly | Project `.codex` refused; proxy variables not inherited and `NO_PROXY=*`; private home loads no user config or plugins (the wire request offers only built-in tools, while this Mac's `~/.codex/config.toml` enables several plugins); Plan refused. **Open:** redirect handling belongs to Codex's HTTP client and is not constrained; this Mac has no `/etc/codex` or managed preferences, so managed-policy precedence was not exercised. |

## Checks

- RED: with the implementation reverted to `main`, `pnpm run build:main` fails on the new tests (22 errors:
  `localTarget` unknown on `Thread`/`ThreadPatch`, `execution.js` missing). GREEN: build and typecheck pass.
- `node --test` on `codex-backend`, `local-model-execution`, `runner-local-models`: 54 passed, 0 failed.
- `pnpm typecheck`: passed.
- Full desktop unit suite (`node --test dist/test/**/*.test.js`): 1,976 tests, 1,957 passed, 0 failed,
  19 skipped (the 17 usual opt-in cases plus the two native LM-3 checks, which run only on request).

## Real CLI, scripted server

`MODEX_LM3_WIRE=1 MODEX_LM3_REPORT=… node --test dist/test/local-codex-native.test.js` on macOS 27.0.1
arm64, Node v24.22.0, codex-cli 0.164.0 (`/opt/homebrew/bin/codex`): **passed**, 1 of 2 (the live test
skipped). The test starts a Responses server on `127.0.0.1:<ephemeral>/v1` in-process that asks for one
`exec_command` and answers once the sentinel comes back. [Receipt](2026-10-26-lm3-local-codex/wire-receipt.json):

- Two `POST /v1/responses`, both with the bearer token, model `scripted-fixture-model` (unlisted, no catalogue).
- Offered tools: `exec_command`, `write_stdin`, `request_user_input`, `get_goal`, `create_goal`,
  `update_goal`. No `view_image`, no web search, no plugin or MCP tools.
- Codex ran `/bin/zsh -lc 'cat fixture.txt'` in the fixture directory; Modex observed the shell tool with
  a `read` action and outcome `succeeded`; the second request carried the sentinel and never the token.
- Reply: "The file contains LM3-FIXTURE-SENTINEL-7f3a." Usage: 2 calls, 200 input tokens (fixture numbers).
- Afterwards no `modex_local` app-server remained.

This is harness evidence with a scripted model: it qualifies no inference, runtime or offline claim.

## Open gates

1. AC1 live turn (Val): a local server and model on this Mac, run as above. Ollama 0.40.10 and LM Studio
   are installed; the LM-1 inventory found no local coding model, and none is downloaded by this work.
2. Redirect behaviour of Codex's client and managed-policy precedence: LM-5 (#380).
3. Runtime qualification per server (Ollama, LM Studio, llama.cpp, vLLM): LM-6 (#382). The Responses wire
   at `<origin>/v1` is configured for every profile; whether a given server serves it is not assumed.
4. Interface: LM-4 (#381).
