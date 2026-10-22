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

## Commands and results (macOS, Node from the pinned pnpm workspace)

- Focused: `node --test dist/test/local-model-*.test.js` passed 21/21 (endpoint 6, connections 6,
  discovery 8, IPC 1). Each file was compiled and confirmed failing before its module existed.
  Discovery's resolver test failed once against the first implementation: an injected resolver
  replaced the loopback wrapper instead of feeding it. The fix always wraps it.
- `pnpm build && pnpm test` from the repository root exited 0. Desktop unit: 1848 tests, 1832
  passed, 0 failed, 16 skipped (Windows-only native tests and the pinned OpenKnowledge test). The
  other suites passed 117, 16, 21, 10 and 16. The first run failed because the Store desktop
  offline demo lacked the new channel. It now refuses the channel like other system tools.
- `npx playwright test e2e/local-models-ipc.spec.ts e2e/code-review-ipc.spec.ts` passed 2/2.
  The full `pnpm test:e2e` suite was not run: this branch has no renderer change.
