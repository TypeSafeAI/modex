# Browser credential acceptance

The final integrated browser, UI, Space, Streamer Mode, attachment, and CI harness
changes passed independent review and all local automated gates. A renewed controlled
real 1Password fill also passed on that same development build. Normal signed-app
acceptance and device Touch ID enablement remain separate release gates.

## Final integrated verification

Frozen tree `55d5e5e797a2df22ce1ef6ed9e98a4390d8ff0bf` passed SPEC and QUALITY
re-review with no remaining findings, including closure of the fixture-cleanup P2 below.
Those reviews inspected source, provenance, and retained evidence; they did not rerun
native tests. Fresh verification then passed on the unchanged tree:

- `npm run build && npm test`: **700 unit tests passed, zero failures or skips**.
  `MODEX_TEST_OPEN_KNOWLEDGE=1` enabled the otherwise optional real integration case.
- `npm run typecheck`: all workspaces passed.
- `MODEX_TEST_OPEN_KNOWLEDGE=1 npm run test:e2e`: **221 desktop tests passed in
  11.3 minutes; 7 site tests passed in 15.2 seconds**, exit 0, with no retries.
- All **461 source/document files** stayed unchanged throughout. All **424 build
  artifacts** matched between the build/unit and full-E2E boundaries. Owned native and
  compute processes exited, and the site port was clear before the live check.

Complete logs, receipts, source/build hashes, and this run's desktop/site results are
retained in `apps/desktop/.probes/browser-final-gates-20261011-133748/` in the browser
worktree. Preexisting test results were moved aside before launch and are not counted
as evidence for this run. The full patch SHA256 was
`d73db7b39de8d6863c6d3ddc71945f5c35e1ea74a6d1a1ccfa1fd110ddd44622`.
The subsequent reconciliation changes only the three browser evidence/usage documents;
runtime, tests, and build artifacts remain identical to the verified and live-tested build.

## Earlier combined implementation evidence

The tested integration tree is `eaf43fd347d256db103c771bb0d091eeac26152c`.
It composes signed browser checkpoint `f9031a33dd195416cf2644738bdefe9850a2c722`
with signed attachment candidate `21784a9eebabc24dfb5ad7115c93e8b18fbba332`.
The actual #157 squash, `5e80b46912a6ba2f278ece14bf18efaac55a2c8a`, has exactly
the candidate's entire tree, `a3d8c96ff479c948cc01fd5443bd7003794e8c68`.
GitHub reports that squash signature as verified and valid. The browser checkpoint
retains original #152 head `8c7e5b96f179a96b0bbedd00329baef655d172fb` ancestry;
actual main supplies the exact tested attachment content. Signed delivery, current-head
checks, and protected landing are recorded separately on
[PR #152](https://github.com/TypeSafeAI/modex/pull/152).

The merge preserves the browser sign-in status beside the Streamer guest cover,
browser extension restore and attachment protocol setup before window creation,
private browser sessions, theme scripts in isolated world 999, Knowledge guest
suspension while chat is open, and the Store's unavailable attachment/browser stubs.

- Build and all-workspace typecheck passed.
- Unit suites: **670 passed, one optional OpenKnowledge integration skip**, zero failures.
- Full `MODEX_TEST_OPEN_KNOWLEDGE=1 npm run test:e2e`: **213 desktop tests passed in
  7.9 minutes; 7 site tests passed in 14.9 seconds**, exit 0. This includes all 14
  browser cases, the real OpenKnowledge flow, and attachment, Space, and Streamer checks.
- Whole SPEC and QUALITY reviews passed with no findings. Each passed 52 focused
  tests and compared 141 emitted JavaScript files with source output.
- All owned native/site processes exited. The source tree and preflight patch SHA256
  `5b57191dc144286ed38f00c66ba1980593f115eab55c18d75d3cacc74c221b3e`
  remained unchanged throughout the full run. The CI harness follow-up affects tests
  and evidence only. The subsequent native Streamer repair changes BrowserTools presentation.

The repair binds each fill to its initiating top-frame document and URL using a random
isolated-world token. Navigation and `pagehide` permanently revoke it. Final checks,
token consumption, and field writes execute synchronously together. Best-effort token
cleanup cannot hold the busy gate behind a hung page. The native chooser tracks the
initiating frame and all ancestors monotonically; sibling navigation does not cancel it.
Setup, display, and cleanup exceptions still complete its callback once and release tracking.

Credential race fixtures use controlled HTTPS documents and fake `op`. They prove the
tested application behavior, not a real vault unlock or biometric action. The selected
guest receives the fields, and matching approved extensions can read them. Credentials
are not returned through Modex app-bridge IPC or stored in the app renderer, transcripts,
or error messages.

## CI harness follow-up

Hosted checks of signed browser head `dc842519ffe0ba71bc818f00299a8dfb0291f362`
failed at two UI-test boundaries:

- The [iPhone job](https://github.com/TypeSafeAI/modex/actions/runs/38137613109/job/114464615978)
  failed while typing `Review from phone`, even though its failure diagnostic reported
  that exact value. The first post-typing accessibility query exceeded the remaining
  observation budget. The helper then read a matching terminal value for its diagnostic
  without validating it. It now validates that existing terminal read and retains it for
  any failure message. Focus, typing count, generic polling, and timeout values are unchanged.
- The [macOS job](https://github.com/TypeSafeAI/modex/actions/runs/38137613109/job/114464615667)
  failed at the initial synthetic file drop, before the failed-creation scenario began.
  The trace has no DOM or IPC observations proving why that hosted drop was lost. A
  controlled reload with `state:get` held reproduces the helper's startup gap: the old
  helper dispatches one drop before Composer exists, makes no staging call, and produces
  no chip after state is released. The helper now waits for visible Composer and an
  installed drag listener, observed through a cancelled `dragover` event, before its
  single real drop. The readiness probe stages no file; launch behavior and application
  code are unchanged.

Focused RED/GREEN evidence on an owned iOS 26.5 simulator and real Electron:

- iOS RED: the behavior-preserving extraction failed the terminal-match regression;
  three immediate-match, mismatch, and missing-value cases passed. GREEN: all **five
  `DemoWorkspaceTests` passed**, including the unchanged real demo workflow. Exhausting
  the observation budget deterministically reproduces the slow-read sequence without sleeps.
- Desktop RED: the held-startup regression failed with zero chips; its trace records
  one drop, zero staging calls, and zero staged files before release. GREEN: all **18
  attachment lifecycle tests passed**, including the unchanged failed-creation case.
  The new test verifies no drop before release, then exactly one drop, staging call,
  chip, and staged file containing the expected bytes.
- Both runs exited normally. The owned simulator is shut down and all owned native
  runners exited. RED traces, result bundles, commands, logs, and receipts are retained
  in `apps/desktop/.probes/browser-ci-repair/` in the browser worktree.

Independent SPEC and QUALITY reviews passed the test-only follow-up tree
`4eb0c149eb0725f815a4fc0bd52bbe76e8288595` without findings. Fresh build, all-workspace
typecheck, and **670 unit tests with one optional skip** passed. Its full E2E run was
interrupted for the native Streamer finding below: **21 passed, one interrupted, 192
not run**, exit 130; site tests never started. This is neither a full pass nor a new
product-test failure. No hosted job was rerun to replace its failure evidence.

## Native Streamer dialog repair

Static integration review found that BrowserTools' native dialog strings bypassed the
renderer masking used by Streamer Mode. This was a synthetic-metadata finding, not an
observed real-secret disclosure. Login titles, passkey account labels and requesting-site
text, and extension names/sites now use the shared display-only secret matcher when
Streamer Mode is enabled. Ordinary mode preserves the original labels.

Immediately before presentation, BrowserTools reads only the current mode attribute from
the trusted app window's main frame. It sends no dialog metadata or credentials to that
renderer. Missing, loading, replaced, rejected, or unreadable state stays masked; a
**250 ms** fallback also masks a stalled read and clears its timer. Only an exact `false`
from the same live, non-loading frame permits original labels. The existing initiating
guest guard is rechecked after the read and before opening a chooser, so navigation
during that read cancels without presenting a stale request. Final selection checks,
callback completion, and cleanup remain in place.

The copied dialog message, detail, and buttons are the only redacted values. Login and
account arrays, selection indexes, credential IDs and bytes, extension package contents,
site permissions, and approved digests remain original. The deferred native-chooser test
now waits for the chooser to open before triggering its existing post-opening cancellation
scenarios; its assertions are unchanged.

- Synthetic regressions reproduced unmasked labels for all three dialog types and the
  new pending-read cancellation boundary before the corresponding fixes.
- **83 focused unit tests passed**, including 29 new presentation/read/guard cases.
  They cover on/off/unavailable state, hung reads and late resolution without duplicate
  side effects, released operation gates, and raw operational values.
- **26 focused Electron tests passed in 45.0 seconds**, exit 0. Five new cases cover
  all three dialog types on/off, both toggle directions during a held fake-CLI listing,
  and persisted startup before `state:get` with an unsolicited passkey request. Real
  installed extension bytes/digests, selected IDs, and filled credential values remain raw.
  Native dialogs and the file picker are intercepted; CLI and WebAuthn requests are
  synthetic. These checks do not establish physical native UI or live-vault acceptance.
- Source hashes stayed unchanged throughout the native run; all owned native runners
  exited. Evidence is in `apps/desktop/.probes/browser-streamer-repair/` in the browser
  worktree. The accepted three-file CI harness repair remains unchanged.

SPEC passed the native Streamer follow-up. QUALITY found no product-code issue but
required bounded teardown for its held fake CLI when a test fails before releasing it.
The shared cleanup now handles the original pending request immediately, invalidates
the guest, releases the child, and waits for settlement before normal Electron closure.
A six-second cleanup bound still reaches app closure if that request cannot settle;
the child also has its own five-second escape path. Release is idempotent and handles
teardown arriving before the child finishes starting.

The early-failure regression failed before that repair because the pending operation
had not settled at the pre-close boundary. Its diagnostic finally block released its
own child, so this RED is not evidence of a stranded process. The final affected run
passed **four Electron tests in 11.7 seconds**, exit 0: both original pending-listing
toggle cases, early-failure cleanup preserving the original error, and bounded cleanup
with a deliberately non-settling request. Receipts confirm the held children exited;
all owned native runners exited. Logs, traces, source hashes, and process receipts are
retained in `apps/desktop/.probes/browser-streamer-teardown/`. Product code and the three
accepted CI test files are unchanged by this fixture repair.

The final re-reviews and full automated gates passed as recorded above. The renewed
real-CLI check below covers the current BrowserTools path; the synthetic tests separately
exercise Streamer masking and cancellation cases.

## Current-build real 1Password development fill

The renewed check ran at **13:52:13–13:52:36 UTC on 2026-10-11** after the final
automated gates. The unchanged reviewed harness used installed **1Password CLI 2.39.0**
at `/opt/homebrew/bin/op`, the actual native Login chooser, and the production listing,
item-read, and document-bound fill path. No CLI shim, dialog override, or credential
injection was used. One temporary Login was created and selected.

- Guest username/password hashes matched the fixture, and the form was not submitted.
  The guest reported a secure context and had no Modex bridge or Node `require`.
- The password was absent from the app's current HTML/attributes, form values,
  `localStorage`/`sessionStorage`, and captured stdout/stderr. After normal app exit and
  stream closure, all **99 regular files (9,564,889 bytes)** under the isolated Modex
  home were scanned for the exact password in UTF-8 and UTF-16LE; no match was found.
  This does not establish absence from arbitrary JavaScript heap, every IPC payload,
  or encoded/encrypted representations.
- The exact owned Login was recoverably deleted. The app and harness exited normally
  without forced termination; the owned app PID was absent afterward.
- All **11 harness source/build hashes**, including renderer HTML, remained unchanged.
  The coordinator additionally verified unchanged shared Streamer matcher TypeScript
  and emitted JavaScript hashes before and after the run.

The receipt is `apps/desktop/.probes/queue-audit/live-1password-final-1352/receipt.json`
in the coordinator worktree, SHA256
`754384cfec7706f954816461e1284d51e294495fa32f5012ba7fa74197b27f05`.
`parent-verification.json` and `native-release.json` record the supplemental hashes,
actual chooser selection, and process exit. The harness SHA256 is unchanged from the
earlier check below.

This pass uses protocol-intercepted HTTPS in a throwaway profile. It establishes the
current development-build real-CLI fill path, not public TLS, real-site compatibility,
normal signed-app behavior, live cancellation, or a fresh biometric unlock gesture.

## Earlier real 1Password development-build fill

The controlled live check ran at **10:24:45–10:25:14 UTC on 2026-10-11** and exited 0.
Both the harness and product resolved **1Password CLI 2.39.0** at `/opt/homebrew/bin/op`.
One temporary nonce-named Login with generated credentials was created, selected through
the actual native chooser, read through the production CLI path, and filled through the
production browser command. No `op` shim, dialog override, or credential injection was used.

- Guest username/password hashes matched the fixture; the form was not submitted.
  The guest had no Modex bridge or Node `require` and reported a secure context.
- Scoped checks found no password in the app's current HTML/attributes, form values,
  `localStorage`/`sessionStorage`, or captured stdout/stderr. After app exit and stream
  closure, all 99 regular files under the isolated Modex home (9,564,681 bytes, including
  Chromium storage) were checked for the exact password in UTF-8 and UTF-16LE; none
  contained it. This does not prove absence from arbitrary JavaScript heap, every IPC
  payload, or encoded/encrypted representations.
- That exact unchanged owned Login was recoverably deleted through the real CLI.
  The app exited normally without forced termination. All 11 source/build hashes stayed
  unchanged during that check.

The reviewed harness is `live-1password.mjs`, SHA256
`e9d2178c6784e7426d9f6ae35f54b8613fc295359e46e1f6551c43c34c335644`.
Private receipts remain in `apps/desktop/.probes/queue-audit/live-1password-1025/`
in the coordinator worktree. Independent assessment recomputed its 11 hashes, matched
the five source files to signed checkpoint `f9031a33`, and checked cleanup assertions.
A signed Git commit is not a signed application artifact.

The fixture used a protocol-intercepted HTTPS origin in a throwaway profile. It proves
the tested real-CLI fill path, not public TLS, real-site compatibility, a fresh biometric
unlock gesture, normal signed-app behavior, or live cancellation during vault reads.
No fresh biometric gesture was independently observed.

## Renewed check and desktop-connection recovery

At **11:40:44 UTC on 2026-10-11**, the renewed attempt stopped before launching Modex.
The real CLI could not connect to the running 1Password desktop app; a subsequent
recovery listing reported the same connection timeout. Window inspection also timed out.
No final-build native selection, filling, leak scan, or cleanup pass is claimed.

The creation result was **uncertain**: no item ID was returned. No broad deletion was
attempted. The intended fixture metadata was retained privately for exact identification.
The earlier check's confirmed cleanup applies only to its own earlier Login.
Private setup and diagnostic receipts are in
`apps/desktop/.probes/queue-audit/live-1password-final-1140/` in the coordinator worktree.

At that earlier integration checkpoint, all **10 credential-core hashes** (five TypeScript
sources and five emitted JavaScript files) matched the passed receipt exactly; only the
renderer HTML differed. BrowserTools has since changed for native Streamer presentation,
so that ten-hash equality does not describe the current follow-up.

After the user restarted the menu-bar application, a real-CLI read-only recovery lookup
ran at **12:46:41–12:46:46 UTC on 2026-10-11**. The desktop connection worked and no entry
with the exact intended fixture title was returned. No item was created or deleted and
Modex was not launched. This establishes the lookup's observed absence, not a deletion
receipt or proof that the earlier uncertain creation never occurred. The private receipt
is `recovery-lookup-1791722806498.json` beside the setup receipts, SHA256
`ddee29385ab88639d55be4d2fa1d4a3a35536f8f4331160bd457107cc2f5034c`.

A second exact-title read-only preflight at **13:51 UTC** again found no matching entry
and performed no mutation. The subsequent successful check used its own separately
identified Login and verified that Login's deletion; it does not turn these absence
observations into a deletion receipt for the earlier uncertain creation.

## Release gates

Renewed integrated development-build filling and exact fixture cleanup passed. The
earlier setup failure occurred before Modex launched and does not establish a product
failure; its historical uncertainty and subsequent read-only lookups remain recorded above.

Normal signed-app 1Password acceptance remains explicit: real unlock, selection,
no-submit fill, cancellation during listing/item reads/navigation/close, and absence
of credentials from app state, logs, and errors. Public TLS, real-site compatibility,
and a fresh biometric gesture were not established by the controlled development check.
Delivery records on PR #152 are separate from these external acceptance gates.

Device Touch ID stays disabled and the default artifact omits the restricted WebAuthn
group. No matching standalone Developer ID provisioning profile is available; the Store
profile belongs to a different distribution channel. Enablement requires a separate
provisioned change and real signed WebAuthn create/get, restart/reuse, selection/cancellation,
and session-separation acceptance on supported hardware.
