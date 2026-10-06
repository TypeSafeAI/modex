# iOS and Mac App Store review access

Apple's beta review could not get past pairing and requested demo QR/access information
under Guideline 2.1. This work makes the review path discoverable and usable on a fresh
installation, verifies it on both clients, and prepares accurate review instructions.

## Execution ledger

- [x] Inventory current main, related worktrees and open PRs.
- [x] Reconcile the existing uncommitted iOS demo implementation without changing its worktree.
- [x] Verify first-launch demo entry, representative interactions, reset/exit and isolation from real pairing.
- [x] Add equivalent self-contained access to the sandboxed macOS Store client.
- [x] Prepare platform-specific review notes and a reply that describes verified build behavior.
- [x] Verify native/source/package behavior, signing/distribution readiness and independent review.
- [x] Record delivered changes and any remaining App Store Connect submission steps.

The original `companion-demo-workspace` worktree is preserved. Apple approval remains an
external decision; fixes and review notes must not claim approval or unverified features.

## App Store Connect audit

Read through the authenticated REST API on 2026-10-06; no submission or reviewer message
was sent during this audit.

| App | App ID | Bundle | Current uploaded build | External state |
| --- | --- | --- | --- | --- |
| Modex Companion | `6818982013` | `works.jev.modex` | 0.1.0 (4) | `BETA_REJECTED` |
| Modex Mac App Store | `6819549715` | `works.jev.modex.desktop` | 0.0.7 | `BETA_REJECTED` |

Both builds are `VALID` and `IN_BETA_TESTING` internally. The existing review notes lacked
demo access instructions. The macOS App Store version record is still 1.0 in
`PREPARE_FOR_SUBMISSION`; it must be reconciled with the intended marketing version before
a production App Store submission. The replacement candidates below have not been uploaded.

## Review packet

- [iOS review notes](ios-review-notes.txt), for Companion's Beta App Review Information.
- [Mac review notes](macos-review-notes.txt), for the separate Mac app's beta and App Review Information.
- [iOS reply draft](apple-review-reply-draft.txt), to send after the replacement build and notes are available.
- [Demo QR](modex-demo-qr.png), encoding exactly `modex://demo`, without credentials or expiry.

The QR was generated with `qrcode` and independently decoded with Apple's Vision barcode
recognizer. A native UI test opens the URL through the registered app scheme. Physical
iPhone Camera scanning and physical TestFlight installation remain unverified.

The iOS demo offers browsing, approve/deny, a running sample, follow-ups, reset and exit.
It never creates a network client, starts discovery or replaces a saved pairing. The Store
demo reuses the production renderer with a disposable in-memory command bridge. Files,
diffs, replies and terminal echo are labeled samples. Account, host, external-page and
system actions explain their connected-workspace requirement. Demo preferences are isolated
from the real renderer's saved layout and theme.

Apple must accept demo access. This fix addresses the reported access blocker; it does not
prove full live-host acceptance or resolve the separate Mac Store architecture question.
See [Guideline 2.1](https://developer.apple.com/app-store/review/guidelines/#app-completeness)
and the [Mac Store constraints](../mac-app-store.md).

## Verification

- Workspace build, typecheck and tests passed: core, 280 desktop plus browser-bridge,
  10 site, and 9 Store tests.
- All 116 desktop and 7 site end-to-end tests passed, including demo reset, ephemeral
  preferences, unreadable saved-credential preservation, and real host pairing/reconnect/revocation.
- All 19 native unit tests passed. The iPhone 16 Pro simulator passed demo approvals,
  denial/reset, scripted reply, `modex://demo` entry and relaunch, plus the existing real
  pinned-Mac pairing/approval/follow-up flow (2 UI tests).
- The same demo UI flow also passed on an iPhone SE (3rd generation) simulator. The
  welcome screen scrolls so its entry remains reachable on smaller screens.
- Independent code review found a repeated seeded notes completion during a demo follow-up;
  a one-shot guard and regression test fixed it. Final code review found no material blocker.
  Review-note labels and timing were also checked against the actual controls.
- iOS 0.1.0 build 5 archive/export, ZIP integrity, strict app signature and Apple `altool`
  validation passed. SHA-256: `062eab5e287cf3f22edc38ef18bae785b5a51ef7919ba19237bd6b850e1a8542`.
- Mac Store 0.0.8 package passed distribution profile checks, strict nested signatures,
  sandbox-entitlement and installer-signature checks, and Apple `altool` validation.
  SHA-256: `87ac0b5606e0f19ec8b6e50c8fc27db5c507cb1b174b468ca8c4d99e06e27b7d`.
- A Developer ID signed MAS preview with an isolated bundle ID/application group opened
  in App Sandbox (`sandbox_check`: control 0, target 1, errno 0). Native UI checks passed
  offline entry, approval with visible diff, follow-up reply, reset and exit. Its ASAR is
  byte-identical to the distribution app (`c8c64e72972de228f79b1938a8d80e515e4c1a619e3f7349d345653ba7cece65`).
  The preview needed its own matching bundle ID/group while keeping the Electron helper
  naming intact; those isolation changes were made only to the test copy. This is local
  sandbox proof, not a TestFlight installation or Apple approval. The distribution ASAR
  contains no execution Store/ThreadRunner, command host or node-pty module.

Artifacts and logs are retained outside the worktree at
`/Users/buns/Documents/Codex/artifacts/modex-review-access-2026-10-06`.

## Remaining delivery steps

Upload the validated replacement candidates, verify processing, and select them for the
appropriate test groups/review. Replace each app's review notes with its own text above
and reply to the iOS reviewer with the QR attached. Sending the reviewer message and
submitting to Apple require Val's go-ahead; this patch does not silently perform either.
Physical-device/TestFlight acceptance and Apple's review decision remain open.
