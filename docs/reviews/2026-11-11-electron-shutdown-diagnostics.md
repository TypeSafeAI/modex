# Electron shutdown diagnostics — 2026-11-11

PR #497 has two retained merge-queue failures on the same source tree `aa4bd344a9fce749c459054dda72ab948ce33e04`. The first stalled clicking Settings after a Code Review restart. The second passed Store Settings recovery, keyboard, draft and saved-access assertions, then stalled in `client.close()` in `finally`; worker teardown timed out and the job reached its 45-minute limit. Neither failure has an established root cause. Their separate [first](https://github.com/TypeSafeAI/modex/pull/497#issuecomment-6792777933) and [second](https://github.com/TypeSafeAI/modex/pull/497#issuecomment-6793802530) reports remain available.

Both affected scenarios passed three unchanged local repetitions on an export of that queue tree, using the installed pinned dependencies and original deadlines. After the Store build, all 1,172 original tracked blobs in the export still matched Git. These passes do not prove a repair, a flaky test or permission to discard either hosted failure.

## Observation without changing close

The Code Review harness and Store E2E scenarios now use `test/support/electron-close.ts`. It calls the existing Electron `close()` exactly once. On macOS, if close is still pending after five seconds and the owned child process is still alive, it starts one one-second `/usr/bin/sample` of that child. The native stack or sampler error is retained in the test's existing output directory, which CI already uploads. The sampler has its own five-second execution limit; it cannot settle or retry application close, kill the application, change a test deadline or bypass an unload veto. Other platforms use the original close operation directly.

Sampling is not awaited by application close. A successful close cancels the observer; a close rejection preserves its original error. An exited child is not sampled. Failure to obtain a process handle or to sample cannot replace close's original result. Only the test-owned child PID is supplied, and no environment, credentials, message bodies or application heap dump is collected.

## Verification

The first build failed because the diagnostic helper did not exist. After adding it, five unit cases passed: ordinary close cancels sampling; pending close remains pending and is not retried; sampler failure preserves the original rejection; an exited child is skipped; and a missing process handle preserves the close operation. The ten affected Code Review enablement and Store Electron scenarios passed with no skips or retries. Fresh `pnpm build && pnpm test` passed with 2,412 tests passed, 35 skipped and zero failures.

A separate real macOS control held a close promise pending around an owned Node child. The default native sampler wrote a stack identifying that exact PID. Close remained pending until the control resolved it, close was called once, and the child remained alive until the control's explicit cleanup. This validates the diagnostic path, not reproduction or repair of the hosted Electron failure.

The original PR #498 hosted run remains bound to `0b77a13739550d3b83f3726738bf001bede7ce2e`; its required macOS check and both native-platform jobs passed, while the separate iPhone job failed on saved-workspace reconnection. These later local changes do not alter those results. A new signed revision and its own checks are required before this instrumentation is delivered. The original close behavior and test limits remain acceptance gates. No further unchanged PR #497 queue attempt has been made.
