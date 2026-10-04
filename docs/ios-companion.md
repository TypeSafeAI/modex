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
`works.jev.modex`, version 0.1.0 (build 1), for iPhone on iOS 18 or newer.

```sh
cd apps/ios/ModexCompanion
xcodegen generate
xcodebuild -project ModexCompanion.xcodeproj -scheme ModexCompanion \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro,OS=26.5' \
  -only-testing:ModexCompanionTests CODE_SIGNING_ALLOWED=NO test
cd ../../..
apps/ios/ModexCompanion/Scripts/test-e2e.sh
```

The first command runs the pairing validation unit tests. The second starts a local Mac
fixture with the real thread runner and paired HTTPS API, then drives the simulator through
pairing, an approval, and a follow-up. The fixture is offline and uses a fake backend; it
does not claim live Claude or Codex account access. Unsigned simulator builds use a
simulator-only pairing store if Keychain reports a missing signing entitlement; iPhone
builds always use Keychain.

On 2026-10-04, the workspace build and typecheck passed, all 15 core and 232 desktop unit
tests passed, all 90 Electron end-to-end tests passed, and the iPhone simulator completed
pairing, approval confirmation, and a follow-up against the local Mac fixture. A signed
device archive and IPA export also succeeded. The first bundle ID was not registered in
App Store Connect, so the target was aligned to Val's `works.jev.modex` app record. The new
target passed its simulator unit tests and paired approval/follow-up e2e. Its signed IPA
passed ZIP integrity and Apple validation, uploaded successfully, and reached Apple's
`VALID` import and processing state: App Store Connect app `6818982013`, version 0.1.0,
build 1, delivery `bce3dd75-1a7e-46de-831c-42278f1150f9`. Internal tester access and
physical iPhone acceptance remain to be verified. The Release configuration also built
for the generic iPhone device target with signing disabled.

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
