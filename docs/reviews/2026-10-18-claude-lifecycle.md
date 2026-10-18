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
  - `f0b383b`: these records.
  - `6856bf3`: merge of `main` at `7780093`, which landed CF-1 (#282, the conversation-event contract).
  - `172b13f`: a tool call Stop interrupted reads `interrupted`.
  - `20a1eea`: records after the CF-1 merge.
  - `52b159a`: merge of `main` at `8e26534`, which landed CF-4 (#284, typed turn layout). No conflicts.
  - `bab1e10`: the opt-in live acceptance spec and its first results.
  - `a6ea0b0`: merge of `main` at `fb76aac`, which landed the first half of CF-6 (#285, typed state through the journal and phone). Only `docs/status.md` conflicted.
  - `2597393`: the live spec requires a real stop on every step, plus these records.
  - `7c9d62c`: merge of `main` at `d3711c6`, which landed the first part of CF-5 (#287, command evidence and output bounds). No conflicts.
  - `449f660`: records for `7c9d62c`.
  - `13faaeb`: merge of `main` at `f6976df`, which landed the first part of CF-7 (#289, plans and task records). Only an import line conflicted.
  - `3b1c1be`: records for `13faaeb`.
  - `4679fb5`: merge of `main` at `04b7ec7` (#292, steward docs). Docs only.
  - `61cc65d`: merge of #291, which Val authorized. It is the stacked repair from another session, keeping a turn that failed before Stop owned until exit is confirmed (see "Failure before Stop" below).
  - `305fca3`: records for `61cc65d`.
  - `31de358`: merge of `main` at `d3dfe76` (CF-8 first part, #294: end-to-end conversation acceptance, including a Stop through the `claude -p` adapter). No conflicts.
- Fully checked code: `61cc65dccb5774aa6ed7fad27bfafc6092577b2b` (local and CI, below).
- `31de358` adds only CF-8's acceptance spec and docs from `main`. At `31de358`, `conversation-fidelity.spec.ts` passes against CF-2's interrupt-then-grace Stop, and so do `claude-lifecycle` and `titles`: 13/13. PR CI covers this head in full; its result is recorded on #275.

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

## Interfaces (additive, on CF-1's contract)

- `TurnSink.approval(req, withdrawn?: AbortSignal)`.
- `TurnResult.stop?: StopReport`:
  - `outcome`: `exited | terminated | killed | unconfirmed`;
  - `exitCode`, `signal`, `pid`, `ms`, `graceMs`.
- Approval item: `withdrawn?: "native" | "stopped" | "ended"`. `answer: "no"` is kept, so older clients render it closed.
- `RunnerOptions.isProcessAlive` (a test seam).
- `ClaudeBackend` timing knobs.

Late callbacks are scoped by what already identifies an execution:
- the backend's per-run closure, inert after `finish`;
- the runner's `active()` check, which compares abort identity and, since CF-1, the current attempt;
- each Claude process's runtime id on native refs (CF-1);
- unique card ids.

CF-2 adds no turn/attempt/generation ids of its own; CF-1 owns that contract.

CF-1 landed while this branch was under test, and `6856bf3` merges it:
- Backends now report through `observe`; CF-2's withdrawal signal, `stop` report and `withdrawn` reason ride beside it unchanged.
- One mapping changed in `172b13f`. After Stop, Claude closes each call it interrupted with an error `tool_result` ("The user doesn't want to proceed with this tool use."). That result now settles the tool as `interrupted` instead of `failed`, and the Claude table in `docs/conversation-events.md` says so.

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

### Final checks at `61cc65d` (up to date with `main` at `04b7ec7`, #291 merged)

Run on macOS (Apple Silicon), Node 24.18.1 and pnpm 10.34.5, 12:52–13:25 UTC. Every check passed, with no reruns needed:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm build` | pass (70 s) |
| `pnpm typecheck` | pass (52 s) |
| `pnpm test` | pass (358 s), broken down below |
| `pnpm test:e2e` (desktop) | 329 passed, 4 skipped (3 opt-in Open Knowledge, 1 opt-in live), 0 failed, 24.1 min |
| `pnpm test:e2e` (site) | 7/7 |

`pnpm test`, by suite:

| Suite | Result |
| --- | --- |
| worktrees | 109/109 |
| core | 16/16 |
| desktop | 1,548 passed, 16 skipped, of 1,564 |
| desktop native/update | 21/21 |
| site | 10/10 |
| store-desktop | 16/16 |

Targeted at `61cc65d`, before the full run:
- 230/230 unit tests, including #291's two regressions;
- 28/28 Electron cases across `claude-lifecycle`, `titles`, `typed-turns`, `approvals`, `errors` and `conversation-evidence`.

Building right after the #291 merge first failed with ENOSPC: the data volume was full, from other work on the machine. The build and every check above were rerun once space had freed.

CI on PR #286 at `61cc65d`, attempt 1 ([run 39128450673](https://github.com/TypeSafeAI/modex/actions/runs/39128450673)):
- **Passed:** 10 check runs.
- **Failed:** `unit + e2e (macOS)`, with 3 failures in CF-5's `conversation-evidence.spec.ts`: 329 passed, 3 failed.
- **Skipped:** the coverage upload, because the step before it failed.

Only rows that succeeded were "not visible". That fits a folding race in the spec's setup: it clicks the last turn header before the evidence turn has rendered. The spec uses the mock backend, not Claude. It passed in CI at `3b1c1be` and `7c9d62c`, and in the clean local run above at this SHA. The race is reported on #278, and the failed job was re-run.

**Attempt 2: `unit + e2e (macOS)` passed.** CI at `61cc65d` is green, counting the latest run of each check: `unit + e2e (macOS)`, coverage upload, `iPhone companion`, CLI and installers on Linux and Windows, CodeQL, and every analysis job.

### Checks at `13faaeb` (up to date with `main` at `f6976df`)

Sibling CF PRs landed four times while this branch was in its final checks. A full local run takes about 50 minutes and was flaky at load averages of 50–90. So the last merge is checked like this:
- **Targeted, locally:** build pass. 228/228 unit tests across the lifecycle, Claude backend, background, runner, conversation-events, conversation-migration, event-journal, evidence, task-context, turn-layout, companion, routines and credit-fallback suites. 28/28 Electron cases across `claude-lifecycle`, `titles`, `typed-turns`, `approvals`, `errors` and `conversation-evidence`.
- **Live,** 11:55 UTC: below.
- **Full:** PR #286's CI at this SHA, recorded on #275 once it finishes.

### Full checks at `7c9d62c` (up to date with `main` at `d3711c6`)

**CI on PR #286 at `7c9d62c`:** all 12 check runs succeeded:
- `unit + e2e (macOS)` (required);
- `iPhone companion`;
- CLI and installers on Linux and Windows;
- CodeQL and every analysis job;
- coverage upload.

Local run on macOS (Apple Silicon), Node 24.18.1 and pnpm 10.34.5, 10:55–11:44 UTC, at a load average between 50 and 90:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm build` | pass (27 s) |
| `pnpm typecheck` | pass (22 s) |
| `pnpm test` | pass (579 s), broken down below |
| `pnpm test:e2e` (desktop) | 322 passed, 4 skipped (3 opt-in Open Knowledge, 1 opt-in live), 5 failed |
| `pnpm --filter @modex/site test:e2e` | 7/7 |

`pnpm test`, by suite:

| Suite | Result |
| --- | --- |
| worktrees | 109/109 |
| core | 16/16 |
| desktop | 1,541 passed, 16 skipped, of 1,557 |
| desktop native/update | 21/21 |
| site | 10/10 |
| store-desktop | 16/16 |

The 5 desktop E2E failures were all timeouts in specs that never start the Claude backend:
- `canvas.spec.ts › …recovers after the selected file is deleted`;
- `conversation-evidence.spec.ts` (2 cases; mock backend, with items sent straight to the window);
- `notes.spec.ts › an edit made outside Modex shows in Space…`;
- `streamer-mode.spec.ts`, where the worker's teardown timed out.

All four specs then passed alone at the same SHA, 26/26, and CI passed them. The site suite was run on its own because the desktop step failed first.

Targeted checks at `7c9d62c`:
- 223/223 across the lifecycle, Claude backend, background, runner, conversation-events, conversation-migration, event-journal, evidence, turn-layout, companion, routines and credit-fallback suites;
- 24/24 Electron cases across `claude-lifecycle`, `titles`, `typed-turns`, `approvals` and `errors`.

### Checks at `a6ea0b0` (up to date with `main` at `fb76aac`)

Run on macOS (Apple Silicon), Node 24.18.1 and pnpm 10.34.5, 09:55–10:42 UTC:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm build` | pass (29 s) |
| `pnpm typecheck` | pass (15 s) |
| `pnpm test` | pass (349 s), broken down below |
| `pnpm test:e2e` (desktop) | 322 passed, 4 skipped (3 opt-in Open Knowledge, 1 opt-in live), 1 failed |
| `pnpm --filter @modex/site test:e2e` | 7/7 |

`pnpm test`, by suite:

| Suite | Result |
| --- | --- |
| worktrees | 109/109 |
| core | 16/16 |
| desktop | 1,535 passed, 16 skipped, of 1,551 |
| desktop native/update | 21/21 |
| site | 10/10 |
| store-desktop | 16/16 |

The desktop E2E failure was `app.spec.ts › accessibility: information text meets AA contrast, …`:
- **What failed:** two sidebar "Chat details" popovers were open at once when the test opened one with ArrowRight. This is sidebar hover and keyboard UI, which CF-2 does not touch.
- **Rerun:** the test passed when rerun alone at the same SHA.
- **CI:** it passed at the same SHA (below).
- **Site suite:** it was skipped inside `pnpm test:e2e` because the desktop step had failed, so it was run on its own.

Targeted checks at `a6ea0b0`: 217/217 across the lifecycle, Claude backend, background, runner, conversation-events, conversation-migration, event-journal, turn-layout, companion, routines and credit-fallback suites.

**CI on PR #286 at `a6ea0b0`:** all 12 check runs succeeded, including the required `unit + e2e (macOS)`, `iPhone companion`, and CLI and installers on Linux and Windows. These were read over the REST API, because the account's GraphQL budget was spent.

### Checks at `52b159a`

Run on macOS (Apple Silicon), Node 24.18.1 and pnpm 10.34.5, 09:19–09:47 UTC, after merging CF-4:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm build` | pass |
| `pnpm typecheck` | pass |
| `pnpm test` | pass (204 s), broken down below |
| `pnpm test:e2e` (desktop) | 321 passed, 4 skipped, 2 failed |
| `pnpm --filter @modex/site test:e2e` | 7/7 |

`pnpm test`, by suite:

| Suite | Result |
| --- | --- |
| worktrees | 109/109 |
| core | 16/16 |
| desktop | 1,529 passed, 16 skipped, of 1,545 |
| desktop native/update | 21/21 |
| site | 10/10 |
| store-desktop | 16/16 |

Notes on the desktop E2E run:
- **Skips:** the 4 skips are the 3 opt-in real Open Knowledge specs and the new opt-in live spec.
- **The 2 failures were the disk filling up:** two `browser-document.spec.ts` cases (`prepared credential request cancels on reload` and `… on same-document`). Each failed in setup: `git init` in `seedHome` reported `No space left on device`. The data volume was at 99%, from other work on the machine, and this session deleted nothing to make room.
- **Rerun:** `browser-document.spec.ts` alone passed 18/18, including both cases.
- **Site suite:** it didn't run inside `pnpm test:e2e`, because the desktop step failed first, so it was run separately and passed 7/7.

Targeted checks at `52b159a`, before the full run:
- 193/193 across the lifecycle, Claude backend, background, runner, conversation-events, turn-layout, routines, subagent and credit-fallback suites;
- 18/18 Electron cases across `claude-lifecycle`, `titles`, `typed-turns` and `approvals`.

### Checks at `172b13f`

Run on macOS (Apple Silicon), Node 24.18.1 and pnpm 10.34.5, 08:19–08:46 UTC, after the CF-1 merge:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | pass |
| `pnpm build` | pass (53 s) |
| `pnpm typecheck` | pass (18 s) |
| `pnpm test` | pass (205 s), broken down below |
| `pnpm test:e2e` | desktop: 318 passed, 3 skipped (the opt-in real Open Knowledge specs), 0 failed, 21.3 min; site: 7/7 |

`pnpm test`, by suite:

| Suite | Result |
| --- | --- |
| worktrees | 109/109 |
| core | 16/16 |
| desktop | 1,521 passed, 16 skipped, of 1,537 |
| desktop native/update | 21/21 |
| site | 10/10 |
| store-desktop | 16/16 |

The 16 desktop skips are the same as below. The tool-outcome change in `172b13f` went red first: the stopped call read `failed`. Afterwards, 185/185 passed across the lifecycle, Claude backend, background, runner, conversation-events, routines, subagent and credit-fallback suites.

### Earlier full checks at `62ac15c`

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

## Live acceptance through the app (2026-10-18)

The usage limit had lifted by 09:19 UTC. `e2e/claude-live-stop.spec.ts` then drove the built app with the real Claude Code 2.1.302 and Haiku. It ran in Chat mode, in a throwaway repository, from a shell without `CLAUDE*`/`ANTHROPIC*` variables.

**Final run at `61cc65d` (12:50 UTC): pass** ([report](2026-10-18-claude-lifecycle/live-app-run.json)). Every step ended "Stopped." with no failure card:
- card waiting: idle in 0.85 s;
- running command: idle in 2.37 s, after SIGTERM;
- resume: replied "resumed";
- stream: idle in 0.98 s, 528 characters kept.

**At `13faaeb` (11:55 UTC): pass** Results were the same as at `7c9d62c`, within 0.01 s:
- card waiting: idle in 0.88 s;
- running command: idle in 2.39 s, after SIGTERM, row `interrupted`;
- resume: replied "resumed";
- stream: idle in 0.86 s, 398 characters kept.

Every step ended "Stopped." with no failure card.

**At `7c9d62c` (11:47 UTC): pass.** Every step ended with a "Stopped." notice and no failure card:

| Step | Observed |
| --- | --- |
| Stop while a `touch` card waits | Idle 0.88 s after Stop, notice "Stopped.". |
| Approve a 30 s Python command, Stop 3 s later | Idle 2.39 s after Stop. The notice reads "Stopped. Claude did not end the turn within 1.5 s of the interrupt, so Modex terminated it." The tool row is `done` / `interrupted`, and its file was never written. |
| Same thread, "Reply with the single word: resumed" | Reply "resumed". |
| Stop while a 2,000-word story streams | Idle 0.85 s after Stop, notice "Stopped.", 381 characters kept. |

**At `a6ea0b0` (10:47 UTC): pass, same spec.** Idle in 0.93 s, 2.36 s (terminated) and 1.37 s; resume replied "resumed"; 834 characters kept.

An earlier run at `a6ea0b0` passed too, but its streaming step had asked for only 400 words. Haiku finished the story before Stop landed: no stop notice, all 2,240 characters kept. That was a true account (nothing was stopped), but it did not test a mid-stream Stop. The spec now asks for 2,000 words and requires a "Stopped." notice on every step.

**Earlier run at `52b159a` (09:50 UTC): pass, with the looser spec.**

| Step | Observed |
| --- | --- |
| Stop while a `touch` permission card waits | Idle 0.86 s after Stop, notice "Stopped.". The card reads "Not answered — the turn was stopped". No failure card, and the file was never created. |
| Approve a 30 s Python command, Stop 3 s later | Idle 2.33 s after Stop. The notice reads "Stopped. Claude did not end the turn within 1.5 s of the interrupt, so Modex terminated it." The tool row is `done` / `interrupted`. 31 s later the command's file still did not exist, so the child did not outlive the stop. |
| Same thread: "Reply with the single word: resumed" | Reply "resumed": the session resumes cleanly after an interrupted turn. No failure card. |
| Stop while a story streams | Idle 0.86 s after Stop, notice "Stopped.". The 670 characters already streamed are kept. No failure card. |

The first attempt at this spec failed for two reasons:
- **My wait, not the app:** it waited for `idle` right after Send. That wait returned in 148 ms, before the turn started, and then read the previous reply.
- **The CLI's own guard:** Claude Code refuses a long foreground `sleep`, so that step never ran a long command.

The spec now waits for the new reply and uses a Python sleep. Steps 1 and 2 of that first attempt also passed: idle in 0.84 s and 1.31 s, "Stopped." both times.

To rerun:

```sh
cd apps/desktop
env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT MODEX_CLAUDE_LIVE=1 MODEX_CLAUDE_BIN=~/.local/share/claude/versions/2.1.302 pnpm exec playwright test e2e/claude-live-stop.spec.ts
```

Unset every `CLAUDE*`/`ANTHROPIC*` variable when you run it from inside a Claude session. Each run spends about five Haiku turns.

## Independent review

### Failure before Stop: reconciliation of `a6ea0b0`

A separate reconciliation reproduced a remaining ownership race on PR #286's head
`a6ea0b03df2eb2d93512fa2ea1fc85db65595b7d`. A failed result armed the drain deadline;
Stop then armed its longer termination deadlines. The drain settled the failed turn before
the process exited, without a stop report. The runner only retained unconfirmed pids for
interrupted results, so deleting the failed thread could remove a live process's worktree.

Two new regressions failed before the repair: the backend returned no unconfirmed stop
report, and `deleteThread` resolved instead of refusing while the process-liveness probe
still returned true. The tests use the actual backend and runner with the existing fake
process; they are not live-provider evidence.

The repair waits for exit or bounded Stop confirmation even when a failure arrived first.
The result retains both the original failure and its stop report. The runner tracks an
unconfirmed pid regardless of turn outcome, refusing deletion until the process exits.
The regression also checks that deletion succeeds once the liveness probe reports exit.
Verification results for this reconciliation are recorded separately from the earlier runs.

Live acceptance was repeated on the repaired build at 10:16 UTC with Claude Code 2.1.302
and Haiku. The opt-in spec passed all four steps: the pending card stopped in 936 ms,
the approved command stopped via SIGTERM in 2,336 ms without writing its file, the same
thread replied `resumed`, and streaming Stop kept 2,182 characters without a failure card.
The [new live report](2026-10-18-claude-lifecycle/reconciliation-live-app-run.json) records
those observations. The stuck-process failure-before-Stop race itself remains simulated;
this live run checks the existing native behavior after the repair.

The first full unit run passed worktrees (109) and core (16), then desktop reported
1,532 passed, 16 skipped and five failures in `knowledge.test.ts`. These were existing
server reuse, separate status stdout/stderr, failed-status diagnostics, malformed status,
and invalid-server refusal cases. The run included `kill EPERM`, readiness timeouts,
and missed rejection assertions. Running that unchanged file alone passed all 11 tests.
No timeouts or Knowledge code were changed. These failures remain part of the evidence.

The final repaired tree passed `pnpm build`, `pnpm typecheck`, and the complete `pnpm test`
command: worktrees 109/109, core 16/16, desktop 1,537 passed and 16 skipped (of 1,553),
desktop native/update 21/21, site 10/10, and Store desktop 16/16. Both new regressions pass
in that full run. The 16 skips are the existing 15 Windows-only cases and opt-in
OpenKnowledge integration. Full E2E and exact-commit CI results are recorded in the repair
PR linked from [#286](https://github.com/TypeSafeAI/modex/pull/286).

### Repair integration with CF-5 and CF-7

PR #291 also brings in the owning CF-2 branch at
`7c9d62ccae9fcf8b0a725fa76c9b13851a76c67b` and main at
`f6976dfe1eb4793343939db280706dfb41e450dc`. This preserves the owner's strengthened
live acceptance assertions and incorporates the landed command evidence and task-plan
interfaces. The only manual merge resolution combines the `ApprovalAnswer` and
`PlanStepStatus` type imports in the Claude backend. The failure-before-Stop repair and
its two regressions are unchanged. Verification of this combined tree is recorded in
[#291](https://github.com/TypeSafeAI/modex/pull/291), separately from the earlier checks
against `a6ea0b0`. The owner's later head
`3b1c1be760e68c722e8ea740c95e1225745e5de3` was then merged to preserve their newer
receipts. That merge changes only the review document and their live-report JSON;
application and test source remain identical to the verified integrated tree.

Local verification of the integrated source tree (`327fdc71165824a348d91aedba3025f58f38cbe4`):
- Frozen install with pnpm 10.34.5, full build and typecheck passed.
- First unit run: worktrees 109 and core 16 passed; desktop 1,546 passed, 16 skipped,
  two failed. The unchanged Knowledge invalid-server case missed an expected rejection;
  the unchanged Plugins timeout fixture had no `heartbeat` file when read. Those two
  files passed 36/36 in isolation. The complete unchanged rerun passed 1,720 tests with
  16 existing skips: worktrees 109, core 16, desktop 1,548, native/update 21, site 10,
  Store desktop 16. Both repair regressions passed in both full runs.
- Live acceptance with the owner's strengthened Stop assertions passed at 11:35 UTC:
  pending card 887 ms; running command 2,459 ms via SIGTERM, interrupted, with no output
  file after its deadline; resumed reply `resumed`; streaming Stop 966 ms with 191
  characters retained. All Stop steps recorded `Stopped.` and zero failures.
  [Integrated-build report](2026-10-18-claude-lifecycle/integration-live-app-run.json).
- Full desktop E2E: 328 passed, four opt-in skips, one failed in 29.6 minutes.
  `workspace-store.spec.ts:107` lost the browser-tools dialog after the native Hide side
  panel action. The first unchanged isolated rerun failed earlier waiting for the thread
  view and timed out closing the host. A second unchanged isolated rerun passed the
  original dialog assertion, reached later browser-guest lifecycle checks, and exceeded
  the 90-second test limit. These runs do not establish a local pass for that spec.
- Site E2E, run separately because the desktop failure stopped the combined command: 7/7.

No implementation or timeout was changed for the local test failures. The full E2E failure
and both isolated failures remain evidence; exact-head CI on the final integration commit
is required before calling the repair ready. Its results are recorded in #291. Native
withdrawal outside Stop and Windows/Linux native escalation retain the limits below.

### Earlier review

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
| Native interrupt, slow ack, forced termination, repeated Stop: explicit outcomes, no duplicate terminal event | Unit cases:<br>- "Stop interrupts Claude natively…" (`exited`, no signal)<br>- "…terminates a Claude that does not exit…" (`terminated`, SIGTERM only after the grace)<br>- "…kills a Claude that also ignores SIGTERM"<br>- "…never confirms its exit… unconfirmed"<br>- "Stop pressed while a failed result drains keeps the failure and still ends the process"<br><br>Runner cases:<br>- "Stop with a pending card…" (Stop pressed 3×: one interrupt, one notice, one `idle`; the stopped call reads `interrupted`)<br>- "a Stop Claude does not acknowledge says how Modex ended it"<br><br>E2E steps 1 and 3. |
| Cancelling a pending request removes its actionability; a late answer cannot execute it or satisfy a later request | Unit cases:<br>- "A permission request Claude cancels is withdrawn…"<br>- "An answer that arrives after the turn settled…"<br><br>Runner cases:<br>- "a card Claude cancels becomes inert…" (late `answer()` on the old card while r2 waits: nothing written for r1 or r2)<br>- "a request withdrawn while the approval gate is still deciding never shows a card"<br><br>E2E steps 1 (late `thread:answer` over IPC) and 2. |
| Late background notifications and zero-model-call results do not finish the next turn; genuine empty outcomes still fail visibly | Runner "a resumed session's replayed background result…" (held, then the silent run gets the `ended the turn without replying` card).<br>Runner "an unconfirmed stop…" (the old process's late success does not complete or write into the new turn).<br>Existing `claude-background` replay cases pass. |
| Split JSON/UTF-8 and stderr just before exit survive bounded draining; exit/signal reported without credentials | "Split JSON lines, split UTF-8…"<br>"A failure result waits briefly for stderr…"<br>"Output after exit is drained…"<br>"A process killed by a signal says so"<br>"Failure details name the MCP routes without their capability tokens"<br>"A launch that throws reports its argv without MCP route tokens"<br>"A success result inside a failure's drain window does not turn the failure into a completion" |
| Deletion waits for the owned process; another thread is not stopped | Runner "deleting a thread stops only its own Claude…" (deletion waits; the other CLI gets no interrupt and completes).<br>Runner "an unconfirmed stop keeps the worktree…" (deletion refused with the pid; worktree kept; allowed once the process is gone). |
| Live, fixture, CI and platform evidence kept apart | This document. |

## Not established here

- **Native withdrawal outside Stop (live).** The live run covers Stop. A `control_cancel_request` that the CLI sends while no Stop is pending is covered only by scripted fixtures; no live way to trigger one was found.
- **Windows and Linux.** The interrupt is protocol-level, so it applies everywhere. The SIGTERM/SIGKILL escalation and the `unconfirmed` probe were exercised only on macOS. Windows launches through `cli-supervisor.exe`, where `kill` semantics differ.
- **The Companion** still renders a withdrawn card as "Denied", because its item projection does not carry `withdrawn`. The card is inert there: answering returns 409. Carrying the reason to paired clients belongs to CF-6 (#279).
- **Reused pids:** an `unconfirmed` pid that the OS reuses keeps deletion refused until Modex restarts (see the independent review above).
- **Stop does not use `cancel_queued`.** Modex sends one message per process, so nothing is queued.
