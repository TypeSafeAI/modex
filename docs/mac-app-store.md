# Mac App Store investigation

Requested on 2026-10-05: the full desktop experience through the Mac App Store and macOS
TestFlight, with the same official identity. Val selected investigation of a sandboxed
Store front end with a separately installed, signed Mac host.

**Verified Apple status (2026-10-11 06:42 UTC): Mac Store 0.0.8 has an approved beta review and is `BETA_APPROVED`.**
The [authenticated Apple receipt](reviews/2026-10-11-apple-status.md) records the current
build, group assignments, and production listing gaps. No Apple fields were changed.
The [current parity matrix and listing packet](reviews/2026-10-11-store-readiness.md) separates
implemented discovery/launch from signed, real-CLI, and fresh-user acceptance still required.
The live record is **Modex Mac App Store**, app ID `6819549715`, bundle
`works.jev.modex.desktop`. Beta review notes and a reviewer reply explain offline demo
access. The production 0.0.8 draft has this build and review notes selected, but remains
`PREPARE_FOR_SUBMISSION` with screenshots, description, keywords, and support URL missing.
The Mac Store profile and distribution/installer identities
are available locally. The [review access ledger](reviews/2026-10-06-review-demo-access.md)
tracks the replacement build, demo instructions and remaining review steps.
The preview implementation and evidence are in [the preview ledger](mac-store-preview-plan.md);
[source launch and signing instructions](../apps/store-desktop/README.md) are available.
The existing Developer ID release remains the supported full desktop app. Companion
TestFlight builds are iPhone builds and do not prove macOS Store compatibility.

## Confirmed constraints

Apple requires App Sandbox for Mac App Store apps. Electron requires its `mas` build for
that sandbox; the ordinary `darwin` build is not a Store binary. Child processes inherit
sandbox restrictions. The current unrestricted CLI execution, PTY terminal, worktrees,
external CLI installations and credentials cannot simply be carried into the same bundle
with a different signing certificate.

Apple's review rules also require a self-contained installation, restrict additional code
installation and require Store-delivered updates. Rule 4.2.3(i), which says an app should
work without requiring another app to be installed, is a material review question for a
local-host design. A technical bridge alone does not establish App Review eligibility.
The front end must not download a privileged helper or silently escape its sandbox.

Sources checked 2026-10-05:

- [Apple App Sandbox](https://developer.apple.com/documentation/security/app-sandbox)
- [App Review Guidelines, 2.4.5 and 4.2.3](https://developer.apple.com/app-store/review/guidelines/)
- [Electron Mac App Store submission guide](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide)

## Proposed ownership

| Surface | Store front end | Signed host |
| --- | --- | --- |
| Projects, threads, composer, Changes, themes, Streamer Mode | Reuse the existing React renderer | Existing Store and ThreadRunner |
| Claude/Codex login, routing and coding turns | Show existing controls and status | Own CLIs, credentials, routing and execution |
| Terminal, worktrees, diffs and file edits | Existing terminal/Changes UI | Existing PTY and repository services |
| File selection, clipboard, external links, window lifecycle | Native sandbox-compatible handlers | Validate requested repository paths/actions |
| iPhone pairing and revocation | Controls proxy explicit user actions | Existing pinned companion service |
| Updates | Mac App Store only | Existing signed release/update flow |

Use a dedicated authenticated local transport for the Store front end. Bind it only to
loopback, approve each client installation, pin its server identity, validate origin and
commands, and support revocation and protocol version negotiation. Do not broaden the
phone's LAN API or grant its pairing token terminal/filesystem/admin commands.

The existing `ModexBridge` interface is the reuse seam: the renderer already supports
native IPC and a browser development transport. `browser-dev.ts` is deliberately excluded
from release bundles and is not a production host implementation. Its tests demonstrate
renderer reuse, not production transport authorization or Store acceptance.

## Gates before claiming parity or shipping a Store build

1. Resolve App Review eligibility for a host-dependent development client, with a clear
   explanation of independently useful client behavior, local/remote host requirements,
   explicit installation/launch consent and no code downloaded by the Store app.
2. Implement the production host transport and sandboxed Electron `mas` shell. Preserve
   CLI-owned coding turns. Define behavior when the host is absent, stopped, revoked,
   outdated, disconnected or restarted during an action.
3. Run the full desktop acceptance suite through the real Store-to-host transport:
   projects/worktrees, both auth flows, send/retry/stop, approvals, diffs/revert, terminals,
   settings, themes, streaming, window lifecycle and cleanup. Verify a revoked client
   cannot submit commands, including requests already in flight. Add real CLI acceptance.
4. Run signed, sandboxed acceptance under a fresh macOS user. Verify consented file access,
   persistent pairing, sleep/wake, host/client restarts and compatible-version upgrades.
5. Create the macOS App Store Connect record and provision the distinct Store bundle ID
   (proposed `works.jev.modex.desktop`, final record/name to be confirmed at that gate).
   Produce the Apple Distribution package; validate, upload, verify processing and test
   installation through macOS TestFlight. A Developer ID DMG does not satisfy this gate.
6. Submit truthful metadata and screenshots for App Review. Publish only after acceptance.

The iPhone reconnection work in v0.0.7 supplies useful identity/revocation behavior, but it
is intentionally not the full desktop RPC surface. It does not complete these gates.

## Reproducible Apple distribution path

The store workspace now contains a fail-closed MAS release command. It requires all three Apple
artifacts before it builds: an `Apple Distribution` application identity, a separate `3rd Party
Mac Developer Installer` identity, and an `OSX` App Store provisioning profile whose application
identifier is `9LR8Z8UQ9X.works.jev.modex.desktop`. The command verifies the signed app, sandbox
entitlements, package signature and (when requested) App Store Connect validation before upload.

From a release worktree on Apple Silicon:

```sh
export MODEX_MAS_PROVISIONING_PROFILE="$HOME/Downloads/Modex_Mac_AppStore.provisionprofile"
npm run dist:mas -w @modex/store-desktop

export APPLE_API_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8"
export APPLE_API_KEY_ID="<KEY_ID>"
export APPLE_API_ISSUER="<ISSUER_ID>"
npm run dist:mas:validate -w @modex/store-desktop
npm run dist:mas:upload -w @modex/store-desktop
```

The initial release-path implementation lacked a matching Mac Store profile and installer
identity. The October 6 delivery receipt supersedes that earlier setup limitation and records
a processed package. Current Apple review, macOS TestFlight installation, a fresh-user
install/launch, and full real-CLI acceptance still need live evidence. Read the current
readiness matrix before treating an older build or distribution receipt as final acceptance.
