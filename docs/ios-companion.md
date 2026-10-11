# iPhone companion MVP

The iPhone app is a companion for a running Modex Mac app. Its first release works when the
iPhone can reach the Mac on the same local network. It shows projects and threads, live
transcripts, pending approvals, and lets the user send follow-ups or approve or deny one
request. A paired phone can also start a thread in a selected project, in the project checkout
or an isolated worktree. The compact command picker discovers the selected provider's skills
and custom commands on the Mac: Claude entries use `/name`, while Codex skills use `$name`.
Claude and Codex coding turns continue to run through their CLIs on the Mac.

## Pairing and access

1. In the Mac app, open **iPhone companion** in the rail and select **Turn on companion**.
2. If the Mac has more than one network, choose the address on your iPhone's network in
   **Mac network**. Each active address has its own QR code and copied link.
   In Modex on iPhone, select **Pair with your Mac** and scan that code. The code holds the
   Mac's local HTTPS address, a 256-bit bearer secret, and the server certificate's SHA-256
   fingerprint. The app pins that certificate and keeps the pairing in this device's Keychain.
3. **Turn off** stops the listener. **Forget paired phones** rotates the secret, so previously
   paired phones must scan again. The Mac restarts the listener when Modex launches if it was
   left on.

The listener is off until enabled. It exposes only a small paired API: snapshots, thread
creation, provider-scoped command discovery, sending a follow-up, and answering an unanswered
approval once. It omits project paths, skill paths, backend session
handles, settings, and tool arguments from snapshots. The iPhone offers only Approve once and
Deny, with an extra confirmation before approval. The Mac certificate and token live under
`~/.modex/companion/` with owner-only permissions, outside the repository and app bundle.
The server needs the Mac app to be running. There is no relay or internet endpoint.

## Approvals, skills and finished tasks

An approval card offers **Approve once**, **Deny**, and **Always allow in this thread**, each
confirmed on the phone. The thread's Approvals menu sets Ask each time, Always allow, or YOLO;
see [thread policy](approval-rules.md#thread-policy-always-allow-and-yolo). Approvals the Mac
answered itself show how ("Approved automatically · YOLO").

The skill and command picker shows each skill's complete description, wrapped, with the command
above it. Descriptions are read from the skill's frontmatter on the Mac; the user's home folder
and the project folder are replaced with `~` and `<project>` before they leave the Mac, and
skill file paths are never sent.

Threads on a worktree show their pull request number and state ("Worktree · PR #12 open").
When the PR merges and nothing in the worktree would be lost, the Mac retires the task and the
phone shows "Finished · PR #12 merged"; the transcript stays but takes no more follow-ups. The
phone receives the PR number and state only, never its title or link.

## Persistent connection

Scan once, or use **Copy pairing link** beside the Mac QR code and paste the link into
Connect on iPhone. The private link grants companion access; keep it with the intended
phone. The iPhone keeps the pairing in its Keychain across relaunches and updates.

With Mac v0.0.7 and Companion build 4, the Mac advertises a credential-free Bonjour service.
The iPhone finds its saved Mac after an address/port change and verifies the original pinned
certificate before adopting a new address. The Mac also recovers after an offline launch
or network change. It binds a separate listener to each supported private IPv4 address;
public, CGNAT, link-local, internal and IPv6 addresses are excluded. Adding or removing a
network leaves connections on unaffected addresses open. Each listener advertises its own
credential-free Bonjour endpoint, including its actual port if the preferred port was occupied.
Updated iPhone clients rotate through discovered addresses, alternating with the saved endpoint,
so an unreachable address cannot indefinitely hide a reachable second network. Temporary outages preserve the saved pairing and retry automatically;
returning to the foreground resumes discovery and refreshes the connection.

**Turn off** pauses the Mac listener; turning it back on permits the same pairing.
**Forget paired phones** revokes all existing pairing links/tokens, including requests still
in flight. A revoked phone clears its saved access, stops discovery and requires a fresh
code explicitly provided from the Mac. It cannot restore access by relaunching or discovering
the Mac again. The phone's explicit **Forget paired Mac** action also clears its local copy.
Individual per-phone grants are not part of the current shared pairing-token model.

Discovery supplies untrusted candidate addresses, never authentication. The client accepts
only private IPv4 HTTPS endpoints, refuses redirects, retains its saved endpoint after a
failed candidate, and alternates back to that endpoint so a bad advertisement cannot block
recovery permanently. Bonjour publishes only the address and public certificate fingerprint.

## Build and verify

Xcode 26.6 and XcodeGen are used to generate the native SwiftUI project from
`apps/ios/ModexCompanion/project.yml`. The app identifier is
`works.jev.modex`, version 0.1.0 (build 5), for iPhone on iOS 18 or newer.

```sh
cd apps/ios/ModexCompanion
xcodegen generate
xcodebuild -project ModexCompanion.xcodeproj -scheme ModexCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=26.5' \
  -only-testing:ModexCompanionTests CODE_SIGNING_ALLOWED=NO test
cd ../../..
apps/ios/ModexCompanion/Scripts/test-e2e.sh
# Verify optimized Release code in the simulator (testability is enabled for the test host):
MODEX_IOS_CONFIGURATION=Release MODEX_IOS_DERIVED_DATA=/tmp/modex-ios-release-e2e apps/ios/ModexCompanion/Scripts/test-e2e.sh
# Also exercise the Mac's private network address instead of loopback:
MODEX_IOS_LAN=1 apps/ios/ModexCompanion/Scripts/test-e2e.sh
# Also restart the Mac fixture on another port and then revoke the saved pairing:
MODEX_IOS_LAN=1 MODEX_IOS_RECONNECT=1 apps/ios/ModexCompanion/Scripts/test-e2e.sh
```

The first test command runs pairing validation and delayed-response model tests. The second starts a local Mac
fixture with the real thread runner and paired HTTPS API, then drives the simulator through
pairing, creating a thread, an approval, a follow-up, and cancelling or confirming Forget Mac. The fixture is offline and uses a fake backend; it
does not claim live Claude or Codex account access. Unsigned simulator builds use a
simulator-only pairing store if Keychain reports a missing signing entitlement; iPhone
builds always use Keychain. The `iPhone companion` CI job runs both suites on an available
iPhone simulator and retains the Xcode test results. The optional LAN run still uses the
simulator and an isolated fixture; it does not replace acceptance on a physical iPhone.

On 2026-10-04, the workspace build and typecheck passed, all 15 core and 232 desktop unit
tests passed, all 90 Electron end-to-end tests passed, and the iPhone simulator completed
pairing, approval confirmation, and a follow-up against the local Mac fixture. A signed
device archive and IPA export also succeeded. The first bundle ID was not registered in
App Store Connect, so the target was aligned to Val's `works.jev.modex` app record. The new
target passed its simulator unit tests and paired approval/follow-up e2e. Its signed IPA
passed ZIP integrity and Apple validation, uploaded successfully, and reached Apple's
`VALID` import and processing state: App Store Connect app `6818982013`, version 0.1.0,
build 1, delivery `bce3dd75-1a7e-46de-831c-42278f1150f9`. Distribution of the newer
build is recorded below; physical iPhone acceptance remains open. The Release configuration
also built for the generic iPhone device target with signing disabled.

Build 2 hardens first-run pairing and request lifetimes. Certificate generation uses the
OpenSSL shipped by macOS with named P-256 parameters, which both Electron and iOS accept.
Turning off the listener cancels pending startup and connections; rotating access also
rejects authenticated requests whose bodies have not finished arriving. The phone rejects
public DNS names disguised with private-IP prefixes, ignores responses from old selections
or forgotten Macs, preserves drafts during sends, and returns to the workspace when a
thread is deleted on the Mac. Forget Mac now requires an explicit confirmation.

Build 2 verification on 2026-10-04: workspace build and typecheck, 15 core tests, 239 desktop
tests plus the browser bridge test, all 91 desktop e2e tests, all 10 native tests, and the
paired iPhone flow passed. The initial simulator failure exposed LibreSSL's explicit-curve
default; the named-curve fix passed both Electron pairing and the real iOS HTTPS flow.
A signed device archive, distribution IPA export, strict code-signature verification and
ZIP integrity check also passed. On 2026-10-05, build 2 passed Apple validation, uploaded
as delivery `2d203cf7-abc3-483d-a83b-4be82499abeb`, and reached `VALID` processing. Its
App Store Connect state is `IN_BETA_TESTING`, assigned to the existing Internal group with
one tester. Physical iPhone installation and acceptance remain open.

Apple initially held build 2 at `MISSING_EXPORT_COMPLIANCE` because its uploaded plist
omitted `ITSAppUsesNonExemptEncryption`. The client uses Apple's URLSession TLS, Keychain,
and CryptoKit SHA-256, with no bundled cryptography implementation. Its exemption was
recorded in App Store Connect, matching build 1. The source plist now declares `false` for
future uploads; a Release device build verified that Boolean in the built app. See
[Apple's encryption guidance](https://developer.apple.com/documentation/Security/complying-with-encryption-export-regulations).

After the companion merged in #103, the paired simulator flow also passed against the
combined v0.0.6 palette candidate using `MODEX_IOS_LAN=1` and the Mac's private network
address. The Mac candidate passed all 91 source and signed packaged e2e checks. The
private-network simulator result still does not establish physical iPhone acceptance.

Build 3 adopts the official Modex mark in the App Store icon, onboarding and workspace.
On 2026-10-05, all 10 native tests and the paired simulator flow passed. Its signed IPA
passed Apple validation and upload, then reached `VALID` and `IN_BETA_TESTING` in the
existing Internal group with one tester (build ID `ee29b4ab-89d6-401d-a4ae-c4a860c71ae0`).
Physical iPhone installation and acceptance remain open; the public website continues to
show **Coming soon**. See the [v0.0.7 ledger](reviews/2026-10-05-v0.0.7-release-review.md).

Build 4 adds persistent pairing, trusted local discovery and automatic recovery after the
Mac address or port changes. On 2026-10-05, all 14 native tests and the extended LAN
simulator flow passed, including Mac service restart, a second phone relaunch with the new
address, and revocation that survives another relaunch. Its signed IPA passed strict
signature, ZIP integrity, Apple validation and upload. App Store Connect confirmed `VALID`
and `IN_BETA_TESTING` in the existing Internal group (build ID
`d731a884-b6ec-46a5-9027-9b696053c909`). IPA SHA-256:
`86689d1fee48647eb293a67dc1d654a0c4f121d5638f598fca927cac0118d45f`.
Automatic address discovery requires Mac v0.0.7; physical iPhone acceptance remains open.

## TestFlight

Build 5 adds an offline workspace on the welcome screen, plus the non-expiring
`modex://demo` review link. It uses in-memory sample threads and scripted replies, does
not browse for a Mac or create a network client, and leaves saved pairing data untouched.
The demo also supports Local/Worktree thread creation and a searchable sample skill for
Codex and Claude, with provider and location choices visibly simulated. Reset restores the
approval and clears drafts; leaving or restarting discards the demo. The QR, exact review
instructions and current verification/submission state are in the
[review access ledger](reviews/2026-10-06-review-demo-access.md). This addresses the reported
pairing/access blocker; Apple acceptance of demo access remains pending.

The iPhone build has a separate release path from the signed and notarized macOS release.
The App Store Connect record for **Modex Companion** uses `works.jev.modex` under Soul
Protocol LLC. Run the signed archive, export, validation, and upload path:

```sh
op signin && op run --env-file=.env.release -- apps/ios/ModexCompanion/Scripts/release-testflight.sh
```

Verify processing and install from TestFlight on a physical iPhone on the Mac's network.
The App Store Connect key used for macOS notarization has the Developer role; an Account
Holder, Admin, or App Manager must create the app record if it does not already exist. Do not
place signing keys in this tree.
