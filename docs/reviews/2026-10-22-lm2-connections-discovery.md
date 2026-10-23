# LM-2: local connections and bounded discovery, 2026-10-22

Issue [#378](https://github.com/TypeSafeAI/modex/issues/378) under tracker
[#376](https://github.com/TypeSafeAI/modex/issues/376). Branch `lm2-discovery`, cut from `main` at
`ec7be578765f9ce54976882853e57ca190252361`. Final head and exact command results belong to the PR.

## Prerequisite state

LM-1 ([#377](https://github.com/TypeSafeAI/modex/issues/377)) is **not accepted**: no PR, no comment,
and its contract module `src/shared/local-models.ts` does not exist on `main`. #378 lists #377 as a
*completion* blocker, so this branch builds only the parts that do not depend on #377's open
decisions and leaves completion blocked:

- Connection identity follows the #377 draft shape (`{ id, revision }`; model `{ connection, id }`
  with an exact opaque ID). It lives in `src/shared/local-connections.ts` so LM-1 keeps sole
  ownership of `src/shared/local-models.ts`. When #377 is accepted, these types fold into its
  module. That is a rename, not a second identity model.
- Advertised metadata (`advertised` / `not-advertised` / `unknown`) is deliberately not
  qualification. #377's tested `supported/unsupported/unknown` evidence remains the only coding
  capability claim.
- Nothing here touches the runner, native backends, Codex/Claude configuration or the renderer UI
  (LM-3/LM-4).

## What was built

| Module | Role |
|---|---|
| `main/engine/local-models/endpoint-policy.ts` | Loopback-only URL parsing; every resolved `localhost` address re-checked at connect; bounded JSON GET/POST |
| `main/engine/local-models/connections.ts` | Main-owned profiles in `app/local-connections.json`; tokens in `SecretStore` as `local_connection:<id>` |
| `main/engine/local-models/discovery.ts` | Ollama / LM Studio / Responses metadata adapters; revision-bound, supersedable reads |
| `main/engine/local-models/service.ts` | The single `local-models:command` handler, registered `localOnly` |
| `shared/local-connections.ts` | Renderer-safe views, descriptors and the strict request validator |

Requests discovery may make, and nothing else: Ollama `GET /api/tags`, `GET /api/ps`,
`POST /api/show` (capped at 32 models); LM Studio `GET /api/v0/models`, falling back to
`GET /v1/models` on 404; Responses-compatible `GET /v1/models` (or `/models` under a `/v1` base).

## Criterion evidence (mock / fixture, not native)

All evidence below is from synthetic loopback HTTP servers in the test process. No real
Ollama/LM Studio/vLLM/llama.cpp runtime was contacted, no model was loaded, downloaded or run.

- **AC1** normal, empty, malformed, wrong-shape, unavailable, 401, delayed (timeout) and oversized
  fixtures: `test/local-model-discovery.test.ts`, `test/local-model-endpoint.test.ts`. Through the
  compiled main handler: `test/local-model-ipc.test.ts`. Through production Electron preload and
  `ipcMain`: `e2e/local-models-ipc.spec.ts`.
- **AC2** non-loopback hosts, `0.0.0.0`/`::`, link-local, IPv4 shorthand/hex/decimal, IPv6 full and
  IPv4-mapped forms, credentials-in-URL, backslash/`@`/`%`/control injection, queries, fragments,
  unexpected paths, redirects, a `localhost` that resolves off-machine (refused before any
  connection: zero fixture hits) and forged IPC shapes (extra `url`/`endpoint`/`headers` fields).
  Sender-frame and document-epoch trust is the existing `handle()` guard; `localOnly` keeps the
  channel off the paired-desktop command map (asserted).
- **AC3** the token is absent from every IPC reply, from the profiles file and, as plaintext, from
  the secrets file; views expose presence only (not last four characters). Failure text is fixed
  and never quotes the server. A `typesafe_api_key` saved in the same store never reaches a fixture
  server. A token is dropped when the address changes. With no OS keychain, saving a token is
  refused rather than stored in plain text.
- **AC4** the same ID on two connections yields distinct `{ connection, id }` targets; reads
  superseded by a newer read, cancelled, or completed after an edit or deletion return `stale`.
- **AC5** manual IDs (with spaces, slashes, colons) survive failed listings and stay selectable;
  embedding-only, non-text (`other`) and Ollama cloud-routed models are unselectable.
- **AC6** every fixture asserts the exact request list; none matches
  generate/chat/completions/responses/embed/pull/push/create/copy/delete/load/unload/blobs. Deleted
  or edited profiles never resolve an old revision; tombstones keep label/runtime/origin for history.

## Not done / open gates

- #377 acceptance (blocks #378 completion).
- Native evidence: metadata reads against a real user-installed Ollama and LM Studio, with their
  versions recorded. This needs the person's authorization and must not load or pull models.
- Run snapshots and execution binding to `ConnectionRef` (LM-3 #379); renderer settings and model
  picker (LM-4 #381). Only main's typed channel exists.
- Locality remains `unverified` for every non-cloud model; loopback does not prove local inference.

## Commands and results

Environment: macOS (Darwin 25.6.0), Node v24.22.0, pnpm 10.34.5, Electron 44.4.5, Playwright 1.63.0.
Code under test: `1c0dd37ef09669d061f3ee4810da0f7c44c09ae1` on base
`ec7be578765f9ce54976882853e57ca190252361` (main unchanged at the rerun). The commit that adds
this section changes documentation only.

| Command | Result |
|---|---|
| `node --test dist/test/local-model-*.test.js` (in `apps/desktop`) | 21/21 passed: endpoint 6, connections 6, discovery 8, IPC 1 |
| `pnpm build && pnpm test` (repository root) | exit 0. Desktop unit: 1848 tests, 1832 passed, 0 failed, 16 skipped (Windows-only native tests, pinned OpenKnowledge). Other suites: 117, 16, 21, 10, 16 passed, 0 failed |
| `pnpm --filter @modex/desktop typecheck` | exit 0 (main and renderer) |
| `npx playwright test e2e/local-models-ipc.spec.ts e2e/code-review-ipc.spec.ts` | 2/2 passed |

Each test file was compiled and failed before its module existed. Discovery's resolver test
failed once against the first implementation, because an injected resolver replaced the loopback
wrapper instead of feeding it; the fix always wraps it. An earlier full run failed because the
Store desktop offline demo lacked the new channel; that demo now refuses it like other system tools.
The full `pnpm test:e2e` suite was not run, because this branch has no renderer change.

`git merge-tree` against the heads of open PRs #370–#372, #374, #375 and #385 reported no
conflicts. #374 and #375 add lines to the same channel registries (`types.ts`, `index.ts`, Store
demo), so whichever lands second may need a trivial rebase.

## #377 delta when it is accepted

As of this rerun, #377 is open with no comments and no PR. The LM-1 session's draft (uncommitted,
in its own worktree, not read into this branch) declares the same `ConnectionRef { id, revision }`
and a `LocalModelRef` that adds `schema: 1`. Adopting it means importing those types here and adding
`schema: 1` to descriptor model references, with no behaviour change. The draft assigns endpoint
validation, bounded metadata and the public projection to LM-2, which matches this branch.
