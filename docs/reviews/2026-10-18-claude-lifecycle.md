# Claude Stop, draining and withdrawn requests on `claude -p` (CF-2, #275)

Modex keeps driving Claude through `claude -p` stream-json (#250 closed on that policy). This
change makes Stop, process exit and cancelled permission prompts truthful on that backend.
There is no Agent SDK and no API mode.

- Base: `main` at `89c98f280292b13fd9b1c7af1bf2fe65cd2fa0d1`.
- Branch: `cf2-claude-lifecycle`, with these commits:
  - `62fccb9`: failing regressions, plus the new interfaces declared without behaviour.
  - `7e78eb9`: the backend.
  - `feb2166`: the runner and UI.
  - `62ac15c`: fixes from independent review.
  - `d11cdb6`: the title-naming E2E fixture answers the native interrupt.
- Tested app code: `62ac15c6bcde511c1bb6b4d1048a5519dec534b2`. `d11cdb6` changes only an E2E fixture, and the commit after it adds only these records.

## CLI versions

| Install | Version | Note |
| --- | --- | --- |
| `~/.local/bin/claude` (native installer) | 2.1.302 | Probed live below. Earlier in Modex's search than nvm when PATH is minimal (Finder launch). |
| `~/.nvm/versions/node/v24.18.1/bin/claude` (npm) | 2.1.289 | First on a terminal's PATH. Its stream-json shapes match the existing captured fixtures. |

## Live observations (Claude Code 2.1.302, Haiku, `--effort low`)

These were captured on 2026-10-18 between 06:19 and 06:28 UTC. A Node probe ([`probe.mjs`](2026-10-18-claude-lifecycle/probe.mjs)) spawned the CLI with Modex's own flags in a throwaway directory and timestamped every stdout line. The [captures](2026-10-18-claude-lifecycle/) keep each line's type, ids and a text prefix. On the seventh probe the account reached its weekly usage limit (resets midnight America/Chicago). Nothing after that is live evidence.

| Scenario | What the CLI did |
| --- | --- |
| Interrupt while a `can_use_tool` waits | `control_cancel_request` for the prompt, then `control_response` success `{still_queued: []}`, both within 8 ms. Then a rejected `tool_result`, the user text `[Request interrupted by user for tool use]`, and `result` `error_during_execution`, `is_error: true`, `terminal_reason: aborted_tools` (+96 ms). A `control_response` for the cancelled request, sent 4 s later, produced nothing. After stdin ended it exited with **code 1** (0.41 s). |
| Interrupt while streaming text | Ack within 9 ms, then a final `assistant` message holding the partial text, `[Request interrupted by user]` and `result` `error_during_execution` / `aborted_streaming` (+29 ms). |
| Interrupt while an approved Bash `sleep 20` runs (stdin left open) | Ack within 2 ms, but **no result for 5 s**, until stdin was ended. 0.21 s after that came the rejected tool result and `aborted_tools`. Exit code 1 at 0.9 s. |
| Interrupt and end stdin together, Bash running | Ack within 2 ms, result at +2.65 s, exit code 1 at +3.15 s. |
| Interrupt and end stdin together, streaming | Ack within 4 ms, result at +17 ms, exit code 1 at +0.62 s. |
| Weekly limit reached | Synthetic assistant text and `result` `subtype: success`, `is_error: true`, `terminal_reason: api_error`. The process stayed up until stdin ended, then exited with code 1. |

`system/init` advertised `capabilities` including `interrupt_receipt_v1` and
`interrupt_cancel_queued_v1`.

The 2.1.302 binary's own protocol schema documents the following:
- `control_cancel_request` withdraws an in-flight request. The receiver stops waiting and ignores later answers.
- `keep_alive` is a heartbeat that receivers must ignore.
- `interrupt` "interrupts the currently running conversation turn".

## Root causes on `main` and what changed

| Fault on `main` (reproduced) | Change |
| --- | --- |
| Stop sent SIGTERM at once and dropped every later line, including the turn's final text snapshot. | Stop writes `control_request {subtype: "interrupt"}` and ends stdin. Late lines are still read. The interrupted `result` is no failure, and exit code 1 after Stop is no failure. |
| The turn settled only on `close`. A process that never closed (stuck, or a descendant holding the pipes) held Stop, deletion and quit forever. | The turn settles on exit plus a bounded drain (1 s). Stop escalates to SIGTERM at 1.5 s and SIGKILL 1.5 s later. With no exit 2 s after that, it reports `unconfirmed` with the pid. |
| `control_cancel_request` hit `default:`. The card stayed actionable, its pending count held a drained turn open, and a late answer was written. | The request's abort signal reaches the sink. The runner closes the card once (`answer: "no"`, `withdrawn: "native"`), the thread stops waiting, and nothing is written back. |
| A late answer after the turn settled wrote to the ended stdin: an uncaught `ERR_STREAM_WRITE_AFTER_END` in main. | Writes go only to an open stdin of an unfinished turn, and EPIPE is absorbed. |
| `keep_alive` re-armed the idle window. | It is ignored. |
| The last stdout line, if unterminated at exit, was lost. stderr was decoded per chunk (`cl��`). A failed result settled before its stderr and exit code arrived. A signal death read "exited with code null". | Flush at stdout end and a stderr `StringDecoder`. A failed result waits up to 1 s for the exit. `was terminated by SIGKILL`. |
| Failure details copied `argv`, including the Pages/Knowledge/Images MCP route token, which is reused across a thread's turns. | `/mcp/<token>` becomes `/mcp/[redacted]` in the report. |
| Stop and turn end labelled unanswered cards "Denied". | They read "Not answered — the turn was stopped" / "… ended first". A native withdrawal reads "Withdrawn — the agent no longer needs an answer". |

Unchanged, and their existing tests pass:
- holding a zero-model-call result after `--resume` (also covered by a new runner case);
- the silent-turn failure card (also covered by a new runner case);
- the background-work hold and cap;
- routine refusals;
- job ownership;
- draft recovery.

### Timing budgets

| Event | Before | Now | Why |
| --- | --- | --- | --- |
| SIGTERM | at Stop | 1.5 s after Stop | Live, interrupt plus EOF: exited 0.62 s after Stop while streaming. A turn waiting on a prompt exited 0.41 s after its input ended. A running Bash call took 3.2 s and still gets SIGTERM. |
| SIGKILL | 1.5 s after Stop | 1.5 s after SIGTERM | Unchanged step. |
| Given up as unconfirmed | never | 2 s after SIGKILL | No exit was ever bounded before. |
| Failure report | at the failed result | at exit, at most 1 s later | Keeps the CLI's last stderr lines and exit code. |

No test timeout was raised.

## Interfaces (additive; coordinated with CF-1 #274)

- `TurnSink.approval(req, withdrawn?: AbortSignal)`.
- `TurnResult.stop?: StopReport`:
  - `outcome`: `exited | terminated | killed | unconfirmed`;
  - `exitCode`, `signal`, `pid`, `ms`, `graceMs`.
- Approval item: `withdrawn?: "native" | "stopped" | "ended"`. `answer: "no"` is kept, so older clients render it closed.
- `RunnerOptions.isProcessAlive` (a test seam).
- `ClaudeBackend` timing knobs.

Late callbacks are scoped by what already identifies an execution:
- the backend's per-run closure, inert after `finish`;
- the runner's abort-identity `active()` check;
- unique card ids.

No turn/attempt/generation ids were invented. CF-1 owns that contract (branch `cf1-contract`).

These interface changes were sent on 2026-10-18 to:
- the tracker #273 session, which received them;
- the CF-1 session, where a direct message expired undelivered.

That is why they are also posted on #274.

## Red, then green

`62fccb9` (tests, types only) against `main`'s behaviour: all 20 new unit cases failed for the intended reasons. Examples:
- "Stop asks the CLI to interrupt its turn" — actual 0;
- `ERR_STREAM_WRITE_AFTER_END`;
- `'Erreur : cl�� refusée ✗'`;
- the gate case shows an `ask` card;
- unconfirmed and drain cases time out.

One case of mine failed for the wrong reason: a 60 ms wait outlasted a 40 ms idle window. It was corrected before any implementation. The new E2E failed at its first assertion: the stopped card read `Denied`.

At `feb2166`:
- `node --test` over the lifecycle, Claude backend and background suites: 58/58 pass.
- `e2e/claude-lifecycle.spec.ts`: 1/1 pass (29.8 s).

The review fixes in `62ac15c` were red first (3/3 failing for the reported reasons). At `62ac15c`, 147/147 pass across the lifecycle, Claude backend, background, runner, routines and subagent suites.

### Full checks at `62ac15c`

Run on macOS (Apple Silicon), Node 24.18.1 and pnpm 10.34.5, from 2026-10-18 07:23 UTC:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm build` | pass (24 s) |
| `pnpm typecheck` | pass (14 s) |
| `pnpm test` | pass (279 s), broken down below |
| `pnpm test:e2e` | desktop: 317 passed, 3 skipped, 1 failed (below). The site suite never ran, because the desktop step failed. |

`pnpm test`, by suite:

| Suite | Result |
| --- | --- |
| worktrees | 109/109 |
| core | 16/16 |
| desktop | 1,494 passed, 16 skipped, of 1,510 |
| desktop native/update | 21/21 |
| site | 10/10 |
| store-desktop | 16/16 |

The one E2E failure was `titles.spec.ts › claude chat titles › a manual rename cancels pending naming and survives relaunch`:
- **What it waited for:** a marker that its scripted Claude wrote only on SIGTERM.
- **Why it never came:** Stop now sends the native interrupt and ends stdin, and the fixture exited cleanly before any SIGTERM was due. The naming run was cancelled and the title stayed manual.
- **Fix (`d11cdb6`):** the fixture now answers the interrupt as 2.1.302 does and records the cancellation there, as its Codex branch already does for `turn/interrupt`. `titles.spec.ts` then passed 8/8 against the `62ac15c` build.

At `d11cdb6`, `pnpm test:e2e`, run 07:49–08:07 UTC:
- **Desktop:** 318 passed, 3 skipped, 0 failed, in 17.4 min. The skips are the opt-in real Open Knowledge specs. The run included `claude-lifecycle.spec.ts` and all 8 `titles.spec.ts` cases.
- **Site:** it could not launch at first, because Playwright's Chromium headless shell (build 1243) was not installed on this Mac. After `pnpm exec playwright install chromium`, `pnpm --filter @modex/site test:e2e` passed 7/7 at the same SHA.

Of the 16 desktop skips, 15 are Windows-only native cases (npm shims, job and PTY descendant cleanup, strong admission). The other is the opt-in pinned OpenKnowledge integration.

On a machine with load average around 200, an earlier full desktop run at `feb2166` had one failure in `knowledge.test`, a different case on each rerun (`kill EPERM`, then "Missing expected rejection"). It passed in both later full runs. That file does not import anything this change touches.

An earlier full E2E run at `feb2166` was stopped deliberately after 106/321 tests, all passing. The review fixes then changed the backend, and `dist/` had been rebuilt mid-run, so that run is not counted.

## Independent review

A read-only review of `62fccb9..feb2166` found nothing high-severity. It confirmed:
- every Stop path is bounded;
- requests settle once;
- late callbacks are inert;
- Codex and mock logic is unchanged.

It found three low-severity faults, each fixed test-first in `62ac15c`:

- **Stop during a failed result's drain window.** Stop pressed in the 1 s after a failed `result` reported a clean stop: the failure card was lost and escalation was cancelled. Now the failure stands, and Stop's SIGTERM/SIGKILL still runs after the turn settles.
- **A later success result.** A success `result` inside that window turned the failure into a completion. Now it is ignored.
- **Synchronous launch failure.** A launch that throws synchronously, such as an unsupported Windows launcher, still copied the raw argv. Now it is redacted too.

A fourth point stays as a known limit:
- An `unconfirmed` pid is checked with signal 0 when the thread is deleted.
- If that pid were reused by another process before then, deletion would stay refused until Modex restarts.
- An unconfirmed stop needs a process that survives SIGKILL, so this is very unlikely.

## Acceptance criteria → evidence

| Criterion (#275) | Evidence |
| --- | --- |
| Native interrupt, slow ack, forced termination, repeated Stop: explicit outcomes, no duplicate terminal event | Unit cases:<br>- "Stop interrupts Claude natively…" (`exited`, no signal)<br>- "…terminates a Claude that does not exit…" (`terminated`, SIGTERM only after the grace)<br>- "…kills a Claude that also ignores SIGTERM"<br>- "…never confirms its exit… unconfirmed"<br>- "Stop pressed while a failed result drains keeps the failure and still ends the process"<br><br>Runner cases:<br>- "Stop with a pending card…" (Stop pressed 3×: one interrupt, one notice, one `idle`)<br>- "a Stop Claude does not acknowledge says how Modex ended it"<br><br>E2E steps 1 and 3. |
| Cancelling a pending request removes its actionability; a late answer cannot execute it or satisfy a later request | Unit cases:<br>- "A permission request Claude cancels is withdrawn…"<br>- "An answer that arrives after the turn settled…"<br><br>Runner cases:<br>- "a card Claude cancels becomes inert…" (late `answer()` on the old card while r2 waits: nothing written for r1 or r2)<br>- "a request withdrawn while the approval gate is still deciding never shows a card"<br><br>E2E steps 1 (late `thread:answer` over IPC) and 2. |
| Late background notifications and zero-model-call results do not finish the next turn; genuine empty outcomes still fail visibly | Runner "a resumed session's replayed background result…" (held, then the silent run gets the `ended the turn without replying` card).<br>Runner "an unconfirmed stop…" (the old process's late success does not complete or write into the new turn).<br>Existing `claude-background` replay cases pass. |
| Split JSON/UTF-8 and stderr just before exit survive bounded draining; exit/signal reported without credentials | "Split JSON lines, split UTF-8…"<br>"A failure result waits briefly for stderr…"<br>"Output after exit is drained…"<br>"A process killed by a signal says so"<br>"Failure details name the MCP routes without their capability tokens"<br>"A launch that throws reports its argv without MCP route tokens"<br>"A success result inside a failure's drain window does not turn the failure into a completion" |
| Deletion waits for the owned process; another thread is not stopped | Runner "deleting a thread stops only its own Claude…" (deletion waits; the other CLI gets no interrupt and completes).<br>Runner "an unconfirmed stop keeps the worktree…" (deletion refused with the pid; worktree kept; allowed once the process is gone). |
| Live, fixture, CI and platform evidence kept apart | This document. |

## Not established here

- **No live model Stop through the Modex UI.** The account hit its weekly limit mid-probe. Everything through Modex itself used scripted executables shaped on the live captures. To rerun after the reset:
1. Start a Claude thread in Agent mode and ask for `sleep 20 && touch x`.
2. Approve, then press Stop.
3. Expect the thread to go idle within about 3 s with no failure card, and with exactly one stop notice. Since 2.1.302 took 3.2 s to abort a running Bash call, that notice will likely be "…so Modex terminated it."
4. Then send a `--resume` turn and expect it to answer normally.
5. Repeat, pressing Stop while the permission card is still pending. Expect "Not answered — the turn was stopped".
- **Windows and Linux.** The interrupt is protocol-level, so it applies everywhere. The SIGTERM/SIGKILL escalation and the `unconfirmed` probe were exercised only on macOS. Windows launches through `cli-supervisor.exe`, where `kill` semantics differ.
- **The Companion** still renders a withdrawn card as "Denied", because its item projection does not carry `withdrawn`. The card is inert there: answering returns 409. Carrying the reason to paired clients belongs to CF-6 (#279).
- **Reused pids:** an `unconfirmed` pid that the OS reuses keeps deletion refused until Modex restarts (see the independent review above).
- **Stop does not use `cancel_queued`.** Modex sends one message per process, so nothing is queued.
