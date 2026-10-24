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
| `main/engine/local-models/connections.ts` | Main-owned profiles in `app/local-connections.json`; tokens in `SecretStore`, one versioned entry `local_connection:<id>:<uuid>` per saved token |
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

PR CI on `ef6863e` passed `unit + e2e (macOS)`. CodeQL raised one high `js/reflected-xss` alert
(#27) in the test file `test/local-model-endpoint.test.ts`, where a fixture server echoed
`req.url`. The fixture now answers `/ok` with a fixed body and 404s everything else. No product
code changed. After the fix, the focused tests passed 21/21 and typecheck exited 0. The first
`pnpm build && pnpm test` exited 1. In `scripts/test/worktree-entry.test.mjs:93`, `remove completes
the real CLI archive flow but reports a failed final observation` failed (116/117 passed), which
stopped the run before the desktop suite. This branch does not touch `scripts/`, and the test
passed twice when rerun alone. Rerunning `pnpm test` exited 0: 117, 16, 1848 (1832 passed, 16
skipped), 21, 10 and 16 tests, 0 failed.

`git merge-tree` against the heads of open PRs #370–#372, #374, #375 and #385 reported no
conflicts. #374 and #375 add lines to the same channel registries (`types.ts`, `index.ts`, Store
demo), so whichever lands second may need a trivial rebase.

## #377 delta when it is accepted

As of this rerun, #377 is open with no comments and no PR. The LM-1 session's draft (uncommitted,
in its own worktree, not read into this branch) declares the same `ConnectionRef { id, revision }`
and a `LocalModelRef` that adds `schema: 1`. Adopting it means importing those types here and adding
`schema: 1` to descriptor model references, with no behaviour change. The draft assigns endpoint
validation, bounded metadata and the public projection to LM-2, which matches this branch.

## Review fixes, 2026-10-23

An independent review of draft PR #386 (recorded in the `lm-foundation` session, not on `main`)
found two defects in `3654053`.
Both are fixed on `lm2-fixes`, which replays the six LM-2 commits onto `main` at
`203a3505bfa46b67ea4cb47254ece26ac0f2da88` without changes and adds one commit per fix. Each fix
started with a regression that failed on the reviewed code.

**P1: a failed profile write changed an old revision's credential.** `update` used to replace or
clear the token before writing the profile, so when the rename failed, the old revision resolved
the new token. Each saved token now has its own secret entry, `local_connection:<id>:<uuid>`, and
the profile names the entry it uses. An edit writes any new token first, then the profile. Only
after the profile is durable does it remove the superseded entry. If the write fails, the new entry
is removed instead. Delete writes the tombstone before clearing the token. The regression injects
EIO on the profiles-file rename for rotation, clear, endpoint move with and without a token, delete
and create. In every case, revision 1 still resolves its own token and address, the view does not
change and no orphaned entry is left behind. It failed first with `rotation: revision 1 still
resolves its own token`. Profiles saved by the unmerged draft, which name no entry, read as having
no token. That fails closed.

**P2: successful metadata could put the saved credential into IPC.** Discovery now rejects the
whole listing as `reflected-credential` when any model ID contains the saved token, exactly or
embedded. It never redacts, because a redacted ID would name a different model. Manual IDs that
contain the token are left out, and other manual IDs stay available. Fixtures cover exact and
embedded reflection through Responses `/v1/models`, LM Studio `/api/v0/models` and Ollama
`/api/tags`. A second fixture keeps IDs that only resemble parts of the token exactly as reported.
It failed first with `exact Responses ID: the token never reaches IPC`. One side effect: a very
short token rejects every listing that contains it. That fails closed and is visible as
`reflected-credential`.

The contract reconciliation (schema 1 and the shared `ConnectionRef`) is unchanged here. It waits
for LM-1's PR.

Results on `512016f`: macOS 27.0.1 arm64, Node v24.22.0, pnpm 10.34.5.

| Command | Result |
|---|---|
| `node --test dist/test/local-model-*.test.js` (in `apps/desktop`) | 25/25 passed: endpoint 6, connections 8, discovery 10, IPC 1 |
| `pnpm build && pnpm test` | exit 0. Worktree 117/117, core 16/16, desktop 1877 tests, 1861 passed, 16 skipped, 0 failed; native/package 21/21, site 10/10, Store desktop 16/16 |
| `pnpm typecheck` | exit 0 |
| `playwright test e2e/local-models-ipc.spec.ts` | 1/1 passed. Playwright fetched the Electron binary into the fresh worktree first; no model or runtime was downloaded |

## Hardening, 2026-10-24

Branch `lm2-integrate` (session-owned worktree), stacked on `lm2-fixes` at
`954cd5b7d0627333835db41f9b0dfb477b72176f` without changing it. `lm2-fixes` and `lm2-discovery`
are claimed by other sessions and were not edited. Every regression below was compiled and run
against `954cd5b` first; the five that found a defect failed there before any fix.

**History: an unreadable profiles file was replaced.** `local-connections.json` that failed to
parse, had the wrong shape or declared a newer `version` read as empty, and the next save wrote a
fresh file over it, losing every profile and deletion tombstone (AC6). Now only a missing file
reads as empty. `list` and every edit throw a fixed message and leave the file byte-for-byte, and
`resolve`/`provenance` return null. Entries this build can't validate are written back exactly as
found and are never listed or resolved. Failed first with `Missing expected exception: list refuses
{not json` and `kept exactly as written` (the newer entry had been dropped).

**Credential: the saved token could be written in plain text.** A token pasted into the label or a
manual model ID was saved to the plain-text profiles file and returned in views (AC3). Create and
update now refuse it, including a new token already inside a saved name or ID. Moving the address
still drops the token, so nothing saved can repeat it. Failed first with `Missing expected
exception: copy 0`.

**Credential: leftover token entries.** A crash between saving a token and writing its profile, or a
failed clear on delete, left an encrypted entry in `secrets.json` that nothing named. After every
successful save, `local_connection:` entries no profile (live or foreign) names are removed. Other
secrets, including `typesafe_api_key`, are never touched. `SecretStore.names()` lists entry names
only. Failed first with `only the entry revision 1 names is kept` (2 entries, expected 1).

**Credential: an unreadable token became an unauthenticated read.** When a saved token couldn't be
decrypted (keychain locked or unavailable), discovery sent its reads without it and could report
`ready`. It now returns `unavailable` with the fixed reason `credential-unavailable`, keeps manual
IDs and makes zero requests; once the keychain is back, one read carries the token. Failed first
with `actual: false, expected: 'credential-unavailable'` (the result had been `ready`).

**Time: no deadline for a whole discovery.** Every read had a deadline, but 32 Ollama `/api/show`
reads just under it, four at a time, held the answer for 7.2 s at a 1 s deadline (about 40 s at the
5 s default). A discovery now ends within three per-request deadlines: listings use at most two
(LM Studio's fallback, Ollama's tags and ps) and per-model reads share what remains. Detail still
unread then stays `unknown`, which is not a failure; a cancel or a newer read still returns
`stale`. Failed first with `discovery took 7228 ms`.

**Regression coverage that found no defect** (passed on first run against `954cd5b`): through
`LocalModelsService`, a slow read is stale after a label-only, manual-IDs-only, address or token
edit and after deletion; octal and trailing-dot IPv4 and fullwidth `localhost` normalize to loopback
origins; IPv4-compatible and NAT64 embeddings of 127.0.0.1, `localhost.` and port 65536 are refused.

One existing fixture changed: the reflection test no longer saves a manual ID that holds the token,
because saving it is now refused. Discovery still filters such IDs as a second line of defence.

Request counts: the credential-unavailable fixture records 0 requests while the token is
unreadable and exactly `["Bearer locked-token"]` after; the existing fixtures still assert their
exact request lists, none of them an inference, pull, load or unload route.

Results on `b12483c2439639ae274d1fcb2bca03e638a03207` (three commits on `954cd5b`; `main` at
`70123b966aaad0377311a105ae3fa739c0d63179`): macOS 27.0.1 arm64, Node v24.22.0, pnpm 10.34.5,
Electron 44.4.5, Playwright 1.63.0. Each of the three commits was also checked out on its own and
passed the focused tests (29, 31 and 32).

| Command | Result |
|---|---|
| `node --test dist/test/local-model-*.test.js` (in `apps/desktop`) | 32/32 passed: endpoint 6, connections 12, discovery 13, IPC 1 |
| `pnpm build && pnpm test` | exit 0. Worktree 117/117, core 16/16, desktop 1884 tests, 1868 passed, 16 skipped, 0 failed; native/package 21/21, site 10/10, Store desktop 16/16 |
| `pnpm typecheck` | exit 0 |
| `playwright test e2e/local-models-ipc.spec.ts` | 1/1 passed. Playwright fetched the Electron binary into the fresh worktree first; no model or runtime was downloaded |

Still open: #377 acceptance and adopting its shared identity (the LM-1 session's reconciliation is
not yet published on #397); listing-only reads against a real Ollama and LM Studio, which need
Val's authorization; Val's sign-off on the loopback metadata-discovery network wording that the
LM-1 session proposes for AGENTS.md; LM-3 execution binding and LM-4 UI.
