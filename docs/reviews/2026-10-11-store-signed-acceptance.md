# Signed Store acceptance, October 11

This is current-account acceptance of local signed candidates. It is not a TestFlight,
notarization, fresh-user, or production-release receipt. Val confirmed no fresh macOS test
account is available. The existing installed apps and their workspaces are preserved.

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
| Native confirmation and denial | Matching six-digit codes were observed in Store and the real host dialog. Native Cancel returned Store to “Connection was not approved.” |
| Saved access after relaunch | Passed for the controlled candidate with a unique runtime keychain name: quit completed, the process exited, and the identical signed app restored the connected workspace without pairing again. The initial candidate failed to reopen saved access; its original ciphertext remains unchanged. This does not prove installed-app credential migration. |
| Cancellation from Store, reconnect, revocation | Pending subsequent acceptance. |
| Native launch into a fresh user profile | Not exercised. The helper's ordinary launch cannot inherit the disposable host home; a fresh macOS account is unavailable. |

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
Allow action was not observed in this comparison, so native consent proof remains
the separately recorded matching-code/denial check.

The shared disk filled during this run and separately interrupted the automated UI
suite. Storage was recovered by deleting owned regenerable build caches while preserving
logs, source and test results. Disk exhaustion is not established as the cause of the
keychain failure.

Private receipts, source snapshot, signed applications and disposable workspace:
`/Users/buns/Documents/Codex/artifacts/modex-store-signed-acceptance-2026-10-11/`.
