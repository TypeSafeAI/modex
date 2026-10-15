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
