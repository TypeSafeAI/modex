# Signed Store acceptance, October 11

This is current-account acceptance of local signed candidates. It is not a TestFlight,
notarization, fresh-user, or production-release receipt. Val confirmed no fresh macOS test
account is available. Existing installed app bundles were not replaced. Acceptance used
a disposable host workspace; see the late UI-helper fallback caveat below.

## Candidate provenance

- Source: `store-recovery`, base `4945b339250fdc92030a961ce40fea834ebaf487`, with the
  reviewed Store recovery/parity patch. The private source snapshot was captured at
  `2026-10-11T07:15:19Z`; patch SHA-256
  `4f746886e8b0ec45bc0add29dd31f7ab6afa0018babc5b9edef3e0a2b9bbccfa`.
- Electron 44.4.5, Apple Silicon; host 0.0.10 and Store 0.0.8. Both local candidates
  passed strict deep code-signature verification with the existing Soul Protocol
  Developer ID identity. Neither was uploaded or notarized.
- The Store candidate uses bundle ID `works.jev.modex.desktop.acceptance20261011`,
  sandbox/network-client/application-group entitlements, and its own OS container.
  The signed host uses the allowlisted Host Preview identity and a disposable
  `MODEX_HOME`. Its project was selected through the native folder picker.
- Initial Store `app.asar` SHA-256:
  `3ac8f13ec51c95a60ef485182d016d3ad22fce4da059cf120ebd5afeb9085fe5`.
  Host `app.asar` SHA-256:
  `8ddc3d5574d8992422f3add934a24db3ad7c3017079fd33e63489b70dc577444`.

## Observed results

| Check | Result |
| --- | --- |
| Sandboxed running-host discovery | Passed: Store found the isolated signed host through the real shared application group. |
| Real Codex turn | Passed: GPT-6.1-Sol through Codex 0.162.1 created `codex-acceptance.txt` with exactly `signed-store-codex-ok` and a newline. The host persisted the completed transcript, shell result and idle thread. No demo/test transport was enabled. |
| Real Claude turn | Passed after the isolated candidate's saved-access relaunch: Claude Code 2.1.296 with the Fable model created `claude-acceptance.txt` with exactly `signed-store-claude-ok` and a newline. Native Store showed the completed Write and response; the host persisted the real Claude session and idle thread. |
| Initial credential write | A 259-byte `v10` ciphertext file was written with mode 0600 in the separate Store container. This alone does not establish successful persistence across relaunch. |
| Native confirmation and denial | Matching six-digit codes were observed in Store and the real host dialog. Native Cancel returned Store to “Connection was not approved.” In the later bounded run, the observed Allow action restored the same isolated Store candidate's connected workspace after revocation. |
| Saved access after relaunch | Passed for the controlled candidate with a unique runtime keychain name: quit completed, the process exited, and the identical signed app restored the connected workspace without pairing again. The initial candidate failed to reopen saved access; its original ciphertext remains unchanged. This does not prove installed-app credential migration. |
| Cancellation from Store | Passed: Stop ended a real Claude background task, persisted “Stopped.” and returned the thread to idle. The post-sleep sentinel file remained absent beyond its original 60-second window; no matching sleep process remained after Stop. The initial foreground sleep had been rejected by the CLI harness, so the accepted background task was the cancellation target. |
| Reconnect and draft retention | Passed in the bounded run: Store process 92398 stayed running while the host stopped and restarted from 88934 to 6303. Native UI showed automatic recovery, then the connected workspace with the exact unsent draft `Native reconnect draft 20261011`. Earlier interrupted runs were inconclusive, as described below. |
| Native revocation | Passed through Desktop access → Manage connected desktops. Store returned to welcome with “Your Mac removed this desktop's access” and removed its saved credential. The same candidate was explicitly approved again and then revoked again. All three test grants, including the earlier candidate's grant, were removed through the native menu; zero grants remain in the disposable host profile. |
| Compatible installed-host lookup and auto-launch | Signed sandboxed lookup passed after an unchanged copy was placed in Applications. A later Open action launched that exact preview, but the native confirmation/Cancel sequence was not captured. The preview's automatic service startup also masks the regular host's dependence on launch arguments, which App Sandbox discards. Full launch acceptance remains open. |
| Fresh macOS user | Not exercised; no fresh macOS test account is available. A disposable host profile under the current account does not satisfy this gate. |

## Acceptance isolation finding

The first candidate changed the bundle ID and builder product name, but its packaged
top-level `productName` remained absent and `name` remained `@modex/store-desktop`, the
same as the installed Store app. Electron 44.4.5 derives its safeStorage keychain service
from that runtime application name ([name selection](https://github.com/electron/electron/blob/v44.4.5/lib/browser/init.ts#L117-L122),
[MAS keychain naming](https://github.com/electron/electron/blob/v44.4.5/patches/chromium/feat_ensure_mas_builds_of_the_same_application_can_use_safestorage.patch)).
The container was isolated, but the keychain service
name was not. This finding does not establish the precise cause of the failed read.
The controlled artifact sets `extraMetadata.productName` to
`Modex Store Acceptance 20261011`. Its packed `app.asar` contents differ only in `package.json`;
SHA-256 is `f47123b91e92c09b7d32f8cfbaf8f44b1cce6377c31227f17db5fa1351e4cd68`.
The bundle ID, signing identity and entitlements remain the same.
Strict deep signature verification passed. No existing keychain item, credential, ACL,
or production app was changed.
Independent comparison also confirmed the unpacked native helper's CodeDirectory hash
was unchanged; its raw signature bytes differ after re-signing.

The controlled candidate connected, wrote a separate 259-byte `v10` ciphertext with
mode 0600, and restored its workspace after a verified process exit and relaunch of
the unchanged signed application. No ciphertext was copied between runtime profiles.
This establishes current-account persistence for the isolated candidate and supports
the namespace collision as a test-isolation concern; it does not identify the exact
keychain ACL failure or validate an upgrade of the installed Store app. The actual
Allow action was not observed in this comparison. The later bounded run separately
observed matching codes, the native Allow action, and the resulting connected workspace.

The shared disk filled during this run and separately interrupted the automated UI
suite. Storage was recovered by deleting owned regenerable build caches while preserving
logs, source and test results. Disk exhaustion is not established as the cause of the
keychain failure.

During an earlier reconnect attempt, the Mac again approached disk exhaustion and native
UI operations timed out. The isolated host exited with status 137; that status does not
establish the cause. A subsequent UI-helper app lookup automatically reopened the signed
Host Preview without the disposable-home environment after the original process had gone.
That fallback process was stopped on discovery, with no UI action or coding turn performed.
It may have touched the existing default Host Preview profile during startup, so profile
immutability is not claimed for that fallback. The normal Modex home is a separate path.
All acceptance candidate processes were then confirmed stopped. At that point, test grants
remained in the offline disposable host profile; they were not silently removed to
manufacture revocation evidence. The process timeline and stop receipt are private.

## Bounded native follow-up

The 08:35–08:40 UTC run used the same signed artifacts after repeat strict signature and
application-hash verification. A one-second process monitor confirmed a single Store PID
throughout host restart, recovery, approval and revocation. This run supplied the passing
reconnect/draft and native approval/revocation observations above. The original candidate's
259-byte ciphertext remained unchanged; the controlled candidate's credential file was
removed by revocation. All disposable grants were revoked in the native UI before the
exact owned app processes were stopped and confirmed absent.

Private receipts are `pre-bounded-native-verification.json`, `bounded-native-receipt.json`
and `bounded-native-processes-083531Z.jsonl`. These checks do not establish sleep/wake,
fresh-user setup, installed-host auto-launch, or installed-app credential migration.

## Auto-launch lookup guard

A later candidate added only `LSEnvironment.MODEX_HOME` to a signed adjacent copy of the
same host, preserving `MallocNanoZone=0`, application code and entitlements. A headless
LaunchServices environment fixture passed, and the compiled unchanged helper selected
that copy outside App Sandbox. These preparation checks did not establish sandboxed lookup.

At 09:33 UTC, the exact signed Store executable ran a read-only Node-mode probe that
invoked its unchanged bundled helper. The nonce, PID, executable, Electron version and
sandbox container matched, and reading a harmless user-readable file outside the
container was denied with `EPERM`. The helper selected `/Applications/Modex.app` instead
of the isolated adjacent copy. The guard therefore stopped before any GUI Connect or
host launch; it did not launch the installed app to complete the test.

The cause of that selection is not established. Both default host/Electron profile
metadata snapshots were unchanged, no disposable host home or new Store credential was
created, and the preserved original ciphertext was unchanged. The headless process and
monitor exited. This is installed-host lookup evidence and an unresolved isolation gate,
not successful auto-launch acceptance. Private receipts, including
`sandboxed-host-lookup.json` and `native-launch-guard-receipt.json`, are in
`/Users/buns/Documents/Codex/artifacts/modex-store-native-launch-2026-10-11/`.

A separate read-only probe at 09:49 UTC narrowed the fixture problem: the exact Store
process could not read the adjacent host's Info.plist, executable or CodeResources
(`EPERM` for all three). Its own bundle and installed Modex supplied six successful
controls with matching file hashes. The helper again selected installed Modex. Process
19489 exited successfully; no owned artifact process remained and no host launched.
This establishes that the Documents fixture was inaccessible in that sandboxed process,
without identifying the specific macOS policy or native validation step responsible.
Receipts are `sandboxed-file-access-diagnostic.json` and `sandboxed-file-access-cleanup.json`.

At 10:03 UTC, a controlled placement comparison passed. Both signed apps were copied to
the unused `/Applications/Modex Acceptance 20261011/` directory. File contents, symlinks,
signatures, modes, owners, flags, ACLs and extended attributes matched their originals;
the copy operation's inherited group was restored to each source file's group. No code,
entitlement, signature or quarantine attribute changed, and the originals remained intact.

The original Store first inspected the relocated host, isolating the host's location.
The relocated Store then inspected its adjacent host. Both exact signed processes read
all nine candidate/control files with matching hashes and selected the exact acceptance
host through their unchanged helper. Nonce, PID, executable, sandbox container and denied
non-TCC read controls passed. Processes 26573 and 26777 exited successfully; no owned
artifact process remained, the private host home and new credential were absent, and the
original ciphertext was unchanged. No GUI Connect or host launch occurred. This proves
location-dependent read/lookup behavior for these artifacts, not successful auto-launch
or fresh-user acceptance. Receipts are under `applications-location/` in the same private
artifact directory: `placement-comparison.json`, `placement-metadata-verification.json`,
`original-store-host-lookup.json`, `relocated-store-host-lookup.json` and
`read-only-comparison-cleanup.json`.

At 10:31 UTC, after the user closed their installed Modex, a fresh before guard passed.
Store process 21496 opened the exact Applications Host Preview as process 24274. Its
private home, Electron profile, certificate, discovery record and PID-owned loopback
listener matched. The Host process had no `--desktop-host` argument. Store reached its
workspace with one grant and a saved credential before the native confirmation could be
captured, so the pending-consent guard failed. The user subsequently confirmed clicking
“Allow this desktop” on the prompt. This explains the connection; the run did not exercise
the requested Open → Cancel sequence or capture the pending zero-grant state.

The test grant was revoked through native Desktop access. Store returned to the removed-
access welcome screen and deleted the temporary credential. Both apps and all their
helpers stopped; the observer exited. The original ciphertext and both default profile
metadata snapshots were unchanged, the private host port was closed, and both signed
archives remained unchanged. The first post-run check ran before the Host had exited;
its failed receipt is preserved alongside the subsequent successful cleanup. Receipts
are `applications-location/native-attempt-2/{before-native,launched-native,cleanup-verified}.json`
and the process monitor in the same directory. No coding turn ran during this interval.

Apple documents that sandboxed callers' [launch arguments are ignored](https://developer.apple.com/documentation/appkit/nsworkspace/openconfiguration/arguments).
The frozen Preview starts its service automatically, whereas regular Modex starts it
only with `--desktop-host`. This explains why the preview launch does not establish
regular-host activation. The implemented fix sends only `modex-host://connect` to the
exact revalidated app, reuses its process and queues activation until initialization.
Regular hosts must declare launch capability 1 and the scheme; legacy Preview uses its
existing ordinary-launch behavior. Wire protocol, pinning and native approval are unchanged.
The unflagged application regression failed before implementation; focused startup,
capability, trust and denial/revocation tests now pass. The main `312a138` integration
passed build/typecheck, 488 unit tests plus one expected skip, and 177 desktop plus seven
site UI tests. The later signed regular-host launch and reuse check below passed. The
missing Cancel/pending-consent observation is a separate acceptance gap.

A fresh regular-host fixture was packaged from the reviewed main `312a138` integration;
its packaged activation/helper bytes matched the built source, and the Host completed
Developer ID signing and deep strict verification. Signing the separate Store fixture
failed with `cannot read entitlement data` while signing a framework resource. The
referenced plist remained readable and valid; the cause is not established. The Mac was
under heavy load at this time. The pipeline stopped before copying into Applications or
launching either app: no Host home, new Store container, connection or grant was created.
The shared test slot was released at 11:24 UTC. This is packaging evidence, not signed
regular-host runtime acceptance. Source, harness review, full-suite logs and the failed
signing receipt are preserved separately under
`/Users/buns/Documents/Codex/artifacts/modex-store-url-activation-2026-10-11/`.

At 11:53 UTC, a fresh clone of only the Store fixture completed signing and deep strict
verification. The failed artifact and signed Host were preserved. The exact Store binary
ran its packaged helper in Electron Node mode with the expected sandbox container; a
parent-readable control file failed with `EPERM`. That helper launched the explicit
regular `ai.typesafe.modex` candidate through `modex-host://connect`. Host process 12844
started without `--desktop-host`, used the isolated home and Electron profile, and owned
the loopback listener advertised with its certificate. The grant count remained zero.
A second helper invocation reused the same Host PID, port, and certificate with zero
grants. These checks establish signed sandbox-to-regular-host URL delivery and reuse;
they do not exercise the welcome screen's installed-candidate selection and Open sequence.

The normal Store GUI then discovered the running Host. Connect displayed a confirmation
code, but a grant and saved credential appeared before the Host dialog was captured.
The pending-consent guard failed; no Cancel success is recorded. The agent did not click
Allow, and attribution of this second observation is awaiting Val's response. Native
Desktop access revoked the single grant, removed the test credential, and Store later
displayed the removed-access welcome screen. No coding turn ran.

Cleanup passed at 11:56 UTC: both apps and helpers exited, the monitor stopped, the port
closed, and no live discovery remained. The original ciphertext, default Modex and Host
Preview profile metadata, and `~/.modex` metadata were unchanged. Both archives and
recorded signature identities remained unchanged. The two owned Applications copies
were moved into the private `completed-applications` directory; both their original and
relocated URLs were absent from LaunchServices afterward. Other registered apps were
left intact. `candidate.json`, `launch-sandbox-helper.json`, `reuse-sandbox-helper.json`,
`launched-passed.json`, `reused-passed.json`, `pending-native.json`, `after-passed.json`,
`applications-retirement.json`, and `native-slot-release.json` preserve these results.
The local Developer ID sandbox preview was neither notarized nor uploaded and is not
App Store distribution acceptance.

Private receipts, source snapshot, signed applications and disposable workspace:
`/Users/buns/Documents/Codex/artifacts/modex-store-signed-acceptance-2026-10-11/`.
