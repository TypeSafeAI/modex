# iPhone companion MVP

The iPhone app is a companion for a running Modex Mac app. Its first release works when the
iPhone can reach the Mac on the same local network. It shows projects and threads, live
transcripts, pending approvals, and lets the user send follow-ups or approve or deny one
request. Claude and Codex coding turns continue to run through their CLIs on the Mac.

## Pairing and access

1. In the Mac app, open **iPhone companion** in the rail and select **Turn on companion**.
2. In Modex on iPhone, select **Pair with your Mac** and scan the code. The code holds the
   Mac's local HTTPS address, a 256-bit bearer secret, and the server certificate's SHA-256
   fingerprint. The app pins that certificate and keeps the pairing in this device's Keychain.
3. **Turn off** stops the listener. **Forget paired phones** rotates the secret, so previously
   paired phones must scan again. The Mac restarts the listener when Modex launches if it was
   left on.

The listener is off until enabled. It exposes only a small paired API: snapshots, sending a
follow-up, and answering an unanswered approval once. It omits project paths, backend session
handles, settings, and tool arguments from snapshots. The iPhone offers only Approve once and
Deny, with an extra confirmation before approval. The Mac certificate and token live under
`~/.modex/companion/` with owner-only permissions, outside the repository and app bundle.
The server needs the Mac app to be running. There is no relay or internet endpoint.

## Build and verify

Xcode 26.6 and XcodeGen are used to generate the native SwiftUI project from
`apps/ios/ModexCompanion/project.yml`. The app identifier is
`works.jev.modex`, version 0.1.0 (build 3 candidate), for iPhone on iOS 18 or newer.

```sh
cd apps/ios/ModexCompanion
xcodegen generate
xcodebuild -project ModexCompanion.xcodeproj -scheme ModexCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=26.5' \
  -only-testing:ModexCompanionTests CODE_SIGNING_ALLOWED=NO test
cd ../../..
apps/ios/ModexCompanion/Scripts/test-e2e.sh
# Also exercise the Mac's private network address instead of loopback:
MODEX_IOS_LAN=1 apps/ios/ModexCompanion/Scripts/test-e2e.sh
```

The first test command runs pairing validation and delayed-response model tests. The second starts a local Mac
fixture with the real thread runner and paired HTTPS API, then drives the simulator through
pairing, an approval, a follow-up, and cancelling or confirming Forget Mac. The fixture is offline and uses a fake backend; it
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

## TestFlight

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
