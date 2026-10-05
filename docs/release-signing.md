# Signing and notarizing the macOS build

From v0.0.5 every release artifact is signed with a Developer ID Application certificate,
hardened-runtime enabled, notarized by Apple and stapled, so Gatekeeper opens it without a
warning on a fresh Mac. v0.0.1–v0.0.4 were ad-hoc signed and needed a right-click → Open.

**Signing team.** Releases are signed and notarized as **Soul Protocol LLC (team
`9LR8Z8UQ9X`)**, which is the name Gatekeeper and `codesign -dvv` show. This was a deliberate
choice (2026-10-01), so a separate TypeSafeAI identity is not planned. If that changes, issue a
new Developer ID certificate and a Developer-role API key for the new team, update
`.env.release` and the `release-signing` secrets, and note the switch in the release notes,
since users will see a different signer.

Two paths produce the same artifacts: `scripts/release-mac.sh` on a maintainer's Mac, and the
`Release` workflow on a `v*` tag push. Both end in the same verification, and both fail closed:
a missing credential stops the run rather than falling back to an unsigned build.

## What is signed, and how

- `apps/desktop/package.json` → `build.mac`: `hardenedRuntime: true`, entitlements from
  `build/entitlements.mac.plist` (main) and `build/entitlements.mac.inherit.plist` (helpers).
  Notarization of the app runs through electron-builder's `@electron/notarize` integration,
  which uses `notarytool` and staples the ticket to the app. The ZIP is produced after
  stapling, so the app inside it carries the ticket too. electron-builder does not notarize
  the DMG, which Gatekeeper assesses as a download in its own right. The release script signs
  it by hash with a secure timestamp, submits it to `notarytool`, and staples its ticket. The
  first full run, for v0.0.5, found the gap: the verify step refused an unstapled DMG.
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
  then extracts the leaf certificate from the signed app and the DMG and checks both are that
  one. CI imports the `.p12` into its own temporary keychain on the search list
  (`CSC_KEYCHAIN`) before the script runs, so the script resolves and signs by hash there
  exactly as it does locally.
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
   strong password, and delete the export afterwards. The workflow imports it into a
   temporary keychain on the runner and deletes that keychain at the end of the job.
5. **CI refuses unsigned output.** The workflow checks every secret is present, verifies the
   tag's SSH signature against `TAG_ALLOWED_SIGNERS` before building, and uploads only after
   the same verification the local script runs. The `release-signing` environment should
   require a reviewer, so a tag push alone cannot mint artifacts.

## Running a release locally

```sh
cp .env.release.example .env.release   # once, in the primary checkout; fill in the values
scripts/worktree.sh new release-<ver>  # builds run in a worktree with a fresh install
cd .worktrees/release-<ver>
scripts/release-mac.sh                 # build → sign → notarize → staple → verify → SHA256SUMS.txt
scripts/release-mac.sh --verify        # re-run only the checks on apps/desktop/release/
```

The script refuses to build in the primary checkout, checks `node_modules` is complete before
it touches a credential, and reads `.env.release` from the worktree or, failing that, from the
primary checkout. Each notarization (app, then DMG) usually takes one to three minutes. The
verify step prints the team identifier, the signing certificate of the app and the DMG, the
Gatekeeper verdict for both (`source=Notarized Developer ID`), the stapler result for the app,
the DMG and the app inside the ZIP, the bundle icon check, and the checksums.

## Verifying a download

Anyone can check an artifact without trusting this repository:

```sh
spctl -a -vv -t exec /Applications/Modex.app          # accepted, source=Notarized Developer ID
codesign -dvv /Applications/Modex.app 2>&1 | grep -E 'Authority|TeamIdentifier'
spctl -a -vv -t open --context context:primary-signature ~/Downloads/Modex-<version>-arm64.dmg
xcrun stapler validate ~/Downloads/Modex-<version>-arm64.dmg
shasum -a 256 -c SHA256SUMS.txt                       # in the folder holding the downloads
```

## Populating CI once

Done on 2026-10-03 for v0.0.5. The `release-signing` environment exists with all seven
secrets and these protection rules:

- **Required reviewer:** BunsDev. Self-review is allowed because the org has one member; the
  approval is still a deliberate second step after the tag push.
- **Admins cannot bypass** the reviewer.
- **Deployments only from `v*` tags.** A branch, or a tag outside that pattern, cannot use
  the secrets.

The `.p12` must hold **one** identity: the Developer ID Application certificate that expires
last (SHA-1 `EE732DF3…DAF3E7F`, valid to 2031), its private key, and the *Developer ID
Certification Authority G2* intermediate. `security export -t identities` exports every
identity in the keychain, so do not use it. In Keychain Access, select that one certificate
and export it, or use any tool that exports a single `SecIdentity`. Before uploading, check
the export: `openssl pkcs12 -legacy -nokeys` should list exactly those two subjects, and the
private key's public key should match the leaf's.

To repeat it, for a renewed certificate or a rotated API key:

```sh
# Certificate: export the one identity as .p12 (see above), then
base64 -i DeveloperID.p12 | gh secret set APPLE_CERTIFICATE --env release-signing
gh secret set APPLE_CERTIFICATE_PASSWORD --env release-signing      # paste
gh secret set APPLE_SIGNING_IDENTITY --env release-signing --body "Developer ID Application: <Org> (<TEAMID>)"
gh secret set APPLE_API_KEY_P8 --env release-signing < ~/.appstoreconnect/private_keys/AuthKey_<KEYID>.p8
gh secret set APPLE_API_KEY_ID --env release-signing --body "<KEYID>"
op read "op://<Vault>/Apple Issuer ID/credential" | gh secret set APPLE_API_ISSUER --env release-signing
gh secret set TAG_ALLOWED_SIGNERS --env release-signing < ~/.ssh/allowed_signers
rm DeveloperID.p12
```

Without these secrets the workflow fails at its first step, which is the intended state.

## Cutting a release

From v0.0.5 the published artifacts come from the `Release` workflow. The local build is the
rehearsal that gates the merge.

1. In a `release-<ver>` worktree, bump the version, update `docs/status.md`, and write the
   review in `docs/reviews/`. Run `scripts/release-mac.sh`, then the packaged e2e:
   `MODEX_PACKAGED_APP="$PWD/apps/desktop/release/mac-arm64/Modex.app/Contents/MacOS/Modex" npm run test:e2e`.
2. Signed commit, PR, CI green, `gh-merge-when-green.sh <pr> --squash`.
3. `git tag -s v<ver> <squash sha>` and push the tag. The `Release` workflow waits for the
   `release-signing` reviewer, then builds, signs, notarizes, staples, verifies, runs the full
   e2e suite against the packaged app, and attaches the DMG, ZIP and `SHA256SUMS.txt` to a
   draft release.
4. Download the draft's assets and check them on a Mac as in
   [Verifying a download](#verifying-a-download): `shasum -c`, Gatekeeper, stapler and the
   signing certificate. Attach the verification log, write the notes, then publish the draft.
