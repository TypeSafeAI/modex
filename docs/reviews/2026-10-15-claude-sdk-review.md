# Claude Agent SDK review fixes

Follow-up to the review of [fork PR #1](https://github.com/snowopsdev/modex/pull/1),
original head `778844ff0c6acaf9bc7721536539c66593a97830`, using SDK `0.3.301`.

## Findings addressed

| Review finding | Change and coverage |
| --- | --- |
| Stop hangs when messages arrive after abort | Drain messages after Stop, release the prompt on the interrupted result, and settle after the process closes. Scripted and real SDK tests cover in-flight messages and graceful/forced interruption. |
| Frozen install rejects the SDK specifier | Lockfile now records the manifest's exact `0.3.301` pin. |
| SDK exit exceptions hide CLI stderr and code | Record the process exit and preserve trailing stderr, exit code and SDK diagnostics. Both test paths now exercise throwing non-zero exits. |
| No real `query()` coverage | New offline executable fixtures exercise the shipped SDK's initialize handshake, launch options, streaming, permission answers, cancellation, interrupt and failure reporting. Installed-CLI smoke tests are opt-in. |
| Interrupt immediately sends SIGTERM | Allow 1.5 seconds for interruption, then SIGTERM and a further 1.5 seconds before SIGKILL. Turn completion does not cancel pending kill escalation. |
| Withdrawn approval cards stay open | Pass cancellation into the runner, close pending cards with `no`, remove listeners after answers, and cancel rule setup/evaluation. Return `null` so the SDK sends no response for a withdrawn request. Runner tests cover displayed cards, in-flight decisions and delayed judge setup. |
| Permission callback can precede the tool row | Wait for the corresponding tool row, bounded at one second and cancelled when the request is withdrawn. Real SDK integration verifies tool-before-card ordering. |
| Spawn errors skip session closure | Close the SDK session and prompt before reporting launch errors; regression verifies stdin ends. |
| Redundant SDK options and package formatting | Use default host permissions, avoid prepending PATH twice, and restore unrelated manifest ordering/formatting. |

Independent review also reproduced a Stop race with an already armed idle timer. Stop
now cancels idle/cap timers, prevents rearming after abort and awaits process close.
Separate idle/cap regressions cover that behavior. SDK error-result fixtures include
the required `errors` array so graceful interruption tests exercise the intended path.

## Validation

Verified on macOS Apple Silicon with Node `24.14.0` (the CI major) and pnpm `10.34.5`:

- `pnpm install --frozen-lockfile`: pass after regenerating the lockfile.
- `pnpm build`: pass across the workspace.
- `pnpm typecheck`: pass across the workspace.
- `pnpm test`: 1,595 passed, 19 skipped, zero failures. This includes all six new
  offline real SDK tests, the Stop timer regressions and three new runner regressions.
  The three installed-Claude smoke tests are among the opt-in skips.
- Independent focused runner verification: 13/13 approval and cancellation cases pass.
- `env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test e2e/app.spec.ts -g '⌘N → type'`
  in `apps/desktop`: 1/1 pass, covering send, approval and the applied change in Electron.
  The first launch inherited T3's `ELECTRON_RUN_AS_NODE` and failed before the app started;
  removing that test-process environment variable resolved the launch failure.
- `git diff --check`: pass. Independent read-only SDK/process and runner/approval reviews
  found no remaining material issues after the corrections above.

The full Electron/browser matrix and native iPhone suite were not run for this backend change.

Installed Claude Code `2.1.301` was exercised through the real SDK with the default
Haiku alias. The reply smoke reached Claude but failed because the signed-in account
had reached its weekly usage limit (reset October 19, 3pm America/New_York). No model
output was generated. Live approval and streaming Stop smoke tests were not attempted
after that limit; offline real SDK coverage does not establish live model acceptance.

To rerun installed-Claude acceptance after the limit resets:

```sh
pnpm --filter @modex/desktop build:main
cd apps/desktop
MODEX_CLAUDE_SMOKE=1 node --test dist/test/claude-sdk.test.js
```

These opt-in cases use the user's CLI login and call a model. `MODEX_CLAUDE_BIN` selects
an executable and `MODEX_CLAUDE_SMOKE_MODEL` selects a model (default `haiku`). Normal
tests run the real SDK against local executable fixtures with no model calls.

## Local acceptance before upstream submission

Integrated upstream `6366cb5` (desktop 0.1.0 preparation and CodeQL corrections),
preserving both independent In flight entries in `docs/status.md`. The SDK backend,
runner and permission changes are unchanged from `e1f893e`, which the GitHub Codex
review completed with no findings on October 15.

On the combined candidate, frozen install, workspace build and typechecks pass.
`pnpm test` passes 1,596 cases with 19 skips and zero failures.

Fourteen targeted Electron cases pass locally: both subagent themes, Claude/Codex
title generation and cancellation, Pages MCP, Knowledge MCP with the pinned companion,
shutdown persistence, and the new real SDK acceptance flow. That flow verifies:

- A tool row and approval card appear before a file is written; approving allows the
  local CLI fixture to create the file in the throwaway project.
- Withdrawing a pending request dismisses the card, leaves the turn running until its
  reply, and sends no permission response back to the CLI.
- Stop uses the SDK interrupt and the CLI closes stdin before the thread becomes idle.
- A CLI exit with code 7 exposes its stderr in the UI and persists the exit code.

The first acceptance run failed only because its persisted-JSON assertion assumed
pretty printing. The formatting-independent assertion passes. Existing Claude fixtures
now answer the SDK initialization handshake and ignore unrelated control messages;
the shutdown fixture emits its final text only after receiving the user prompt.

The focused Electron group passed 12 existing cases, the new SDK flow passed on rerun,
and the separately enabled Knowledge MCP case passed. Commands and complete logs are
saved outside the worktree under `/tmp/modex-upstream-*.log`. These checks use local
scripted CLI executables through the shipped SDK. The signed-in Claude account's
weekly limit still prevents live model acceptance; no upstream PR has been merged.

## Codex review follow-up

The upstream Codex review identified a deferred-launch race: Stop can exhaust its
grace before the backend has a child, leaving only SDK cancellation to prevent a late
launch. The process factory now forwards `spawnOpts.signal` to `cliSpawn`, including
the SDK's graceful-close timing and an already-aborted signal.

A regression uses the real SDK with a waiting transport, lets Stop settle without an
assigned child, then invokes the production factory with the SDK's cancelled signal
and a real Node child. Without the fix, that child remains alive. With the fix, it
reports `AbortError` and exits. The fixture keeps the event loop alive while the SDK's
unreferenced close grace runs; isolated checks pass on Node 22.22.3 and 24.14.0.
Independent review found no material issues with the fix and reproduced the passing
regression on Node 24.

Local checks before pushing the follow-up:

- Frozen install, workspace build and typechecks pass.
- `pnpm test`: 1,597 passed, 19 skipped, zero failures.
- Focused Claude backend/background/real-SDK cases: 51 passed, three live-model skips.
- The real-SDK Electron lifecycle case passes again, covering approvals, withdrawal,
  Stop and CLI failure. The other 13 earlier Electron cases were not rerun for this fix.

The fork's earlier lockfile comment was already addressed in `13c6530`; the frozen
install above reconfirms the exact SDK pin. Evidence for this follow-up is saved
outside the worktree under `/tmp/modex-codex-comments-*.log`. Live model acceptance
remains subject to the account limit documented above.
