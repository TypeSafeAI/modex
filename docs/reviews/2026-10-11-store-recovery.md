# Store recovery and workspace parity

The Store client keeps your saved access and current draft when host identity or protocol
validation needs attention. This change implements the recovery gaps in the
[Store readiness audit](2026-10-11-store-readiness.md).

## Behavior

- Discovery refreshes installed-host availability on each check and connect. Successful
  application-group directory resolution is cached; failures are retried. Post-launch polling
  probes running records without repeating native installed-host lookup. Native launch-time
  bundle, team, and protocol validation is unchanged.
- Certificate pin, validity-date, and hostname failures enter identity recovery. HTTP `409`
  from `/events` or `/invoke`, and an incompatible `connected` event, enter protocol recovery.
  Recovery increments the connection generation, tears down streams and retry timers, blocks
  dispatch, and preserves credentials and the mounted workspace. Stale command failures cannot
  revoke or alter a newer connection.
- **Retry saved connection** revalidates the saved pin and reopens events. It never replays
  a command or accepts a replacement certificate. **Forget access and reconnect** explicitly
  removes access. Ordinary outages retry automatically, and HTTP `401` still revokes access.
- All five `modexAccount:*` commands resolve locally with the same unavailable status or
  explicit limitation as the offline demo. Settings disables GitHub sign-in. Other provider
  sign-in paths remain host-owned.
- Native Workspace menu clicks use `workspace:shortcut`. Existing guest and renderer keyboard
  handlers retain keyboard ownership; the new menu has no native accelerators. Disconnection
  and renderer overlays suppress workspace actions without removing the workspace or draft.
  Inert Settings, Companion, and menu handlers leave Tab and Escape to the recovery controls,
  preserving the open UI and unsaved Settings values.

## Verification

RED was observed before implementation: seven transport cases failed on untyped identity
errors or protocol retry behavior, two discovery tests failed on the absent helper, and
Store E2E failed on unknown account commands, missing recovery controls, and the missing
Workspace menu.

Focused verification passed: 19 transport/host tests, 11 Store unit tests, and nine Store
E2E tests. Review follow-ups reproduced and fixed null HTTP/SSE error bodies and inert-overlay
keyboard interception. Independent spec and code review found no remaining blockers.

The full build and all workspace typechecks passed. `npm test` passed 481 tests with one
expected OpenKnowledge integration skip. `MODEX_TEST_OPEN_KNOWLEDGE=1 npm run test:e2e`
passed all 168 desktop tests and seven site tests, including the real OpenKnowledge scenarios.
The first E2E attempt stopped after 130 passing cases because the disk filled; after storage
recovery, the complete rerun passed with production source unchanged. Local receipts are in
`/private/tmp/modex-store-recovery-verification.BM881Z/`: `build.log`, `typecheck.log`,
`unit-fixed.log`, `e2e.log` (ENOSPC), and `e2e-rerun.log`.

Integration with the reviewed prerequisite commit `e6bfeee` merged cleanly. The combined tree
retains Companion's button/select focus handling and Store's inert guard. Full build,
typecheck, and 490 unit tests passed with one expected integration skip; receipts are
`integrated-build.log`, `integrated-typecheck.log`, and `integrated-unit.log`. Independent
review approved the merged source. The integrated full E2E run passed all 171 desktop and
seven site tests with OpenKnowledge enabled; `integrated-e2e.log` records the completed run.

Two initial full unit runs hit an existing Codex disposal fixture race. A private diagnostic
held the PID file between creation and publication: the empty read became PID `0`, so the
test checked its process group even after the real worker exited. The original failures did
not capture the raw PID. The test now waits for a safe integer PID greater than one and guards
its liveness check, matching the neighboring terminal fixture. The wait budget and backend
code are unchanged. Independent review approved the fixture correction. The focused disposal
test and full unit run passed after this test-only correction; `unit.log`, `unit-rerun.log`,
`codex-disposal-fixed.log`, and `disposal-fixtures-S4otyn/result.json` retain the failure, pass,
and diagnostic evidence.

The tests use temporary host/client homes and a scripted engine. They exercise live loopback
TLS and HTTP, blocked authenticated requests for changed pins, stopped retry churn, explicit
retry, no command replay, stale requests, and revocation. Store E2E checks draft retention,
account status and disabled sign-in, one action per guest/renderer shortcut, and native menu
clicks with overlay/disconnection suppression. Keyboard tests use automated Tab, Shift+Tab,
Escape, and Enter; human keyboard-only and VoiceOver acceptance remain unverified.

## Remaining acceptance

The [signed current-account receipt](2026-10-11-store-signed-acceptance.md) records passed real
Codex and Claude turns, Store Stop ending a real Claude task, and saved-access relaunch of
the unchanged signed candidate with an isolated runtime keychain name. The bounded follow-up
kept the same Store process and exact unsent draft through host restart, verified native
revocation and saved-credential removal, then observed matching codes, Allow, and reconnection.
All disposable host grants were revoked afterward. These current-account checks do not prove
installed-app credential migration or fresh-user setup.

Fresh-user setup, native installed-host auto-launch, and sleep/wake remain open. No fresh
macOS account was available for this run.
Apple distribution and the complete Store parity matrix remain separate gates. Attachments
remain excluded from Store; this change does not alter PR #157 or perform Apple writes,
submission, release, or installed-app mutation.

## Status summary

Moved from `docs/status.md` on 2026-10-18, where this was the "Local Mac Store development
preview (unreleased)" section. Its Store facts now sit in the Mac App Store edition entry under
In flight. The text is unchanged except that links now resolve from `docs/reviews/`.

Store recovery now pauses on certificate identity/date/hostname failures and incompatible
host protocols while retaining saved access and the mounted draft. Explicit retry rechecks
the saved pin and stream without replaying commands. Discovery refreshes installed-host
availability and retries failed group-directory lookup. The Store owns unavailable Modex
account responses and a native Workspace menu through the existing shortcut pipeline.
See the [recovery verification](2026-10-11-store-recovery.md) and
[Store readiness audit](2026-10-11-store-readiness.md) for evidence and remaining gates.


PR #119 adds a dedicated opt-in loopback host and a sandboxed Electron MAS client that
reuses the desktop renderer. Val approved integrating this development preview. Transport
boundary/revocation tests and a signed native smoke test cover explicit pairing, encrypted
saved access, an approved scripted edit, terminal execution, restart recovery and revocation.
App Sandbox was verified on the running client. Graceful host shutdown, full parity and
real CLI acceptance, provisioning and App Review eligibility remain pending. Store 0.0.8
was approved for macOS TestFlight beta testing on 2026-10-07; this is not an App Store
release. See [the preview ledger](../mac-store-preview-plan.md) and
[run instructions](../../apps/store-desktop/README.md).

The shared Mac connection settings now recognize existing system CLI sign-ins and recheck
them on return from Terminal or a browser. Authenticated Claude no longer asks for another
login; an authenticated Codex CLI account remains selected unless the user chooses another
account. Executable overrides still require verification before saving. Read-only checks on
this Mac confirmed Claude Code 2.1.289 and Codex 0.160.1 are already authenticated; this is
account-detection evidence, not a new live coding-turn or Store distribution acceptance.
