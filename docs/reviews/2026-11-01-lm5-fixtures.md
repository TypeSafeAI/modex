# LM-5 fixture-level AC1 compaction, AC3, AC4 and AC5 (#380), 2026-11-01

Issue #380 remains open. This delivery was built on `main` at `0a8c513baa95ef6cf7e5f833e4aae468ae62a5e1` and rebased onto `b785054e88836ac9df5ca917425031ab697d4d30` on 2026-11-03; see [the rebase section](#rebase-onto-b785054). It closes the
fixture-level gaps left after the six earlier LM-5 deliveries (#423/#424, #447, #448, #461, #462, #465). It
doesn't admit product local execution: `main/index.ts` still constructs no `LocalExecution`, so a built app
refuses every local selection exactly as before.

Kinds of evidence are kept apart:
- **Fixture:** a scripted `codex app-server` (fake process).
- **Wire:** the installed `codex-cli 0.166.0` against a scripted loopback Responses server in the test process,
  with no model and no inference service.
- **Not run:** a real runtime, a network-denied canary, a managed Mac.

## What changed

- **Truthful local 500 (AC4).** On any HTTP 500, codex-cli 0.166.0 reports its cloud text "We're currently
  experiencing high demand, which may cause temporary errors.", with `codexErrorInfo: "internalServerError"`. From a
  loopback server, that isn't what happened. `LocalExecution` now reports "The local server returned an internal
  error (HTTP 500). Check its log: it may have run out of memory or crashed while loading the model. Modex didn't
  retry the turn or switch models." Codex's own text stays in the turn's detail.
- **Stream retries admitted only at 0 (AC4).** Modex already passed `stream_max_retries=0`, but admission
  checked only `request_max_retries`. Admission now refuses any other effective `stream_max_retries`. With
  retries on, Codex re-sends the whole request after a dropped stream, a 500 or a 503 (negative control below).
- **Compaction keys governed (AC1).** These codex-cli 0.166.0 keys weren't governed:
  - `compact_prompt`, which replaces the instructions a compaction sends;
  - `model_auto_compact_token_limit_scope`, `model_post_turn_compact_threshold_percent` and
    `model_async_compact_threshold_percent`, which change when compaction runs.

  A managed layer could set any of them. They are now governed like `developer_instructions`: a layer other
  than Modex's session flags that sets one refuses the child by name. `experimental_compact_prompt_file` was
  already governed through the `experimental_` prefix.
- **Local target set only from this Mac's window (AC5).** `ThreadRunner.updateThread` used to strip
  `localTarget`/`localContextTokens` only when `by === "paired-desktop"`. A caller that named no client kept
  them: the dev browser transport (`commands.ts:110`), demo and any future caller. It's now an allow-list:
  only `by === "desktop"` (index.ts's `answeredFrom` for a native IPC event) may select, change or clear a
  local target. The pins on a local thread (model, backend, effort, Auto, Plan) still throw for every caller.
- **Status line.** `docs/local-models.md`'s LM-5 slice 1 line now also says local execution is still unadmitted. Main
  had already corrected the line's old `lm5-policy` location before this rebase.

## AC1: where a local child's compaction goes (wire)

`AC1 compaction` in `test/local-codex-native.test.ts`. The first response asks for `cat fixture.txt` and reports
31,000 tokens of usage, above the 85% limit (27,852) of a 32,768-token window.
[Receipt](2026-11-01-lm5-fixtures/ac1-compaction.json):

| # | Request | What it was |
| --- | --- | --- |
| 1 | `POST /v1/responses`, bearer, `scripted-fixture-model` | the turn; the server asks for the shell read |
| 2 | `POST /v1/responses`, bearer, `scripted-fixture-model` | **compaction**: the history including the tool output, then Codex's "You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary…" as the last user input |
| 3 | `POST /v1/responses`, bearer, `scripted-fixture-model` | the turn continues on the compacted history ("Another language model started to solve…" plus the server's summary) and completes |

The recording loopback server observed inline compaction on 0.166.0 for a custom Responses provider, on the same path and selected model with the connection's token. It saw no `/responses/compact` request or other path. The test fails if a request observed by this server uses another path or model, or if it observes no compaction. It does not monitor other destinations and does not establish the absence of cloud traffic.

Codex clamps the auto-compact limit to the window. With `model_auto_compact_token_limit` set to 8× the window,
it still compacted at the same point. So a too-high limit can't defer compaction past the window.

AC1 isn't complete. This shows where the fixture server saw native compaction arrive; it doesn't establish the
only destination. It doesn't run against a real local server or with the network denied.

## AC3: two profiles, one service; a stopped wait sends nothing

- **Existing coverage:** "one turn at a time reaches a port…" (IPv4, IPv6 and mapped aliases of one port share
  one slot, and a stopped wait spawns nothing).
- **New fixture:** two profiles with different labels, runtimes (`ollama` and `responses`), paths and tokens,
  at the same `127.0.0.1:18501`, share one slot. Results:
  - the cancelled queued turn spawns no child, and its prompt appears in no `turn/start`;
  - a profile on another port runs in parallel.
- **New wire test:** two profiles for one recording server. The first turn is held at the server; the second is
  queued and then stopped. The server saw one request, the first turn's, and zero requests carrying the queued
  prompt. No child opened for the stopped thread. [Receipt](2026-11-01-lm5-fixtures/ac3-queued-cancel.json).
- **Unqualified subagents** stay covered by #448: both effective flags must be false before any thread opens.

## AC4: failures after a tool ran (wire)

`AC4 (<mode>)` in `test/local-codex-native.test.ts`. The scripted server asks for one side-effecting command
(`echo ran >> tool-count.txt`), then fails the request carrying its output. Every mode asserts:

- the turn isn't completed;
- exactly two requests, both to `/v1/responses` for the selected model (no retry, no model switch);
- the command ran once, with one tool dispatch.

The test waits 1.5 s after the turn ends to catch a late retry. Receipts are in `2026-11-01-lm5-fixtures/ac4-*.json`.

| Mode | Server behaviour | Turn | Error shown |
| --- | --- | --- | --- |
| overflow-http | 400 `context_length_exceeded` (JSON) | failed | the server's JSON error |
| overflow-stream | `response.failed` with `context_length_exceeded` | failed | "Codex ran out of room in the model's context window…" |
| oom-500 | 500 "CUDA error: out of memory" | failed | the local-server text above (was "high demand") |
| unavailable-503 | 503 "model is loading" | failed | "unexpected status 503 Service Unavailable: model is loading, url: …" |
| dropped | stream starts, partial text, socket destroyed | failed | "stream disconnected before completion…" |
| child-exit | stream held; the test SIGKILLs the codex child | failed | "codex app-server exited (null)" |
| stop | stream held; the person stops | interrupted | none |

For every mode, the recording loopback server observed only the selected model and no retry during the observation window. These fixtures do not monitor other destinations and cannot establish that the child made no cloud requests. Separate runner tests cover the runner's refusal to apply credit fallback or cloud retry to a failed local turn ("a failed local turn stays failed…").

## AC5: entry points

Every turn reaches `ThreadRunner.runTurn`. On a local thread, `runTurn` revalidates the target, requires backend
`codex` with the target's model, refuses Plan and images, and ends the turn with a notice otherwise.

| Entry | Reaches | Can carry a local target? | Regression |
| --- | --- | --- | --- |
| `thread:update` from this Mac (`by: "desktop"`) | `updateThread` | yes; validated by `LocalExecution.validate`, pins forced | "selecting a local target pins…", "a forged, stale or unloadable…" |
| `thread:update` from a paired desktop, the phone, the dev transport, or no client | `updateThread` | **no** (allow-list, new) | **new** "AC5: only this Mac's own window…" (select, clear, window, pins, for 4 callers) |
| `thread:send`, phone `/v1/threads/:id/send`, `drafts:send` | `send`/`sendDurably` → `runTurn` | text and attachments only | "a forged, stale or unloadable…" |
| `thread:retry` | `retry` → `runTurn` | none | **new**, in the AC5 test: a stale target on retry reaches neither backend |
| `thread:create`, phone create, `drafts:create` | `createThread` | no; `ThreadCreationOptions` has no local fields | **new** case in "invalid or unsupported drafts…": a saved draft with `localTarget` or `localContextTokens` is refused |
| routines | `sendUnattended` | refused for a local thread (#461) | "main's local-only rule holds…" |
| Auto, credit fallback, naming, follow-ups, Jev | skipped for local, and refused at each chokepoint (#461) | n/a | same |
| phone approvals policy | `updateThread({ approvals }, { by: "phone" })` | no | n/a |

Left for Val (design, not defects):
- **Clearing to cloud.** This Mac's window can clear a local target with `localTarget: null` whenever no turn
  runs. A stale window could do it, and the next send would run on cloud. That is an explicit choice made on
  this Mac, but it carries no revision check.
- **Remote sends.** A phone or paired-desktop send on a local thread runs the local turn. Only unattended
  (routine) turns are refused. Should a local turn need someone at this Mac?
- **Mode.** The approval mode (`chat`/`agent`/`full-access`) isn't pinned on a local thread, and a paired
  desktop may change it.

## Negative controls (red before green)

All logs are in `~/.claude/task-evidence/lane-d-2026-11-01/`.

| Test | Red how | Log |
| --- | --- | --- |
| fixture: local 500 is truthful | before the fix: the error was Codex's "high demand" text | `red-ac4-500-fixture.txt` |
| wire: AC4 (oom-500) | before the fix, same | `red-ac4-500-wire.txt` |
| admission: stream retries | before the fix: "Missing expected exception: stream retries" | `red-stream-retries.txt` |
| wire: AC4 no-retry assertions | retries set to 2 in the flags and admission: oom-500, unavailable-503 and dropped failed, with more than two requests. Overflows aren't retried by Codex either way | `negctl-retries-on.txt` |
| fixture: AC3 two profiles | slot keyed by connection ID: the new test and the alias test both failed | `negctl-ac3-slot-per-profile.txt` |
| runner: AC5 allow-list | before the fix: "a patch from no client selected a local target" | `red-ac5-allowlist.txt` |
| recovery: local draft settings | local keys allowed in draft settings: the test failed | `negctl-ac5-drafts.txt` |
| admission: compaction keys | before the fix: `compact_prompt` not governed | `red-ac1-compaction-keys.txt` |
| wire: AC1 compaction | fixture usage under the limit (compiled test only): "Codex did not compact past its limit" | `negctl-ac1-usage-below-limit.txt` |

## Verification

- **Focused suites:** `local-run-policy` 16/16, `local-model-execution` 15/15, `runner-local-models` 15/15,
  `update-recovery` (invalid drafts case).
- **Native suite with `MODEX_LM3_WIRE=1` on codex-cli 0.166.0:** the LM-3 wire receipt, the redirect check, all
  seven AC4 modes, AC1 compaction and AC3 queued-cancel passed. AC1-live was skipped: it needs a person's server.
- **Wire receipt for #379 on 0.166.0** ([wire](2026-11-01-lm5-fixtures/wire.json),
  [redirect](2026-11-01-lm5-fixtures/redirect.json)). It matches 0.164.0:
  - two `POST /v1/responses`, bearer, model `scripted-fixture-model`;
  - offered tools `exec_command`, `write_stdin`, `request_user_input`, `get_goal`, `create_goal`,
    `update_goal`, with no `view_image`, web search, plugin or MCP tools;
  - the sentinel returned in the second request, and the token never in model input;
  - layers `sessionFlags`, `user` and `system`, with no managed requirements;
  - redirects: a 307 is still followed as a `POST` with the full 29,124-byte body and no `Authorization`, and
    a 302 as a bodyless `GET`. Recorded, not prevented.
- **Load.** Other lanes ran Playwright at the same time (load average 27–134). Some wire runs failed at Codex's
  5-second `initialize` before any request; they were re-run, not counted.
- **Full suite on the original base:** `pnpm build && pnpm test` exited 0. The desktop suite ran 2,127 tests: 2,098 passed, 29 skipped, 0 failed. The current result is in [the rebase section](#rebase-onto-b785054).

## Still open

- **AC2:** the network-denied offline canary. It needs Val's authorization and an installed local coding model;
  Ollama 0.40.13 lists none.
- **AC4 on a real runtime:** overflow, OOM and restart.
- **AC1 live:** a real local server.
- **AC6 managed-policy precedence:** no managed Mac has run it.
- **Product admission** of `LocalExecution` in `main/index.ts`: Val's decision. Its brief is on #380.

## Review repair: early AC3 termination

The AC3 server-arrival wait races the first turn result, and the first turn receives the test cancellation signal as well as its 90-second deadline. An early admission, startup or cancellation result therefore fails the fixture with that result and enters cleanup. Before the repair, replacing the first turn signal with an already-aborted signal left the fixture pending until an external 12-second deadline terminated it. After the repair, the same negative control failed promptly with `status: interrupted` (about 15 ms) and the process exited normally with test failure. The unmodified installed-Codex wire fixture passed in about 2 seconds. These checks establish fixture termination and its normal queued-cancel path, not live-model or offline acceptance.

Repair validation: `pnpm build && pnpm test` exited 0, with 2,281 passes and 35 skips across the full unit suite. Independent review found no blocking findings; its minor overbroad AC1 test title was corrected. No UI code changed and no additional E2E suite was run for this fixture/documentation repair. Main merge, product admission and native runtime acceptance remain separate gates.

## Rebase onto `b785054`

On 2026-11-03 the three commits were rebased onto `main` at `b785054e88836ac9df5ca917425031ab697d4d30`. Only two doc lines conflicted: the slice 1 status line in `docs/local-models.md`, and `docs/status.md`'s In flight list, which keeps `main`'s entries. CF-7's checkpoint and date changes dropped out because `main` already has them.

An independent review of the rebased diff found no blockers. It confirmed the AC3 repair and that the rebase lost nothing, including #467's account code in `runner.ts`. Its minor findings are fixed here: the standing doc and the AC4 test title claimed more than the recording server observed, and a local 500 reported only by Codex's `error` notification still showed the "high demand" text. That case has a new test, which failed with the fix removed. The always-false `hasCompactPrompt` field is gone from the test. The AC4 receipts in this folder were recorded before that and still carry it; ignore it there. The native receipts were not re-taken.

Validation before the final rebase over #488, which changed only worktree tooling (`c991d27`, since rewritten): `pnpm build && pnpm test` exited 0. The desktop suite ran 2,151 tests: 2,122 passed, 29 skipped, 0 failed. No UI code changed, so no E2E suite ran. Merge, product admission and native runtime acceptance remain separate gates.
