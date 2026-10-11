# Physical iPhone acceptance, 2026-10-11

The companion passed pairing, recovery, approval, and retirement flows on an iPhone 16 Pro Max running iOS 27.0.1. The final implementation passed the complete pairing/relaunch/Bonjour/revocation flow. Fresh-install consent remains a separate gate: an earlier waiting-session experiment passed after Allow, but the final scoped-session fresh app did not show or register a permission prompt.

## Reproduce the device run

Use the isolated project and fixture preserved in the private acceptance artifacts. The signed development app uses `works.jev.modex.acceptance20261011`, its own Keychain service, and its own URL scheme. The installed `works.jev.modex` TestFlight app remains separate.

```sh
xcodebuild -project ModexCompanion.xcodeproj -scheme ModexCompanion \
  -destination 'platform=iOS,id=<device UDID>' \
  -derivedDataPath /tmp/modex-iphone-acceptance-derived \
  -parallel-testing-enabled NO \
  -only-testing:ModexCompanionUITests/CompanionFlowTests \
  CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY='Apple Development' test
```

Xcode 26.6 signed the development build with an existing managed profile that includes the phone. Unlocking the phone resolved the initial `kAMDMobileImageMounterDeviceLocked` developer-services error. No App Store submission or remote repository write occurred.

## Verified behavior

| Check | Physical result | Evidence |
| --- | --- | --- |
| Pairing and relaunch | Pasted pairing link established the pinned connection; saved pairing survived app relaunch. | `physical-flow-retry.xcresult` and final `physical-flow-scoped.xcresult`, each 1 passed, 0 failed/skipped |
| Thread creation and skills | Created a thread from an empty project and inserted the Mac's project skill. | Same flow |
| Approval and follow-up | Approved one pending action and sent a follow-up through the Mac. | Same flow |
| Deny | Returned the thread to Ask each time, denied a pending action, and verified the Mac's denial receipt persisted after relaunch. | `physical-deny.xcresult`, 1 passed, 0 failed/skipped |
| Bonjour recovery | Fixture stopped the Mac server, occupied the original port, and restarted on another port. The phone recovered through Bonjour and retained the verified replacement endpoint after relaunch. | Same flow |
| Revocation | Mac revoked access; the phone cleared pairing and remained unpaired after relaunch. | Same flow |
| Persistent approval policies | Always allow approved a subsequent request automatically and survived phone app relaunch. YOLO produced its automatic approval receipt. | `physical-extended.xcresult`, 1 passed, 0 failed/skipped |
| Long skill description | All 1,777 characters reached the accessibility element. Screenshot inspection confirmed the final marker remained visible after scrolling. | `extended-attachments`, long-description start/end |
| Merged-task retirement | The actual retirement path removed a disposable worktree and branch, retained the transcript, disabled sending, and displayed the finished task after relaunch. | `physical-extended.xcresult`, `retirement-evidence.json` |
| First-use Local Network experiment | A session-wide waiting variant displayed the prompt, accepted Allow, and completed the original Connect request. This was an intermediate implementation, not the final scoped-session acceptance. | `first-use/modex-iphone-fixed2-20261011/fixed.xcresult`, 1 passed, 0 failed/skipped |

Retirement used live GitHub REST evidence for [merged PR #156](https://github.com/TypeSafeAI/modex/pull/156). `ThreadContextReader` reported merged head `ea3a4bfe6707c56bdf3adaab30f5cc305e9779be`; `TaskRetirer` independently found the disposable worktree clean at that exact head. `ThreadRunner.retireThread` removed only that disposable worktree and its `sonnet-5-5` branch. This was an actual local retirement using an already-merged PR, not a fabricated retired snapshot or a new remote merge.

## First-use regression

The first broad flow failed at “The paired Mac's thread should appear” after tapping the Local Network permission prompt. Repeating the flow passed. A fresh diagnostic build using the original session configuration captured `NSURLErrorDomain -1009`, “The Internet connection appears to be offline.” The app displayed the same error. The sanitized top-level network-path diagnostic was absent, so this error alone does not establish a privacy-denied path.

The initial comparison used the same test harness with distinct app identities. The baseline failed with that native error and recorded no permission prompt. With session-wide `waitsForConnectivity = true`, the fresh app recorded the SpringBoard Local Network prompt, selected Allow, and loaded the paired thread from the original request. No explicit retry occurred. Earlier diagnostic harness attempts that did not reliably record or handle permission prompts remain in the private artifacts; they are not counted as successful first-use tests.

Waiting follows [Apple's Local Network privacy guidance](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy). The final implementation uses a dedicated session only for the initial pairing snapshot, invalidated when that request ends. Saved-endpoint polling, Bonjour candidates, and POST actions retain their ordinary session behavior. Both sessions use the same certificate pinning, redirect rejection, authorization headers, and response checks.

The session-wide experiment delayed a dead endpoint for 75.65 seconds before timing out. The control without waiting returned connection failures in under 0.1 seconds and continued cycling addresses. The broad session-wide recovery test was also invalidated by an unhandled `ECONNRESET` in the fixture's intentionally occupied port: the fixture process exited, so no replacement server remained reachable. That failed run is preserved as a harness failure, not proof of a production recovery failure. The copied fixture now handles expected errors on those blocker sockets.

The final scoped implementation passed the broad physical flow with the corrected fixture, including Bonjour recovery and revocation. Its separate fresh-install test recorded no permission event, no app error, and no paired thread within 40 seconds. Read-only Settings inspection found no Local Network entry for that new app; the earlier successful experimental app and existing acceptance app remained enabled. Recording inspection also found no prompt. This bounds the remaining first-use gate without establishing why the OS did not present consent. The final native unit suite passed 38 tests with no failures or skips, including a regression proving initial pairing calls the permission-aware snapshot while Bonjour recovery calls ordinary snapshots.

One final instrumented fresh identity extended observation to 100 seconds after the Connect action. Native timestamps confirmed entry into `pair`, the dedicated session's effective settings (`waitsForConnectivity=true`, request 8 seconds, resource 75 seconds), entry into the GET, and the connectivity-wait callback. The UI observed “Connecting…” after the single Connect tap, then “Connect” again after the request timed out. The native result was `NSURLErrorDomain -1001` after 75.63 seconds from request entry; the dedicated session invalidated immediately. No Allow event or paired thread appeared. The fixture process remained alive with no stderr and returned the expected unauthenticated HTTP 401 from the Mac before and after the diagnostic. This rules out a missed tap or an uninvoked request for that run, but does not establish why iOS withheld the prompt. The recorded error exposed no network-path or underlying-error detail. See `first-use/modex-iphone-finaldiagnostic-20261011/final-diagnostic.xcresult` and `acceptance-trace.txt`.

Review against Apple's guidance found no documented requirement to browse Bonjour before
an outgoing TCP request can trigger consent. Before any later device comparison, verify
that the variants' main executable UUIDs differ: Apple documents that different bundle IDs
with the same executable UUID can receive incorrect network constraints
([TN3178](https://developer.apple.com/documentation/technotes/tn3178-checking-for-and-resolving-build-uuid-problems)).
UUID uniqueness was not captured before the disposable build caches were removed, so this
remains an unverified test-isolation hypothesis, not the diagnosed cause. No speculative
Bonjour or privacy-setting change was made after the final trace.

## Evidence and limits

Private artifacts are under `$HOME/Documents/Codex/artifacts/modex-companion-acceptance-2026-10-11/physical`. They include the copied acceptance sources, result bundles, screenshots, sanitized result summaries, and retirement receipt. Fixture servers were stopped and pairing-link resources redacted. Raw device diagnostics and screenshots stay outside the repository.

- These are signed development-build results, not acceptance of a newly distributed TestFlight build.
- Final-implementation fresh consent is not accepted. The next device check must observe an actual first Local Network grant and completion of the original request with the scoped implementation; a retry or manual Settings grant would not establish that behavior.
- One Wi-Fi network and one Mac private IPv4 endpoint were available. A second network and simultaneous physical multi-interface traversal were not tested.
- Pairing used the pasted link. Camera permission and optical QR scanning were not exercised.
- Dismissing the pairing sheet with Done does not cancel its existing unstructured pairing task. A pending request may still complete after dismissal; waiting for connectivity lengthens that existing window. Cancellation through Done was not accepted by these tests.
- The Mac used the real transport, store, runner, and retirement implementation with a scripted coding backend. No real Claude/Codex inference turn was required.
- Skill coverage concerns the complete fixture description, not every installed skill or the full body of a `SKILL.md` file.
