# Signing and notarizing the macOS build

From v0.0.5 every release artifact is signed with a Developer ID Application certificate,
hardened-runtime enabled, notarized by Apple and stapled, so Gatekeeper opens it without a
warning on a fresh Mac. v0.0.1–v0.0.4 were ad-hoc signed and needed a right-click → Open.

Two paths produce the same artifacts: `scripts/release-mac.sh` on a maintainer's Mac, and the
`Release` workflow on a `v*` tag push. Both end in the same verification, and both fail closed:
a missing credential stops the run rather than falling back to an unsigned build.

## What is signed, and how

- `apps/desktop/package.json` → `build.mac`: `hardenedRuntime: true`, entitlements from
  `build/entitlements.mac.plist` (main) and `build/entitlements.mac.inherit.plist` (helpers).
  Notarization runs through electron-builder's `@electron/notarize` integration, which uses
  `notarytool`, then staples the ticket to the app and the DMG. The ZIP is produced after
  stapling, so the app inside it carries the ticket too.
- Entitlements are the two Electron needs, `allow-jit` and `allow-unsigned-executable-memory`.
  **Library validation stays on.** node-pty's `pty.node`, its `spawn-helper` and the compiled
  terminal supervisor are all inside the bundle and electron-builder signs each of them with
  the same identity, so nothing foreign is loaded and `disable-library-validation` is not
  needed. The verify step fails if that entitlement ever appears.
- `build/sign.cjs` is the `mac.sign` hook the release path uses. electron-builder always
  hands codesign the certificate *name*; a keychain holding a renewed Developer ID next to the
  one it replaced makes that name ambiguous and codesign refuses. The release script resolves
  the exact certificate (the matching one that expires last, or `MODEX_SIGN_HASH` to pin one)
  and the hook signs by hash with everything else electron-builder prepared. The verify step
  then extracts the leaf certificate from the signed app and checks it is that one. In CI the
  temporary keychain holds a single identity and the hook signs exactly as electron-builder would.
- `npm run dist` is unchanged for contributors: it passes `identity=-` and turns hardened
  runtime off, which is the ad-hoc build that CI's e2e and local demos use. `npm run
  dist:release` is the signed path and expects the credentials below.

## Credentials, and where they live

| Value | Local (`.env.release`, git-ignored) | CI (`release-signing` environment secrets) |
| --- | --- | --- |
| Developer ID Application identity (name) | `MODEX_SIGN_IDENTITY` | `APPLE_SIGNING_IDENTITY` |
| The certificate itself | login keychain (never exported) | `APPLE_CERTIFICATE` (base64 `.p12`) + `APPLE_CERTIFICATE_PASSWORD` |
| App Store Connect API key (`.p8`) | path in `APPLE_API_KEY`, mode 600, outside the repo | `APPLE_API_KEY_P8` (file contents) |
| Key id / issuer id | `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | same names |
| Tag verification | your own keychain | `TAG_ALLOWED_SIGNERS` (allowed-signers file contents) |

Rules that keep this safe:

1. **No secret is ever in the tree.** `.gitignore` excludes `.env.release`, `*.p8` and `*.p12`.
   `.env.release.example` shows the shape; copy it and fill it in.
2. **Secret references, not values.** `.env.release` holds `op://…` references; the script
   re-executes itself under `op run`, which resolves them in memory for that one process. The
   issuer id and the API key contents are never printed; the identity name and key id are,
   and both are already public in the signed app.
3. **Least privilege.** The API key should have the *Developer* role in App Store Connect,
   which can notarize and nothing else. Do not use an Admin key. Rotate it if it ever reaches
   a log, and revoke it from App Store Connect → Users and Access → Integrations.
4. **The private key stays in the keychain.** Export a `.p12` only to populate CI, with a
   strong password, and delete the export afterwards. electron-builder imports it into a
   temporary keychain on the runner and discards it with the job.
5. **CI refuses unsigned output.** The workflow checks every secret is present, verifies the
   tag's SSH signature against `TAG_ALLOWED_SIGNERS` before building, and uploads only after
   the same verification the local script runs. The `release-signing` environment should
   require a reviewer, so a tag push alone cannot mint artifacts.

## Running a release locally

```sh
cp .env.release.example .env.release   # once; fill in the four values
scripts/release-mac.sh                 # build → sign → notarize → staple → verify → SHA256SUMS.txt
scripts/release-mac.sh --verify        # re-run only the checks on apps/desktop/release/
```

Notarization usually takes one to three minutes. The verify step prints the team identifier,
the Gatekeeper verdict (`source=Notarized Developer ID`), the stapler result for the app, the
DMG and the app inside the ZIP, and the checksums.

## Verifying a download

Anyone can check an artifact without trusting this repository:

```sh
spctl -a -vv -t exec /Applications/Modex.app          # accepted, source=Notarized Developer ID
codesign -dvv /Applications/Modex.app 2>&1 | grep -E 'Authority|TeamIdentifier'
xcrun stapler validate ~/Downloads/Modex-<version>-arm64.dmg
shasum -a 256 -c SHA256SUMS.txt
```

## Populating CI once

```sh
# Certificate: export from Keychain Access as .p12 (Developer ID Application + private key), then
base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE --env release-signing
gh secret set APPLE_CERTIFICATE_PASSWORD --env release-signing      # paste
gh secret set APPLE_SIGNING_IDENTITY --env release-signing --body "Developer ID Application: <Org> (<TEAMID>)"
gh secret set APPLE_API_KEY_P8 --env release-signing < ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8
gh secret set APPLE_API_KEY_ID --env release-signing --body "<KEYID>"
op read "op://<Vault>/Apple Issuer ID/credential" | gh secret set APPLE_API_ISSUER --env release-signing
gh secret set TAG_ALLOWED_SIGNERS --env release-signing < ~/.ssh/allowed_signers
rm DeveloperID.p12
```

Create the `release-signing` environment first (Settings → Environments) and add a required
reviewer. Until these exist the workflow fails at its first step, which is the intended state.
