# CR-6 native review and PR questions — evidence (2026-10-28)

Issue: #325 (CR-6) for #319. Branch `cr6-review`, cut from `main` at `6c9000f5b6bc7d1733cec9db15ba00d5b9844291`.
Phase 1's isolation proof is [2026-10-23-cr6-isolation.md](2026-10-23-cr6-isolation.md); this page records
Phase 2, the built feature, with mock and live evidence kept apart.

## What was built

- `code-review:agent`, a local-only main channel (`apps/desktop/src/shared/code-review-agent.ts`,
  `apps/desktop/src/main/engine/code-review-agent/`): `status`, `instructions`, `start`, `stop`.
- A run: main confirms the signed-in `gh` account is the PR key's, reads the repository by id, the pull
  request and every page of its files through the GET-only read transport, reads the pull request again to
  prove the head and target held, writes a snapshot directory of the patches (untrusted framing, omissions
  listed), records the run durably, then runs `ClaudeBackend.runTurn` with `confinement`: the fixed argv
  `REVIEW_CONFINEMENT_ARGS` (`--safe-mode --restricted --tools Read --strict-mcp-config --mcp-config
  {"mcpServers":{}} --disable-slash-commands --setting-sources "" --permission-mode dontAsk
  --permission-prompts none --no-session-persistence`), no permission tool, and an environment without
  `GH_*`, `GITHUB_*`, `MODEX_*`, `CODEX_API_KEY` or `OPENAI_API_KEY`.
- Findings are read from the reply's final `json` block and bound to CR-5's `LineAnchor` only where every
  named line is in the included head-side diff; otherwise they are shown as unverified or without a location.
- Review instructions: one versioned text per Mac; the popover states the scope; each run records the
  version it used.
- UI: C27 (Review with Claude → panel with Start/Stop), C28 and C56 (gear → R3 popover), C54 (Add to chat),
  C57 (Ask about this pull request), C59 (model select). "Add to review draft" puts an anchored finding
  into CR-7's review draft; nothing reaches GitHub without CR-7's preview and submit.

Design: [docs/design/code-review.md, "CR-6 agent review and questions"](../design/code-review.md#cr-6-agent-review-and-questions).

## Mock evidence (synthetic gh, synthetic or scripted Claude; no model, no network)

**Unit** (`pnpm test` in `apps/desktop`, node:test over `dist/test`): 2025 tests, 2008 passed, 0 failed,
17 skipped (platform-gated). New or extended:

- `test/code-review-agent.test.ts` (15): contract validation; snapshot planning and writing (bounds, untrusted
  framing, sanitized file names, 0700/0600 modes); findings extraction and binding; records (versioned
  instructions, per-PR pruning, running → unknown on restart); the service over a fake gh transport and a
  scripted backend: status starts no process; a review's exact read sequence, confinement options, snapshot
  cwd and cleanup, bound findings; a question; instructions version per run; refusals for account change,
  head moved (before and during the file reads), target change, missing CLI, unknown model, busy, nothing to
  review; failure, prompt-refusal and no-reply outcomes; crash → unknown with nothing re-run; disabled and
  storage refusals with fixed texts.
- `test/claude-backend.test.ts`: the confined argv (fixed order, no permission tool, no resume/add-dir/MCP/
  fast on a confined turn) and `confinedEnvironment` stripping.
- `test/code-review-contract.test.ts`: `review`, `ask` and `instructions` follow the connection.
- `test/desktop-service-drain.test.ts`: the agent service drains on quit.

**E2E** (`e2e/code-review-agent.spec.ts`, real Electron, synthetic `gh`, a synthetic `claude` on PATH that
answers `--version` and `auth status`, records each run's argv and environment, and plays a mode: fail, hang
or a scripted stream-json reply): 5 passed.

1. Instructions popover: scope text, focus on open, Escape returns focus, versioned save, survives reload,
   stored in `review-agent/state.json`; no provider start, no write to gh.
2. Review: Start is the only trigger; exactly one `claude -p … --safe-mode --restricted --tools Read …
   --model fable` start with `MODEX_HOME`, `GH_CONFIG_DIR` and `GH_TOKEN` unset and `cwd` under
   `review-agent/runs/<id>/snapshot`; failure shown with its reason; coverage reports the fixture's declared
   11 files against 2 served as "file list cut short"; the snapshot directory is gone afterwards; a reload
   shows the record without a second start; no POST/PUT/PATCH reached gh.
3. Scripted reply: reply text shown without its findings block; two findings, one anchored at
   `src/holds/move.ts:2` ("In the diff"), one unverified; "Add to review draft" adds a line comment to CR-7's
   review draft and nothing is posted; a head move on GitHub refuses a start from the stale page
   ("The pull request's head moved…"); after a reload the run is "Outdated · made for head cccccccc", the
   draft button is disabled, and no second start happened.
4. Question: "Add to chat" quotes a timeline comment into the composer; Ask runs its own turn; the question
   is shown with the answer.
5. Stop and crash: a second start while running is refused `busy` by main; Stop ends the run as "stopped";
   a SIGKILL relaunch mid-run shows the run as "unknown" with the restart reason, two starts in total.

`e2e/code-review-regressions.spec.ts` now opens the Review panel and the instructions popover and proves
neither asks gh for more than the connection check nor starts a provider.

Full E2E suite: see the line at the end of this page.

**Native fixture, opt-in** (`MODEX_CR6_NATIVE=1 node --test test/code-review-isolation.native.test.mjs`,
macOS, Claude Code 2.1.312 cloned into a disposable home under a `sandbox-exec` guard, a scripted
Anthropic SSE provider on loopback with a synthetic key; no account, no real inference): 6 passed. The new
case runs the shipped `REVIEW_CONFINEMENT_ARGS`, imported from the build so they cannot drift, with the
prompt on stdin as Modex writes it. Result: exit 0, two provider turns, advertised tools `["Read"]`; the
injected `Bash`, `Write`, `WebFetch` and `mcp__sentinel__write` calls answered "No such tool available";
the outside-file and symlink reads refused by `--restricted`; the selected file read; no write, hook or MCP
marker. The Phase 1 `--bare` candidate case still passes alongside it; `--safe-mode` replaces `--bare` in
production because `--bare` ignores the person's subscription login.

## Live evidence

**None recorded in the tree.** No authenticated Claude Code run against a real pull request was made in
this PR. The open gate: one authorized smoke on a repository Val names, with the person's own `claude`
login, recording the argv the app used, the snapshot's file list, the reply, the bound findings and the
absence of any GitHub write. Until then the feature's live acceptance stays open, as #325 AC6 allows.

## Remaining gates

- Authorized live smoke (above).
- C82, the access-mode indicator: still open decision 7; the panel states the confinement in words.
- The confinement is Claude Code's own `--restricted` and `--safe-mode`; no OS sandbox is added in
  production. The native fixture shows what the CLI enforces, not what the OS would.
- Codex is not offered for reviews (Phase 1: its read-only sandbox allows shell and outside reads).

## Checkpoint

- Full SHA: recorded in the PR description at hand-off.
- Tests: unit, agent E2E, native fixture as above; full E2E line below.
- Next action: open the PR for review, then the live smoke when Val names a repository.

Full E2E suite (`playwright test`, macOS, 2026-10-28): 477 cases, 470 passed, 7 skipped, 0 failed, 16.2 min.
It ran on the build before a code review's fixes landed (findings-block parsing, unrecorded settled runs,
dispose during a start, Stop without GitHub, anchoring against included patches only, local paths cut from
trail titles and failure details, wider credential stripping, bounded renderer polling); the unit suite and
the agent and regression specs were rerun on the fixed build (see the PR description for those counts).

## Review repair: unconfirmed process exit and provider disclosure

Independent review of `fecdfcfb3dd9b5496798d562b6b6b65c7952dc38` found that an unconfirmed backend stop was reported as stopped and released its run slot and snapshot. The repair preserves the backend receipt, reports the outcome as unknown, retains the snapshot and both per-PR and global concurrency ownership, and refuses service disposal while exit remains unconfirmed. Retained receipts reload before another start after a restart and are not pruned as settled history. A record left running by a crash or a failed receipt write also retains ownership with an unknown outcome, since child exit was not established. Signal zero is observation only: only `ESRCH` releases the hold, and that observation leaves the review outcome unknown while preserving the original receipt. Missing PIDs, permission errors and reused PIDs conservatively retain the hold; this repair does not signal recovered PIDs or provide an override for unknown ownership.

The review and question forms now state that Claude Code sends the snapshot, review instructions and question to its configured inference provider. Modex stores the run record locally. The restriction is on shell and network tools, not on the inference provider's network traffic.

The initial regression failed with actual `stopped` versus expected `unknown`. A second regression using a real disposable child caught the same false completion after a later exit observation. The tests also cover failed-plus-unconfirmed receipts, a missing PID, record reload, blocked replacement and rejected disposal. Logs are retained outside the worktree under `~/Documents/Codex/artifacts/modex-land-and-prune/cr6-repair-*.log`. A first full verification chain was intentionally interrupted (exit 130) when independent review found the failed-receipt-write restart hole; its regression failed by permitting a replacement run. At that checkpoint, fresh full build, unit, typecheck and E2E validation was still in progress. Existing live-provider and human acceptance gates remain open.

After that repair, the build, 20 focused tests, full unit tests (2,193 passed, 23 skipped, zero failed) and typecheck passed. The subsequent full E2E attempt failed at the crash/relaunch case because its old expectation and teardown did not account for the retained unknown ownership; that run was deliberately interrupted (exit 130), and its trace and error context are preserved in `cr6-first-e2e-failure/`. The fixture now asserts the unknown result, disabled replacement controls and main-side busy refusal, and cleans up only its recorded synthetic child and fixture Electron process. All five agent E2E cases passed. Independent review then found a PID-log capture race; polling for both valid PID entries before relaunch fixed it, and the crash case passed again (1/1). Final fixture review found no blocking findings. The subsequent full root E2E result is recorded in `cr6-repair-e2e-after-fixture.log` and described below; the earlier full-suite failure remains part of the evidence.

The second full desktop E2E run finished with 468 passed, seven skipped and two failed (20.2 minutes); the root site stage did not run. The agent crash case read the synthetic start log before the second child wrote it. The repaired fixture polls for exactly two starts before polling the PID list. The separate Canvas full-view case kept the main panel visible after clicking Full view; its cause remains unconfirmed. Both traces are preserved under `cr6-second-e2e-failure/`. Three focused repetitions of each case then passed (6/6); Canvas was unchanged, so those passes do not establish a fix for its full-suite failure. PR #422 subsequently merged as `b64361750983068160fe95293192ccea03000f88`; this repair was rebased onto that main commit for separate delivery and revalidation.

On main-based repair `ba23f5c195e41ab91b345e43df775af9de82ae9c`, build, unit tests (2,196 passed, 23 skipped) and typecheck passed. Full desktop E2E finished with 469 passed, seven skipped and one failed (21.0 minutes); the site stage did not run. Both the repaired crash case and unchanged Canvas case passed. The IPC case lost its page during the inbox request after a successful connection; the trace proves cleanup began afterward, but contains no process-exit or renderer-crash evidence. Its trace is preserved in `cr6-main-e2e-failure/`. The fixture now attaches bounded lifecycle events and stderr before cleanup without changing assertions or timeouts. Independent review found no blocking issue in that diagnostic change; three isolated repetitions passed (14.5 seconds). These passes do not establish the cause of the original closure or clear the failed full-suite result. Raw diagnostic stderr must be inspected before any public sharing.

On diagnostic source `4c5eaee2472e1192c8030ead32b920ab276ad12f`, the fresh root `pnpm test:e2e` run exited zero: 470 desktop tests passed, seven skipped (23.6 minutes), followed by all seven site tests passing (12.8 seconds). The crash, Canvas and IPC cases passed. The complete log is preserved as `cr6-diagnostics-full-e2e.log` outside the worktree. This is passing full-suite evidence for that source; it does not establish the causes of the earlier Canvas and IPC failures or replace their preserved evidence. Production source is unchanged from the build, unit and typecheck checkpoint above. Hosted checks, protected merge and live-provider/human acceptance remain separate gates.
