# Physical iPhone acceptance, 2026-10-11

The companion passed two physical iPhone flows on an iPhone 16 Pro Max running iOS 27.0.1. First-use Local Network permission behavior remains under investigation after the initial pairing attempt failed and a repeat run succeeded.

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
| Pairing and relaunch | Pasted pairing link established the pinned connection; saved pairing survived app relaunch. | `physical-flow-retry.xcresult`, 1 passed, 0 failed/skipped |
| Thread creation and skills | Created a thread from an empty project and inserted the Mac's project skill. | Same flow |
| Approval and follow-up | Approved one pending action and sent a follow-up through the Mac. | Same flow |
| Bonjour recovery | Fixture stopped the Mac server, occupied the original port, and restarted on another port. The phone recovered through Bonjour and retained the verified replacement endpoint after relaunch. | Same flow |
| Revocation | Mac revoked access; the phone cleared pairing and remained unpaired after relaunch. | Same flow |
| Persistent approval policies | Always allow approved a subsequent request automatically and survived phone app relaunch. YOLO produced its automatic approval receipt. | `physical-extended.xcresult`, 1 passed, 0 failed/skipped |
| Long skill description | All 1,777 characters reached the accessibility element. Screenshot inspection confirmed the final marker remained visible after scrolling. | `extended-attachments`, long-description start/end |
| Merged-task retirement | The actual retirement path removed a disposable worktree and branch, retained the transcript, disabled sending, and displayed the finished task after relaunch. | `physical-extended.xcresult`, `retirement-evidence.json` |

Retirement used live GitHub REST evidence for [merged PR #156](https://github.com/TypeSafeAI/modex/pull/156). `ThreadContextReader` reported merged head `ea3a4bfe6707c56bdf3adaab30f5cc305e9779be`; `TaskRetirer` independently found the disposable worktree clean at that exact head. `ThreadRunner.retireThread` removed only that disposable worktree and its `sonnet-5-5` branch. This was an actual local retirement using an already-merged PR, not a fabricated retired snapshot or a new remote merge.

## Evidence and limits

Private artifacts are under `$HOME/Documents/Codex/artifacts/modex-companion-acceptance-2026-10-11/physical`. They include the copied acceptance sources, result bundles, screenshots, sanitized result summaries, and retirement receipt. Raw device diagnostics and screenshots stay outside the repository.

- The first `physical-flow.xcresult` failed at “The paired Mac's thread should appear” after the test tapped the Local Network permission prompt. The same flow passed after permission was granted. The cause still needs the fresh-bundle diagnostic result; this is not a first-use pass.
- These are signed development-build results, not acceptance of a newly distributed TestFlight build.
- One Wi-Fi network and one Mac private IPv4 endpoint were available. A second network and simultaneous physical multi-interface traversal were not tested.
- Pairing used the pasted link. Camera permission and optical QR scanning were not exercised.
- The Mac used the real transport, store, runner, and retirement implementation with a scripted coding backend. No real Claude/Codex inference turn was required.
- Skill coverage concerns the complete fixture description, not every installed skill or the full body of a `SKILL.md` file.
