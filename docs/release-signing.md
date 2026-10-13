# Signing and notarizing the macOS build

From v0.0.5 every macOS release artifact is signed with a Developer ID Application certificate,
hardened-runtime enabled, notarized by Apple and stapled, so Gatekeeper opens it without a
warning on a fresh Mac. v0.0.1–v0.0.4 were ad-hoc signed and needed a right-click → Open.

**Signing team.** Releases are signed and notarized as **Soul Protocol LLC (team
`9LR8Z8UQ9X`)**, which is the name Gatekeeper and `codesign -dvv` show. This was a deliberate
choice (2026-10-01). If the signing team changes, issue a
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
- Entitlements are the two Electron needs, `allow-jit` and `allow-unsigned-executable-memory`,
  and the team application group. Device Touch ID passkeys are disabled, and the default
  artifact must not carry `9LR8Z8UQ9X.ai.typesafe.modex.webauthn`. The release verifier
  rejects that deferred keychain group. A codesign entitlement string or signed binary
  alone does not authorize a restricted keychain group.
  Enabling it requires a separate patch that stages a valid standalone Developer ID
  provisioning profile, checks its app/team/group/expiry and signer authorization, embeds
  it at `Contents/embedded.provisionprofile` before signing, and verifies the signed artifact.
  The current Store profile is unsuitable. See Apple's
  [provisioning profile rules](https://developer.apple.com/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles).
  Real signed WebAuthn create/get, restart/reuse, chooser cancellation, and session isolation
  on a supported physical Mac remain enablement gates. `MODEX_E2E=1` and fake `op` tests
  do not prove biometric acceptance or real 1Password unlock. A controlled development-build
  check through the real CLI passed no-submit filling and scoped leak checks; see the
  [acceptance report](reviews/2026-10-11-browser-credential-acceptance.md). Normal signed-app
  unlock and cancellation remain release gates in the
  [browser acceptance steps](browser-tools.md#acceptance-still-required).
  **Library validation stays on.** node-pty's `pty.node`, its `spawn-helper` and the compiled
  terminal supervisor are all inside the bundle and electron-builder signs each of them with
  the same identity, so nothing foreign is loaded and `disable-library-validation` is not
  needed. The verify step fails if that entitlement ever appears. It checks every unpacked Mach-O file
  for a strict signature and the expected team; node-pty's Windows/Linux prebuilds are sealed
  resources, whose generic codesign extended attributes are not portable through ZIPs.
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
5. **macOS CI refuses unsigned output.** The workflow checks every secret is present, verifies the
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
   `release-signing` reviewer, then builds, signs, notarizes, staples, verifies, and runs
   the full e2e suite against the packaged app. It also signs a private updater-enabled
   `0.0.0` source fixture. Three fresh GitHub-hosted macOS runners use those exact source
   and candidate ZIPs for native upgrade, native download failure, and interrupted-download
   acceptance. The same workflow also runs native Windows and Linux installer checks.
   After all jobs pass, it verifies the five candidate installers against their hashes,
   exact tag/package/source/run identity, and native receipts. It attaches the macOS
   DMG/ZIP, unsigned Windows NSIS installer, Linux AppImage/Debian packages,
   `SHA256SUMS.txt`, and `RELEASE-MANIFEST.json` to a draft release. Existing public
   releases and drafts containing assets are refused. The private source fixtures are
   never public release assets.
4. Download the draft's assets and check them on a Mac as in
   [Verifying a download](#verifying-a-download): `shasum -c`, Gatekeeper, stapler and the
   signing certificate. Attach the verification log, write the notes, then publish the draft.


## Native updater release gate

Run `scripts/verify-update-mac.mjs prepare` inside the protected signing job, then
`accept` on a separate hosted macOS arm64 runner for each scenario. The driver refuses
local and self-hosted execution. Each runner owns its default home and updater state;
changing `MODEX_HOME` alone does not isolate Squirrel. A manifest binds both signed ZIPs
to their hashes, byte lengths, and source commit. Acceptance jobs receive no signing secrets.

The driver supplies unpublished release metadata and the actual candidate ZIP. Publisher
verification, draft persistence, restart coordination, and native updater events remain real.
Every scenario checks tamper refusal and open-Settings refusal. Upgrade acceptance requires
native replacement, automatic relaunch, the exact installed version, and unchanged raw drafts.
The failure scenarios inject an HTTP 503 or interrupt the owned source process only after
Squirrel requests its private ZIP. They then require read-only recovery on a fresh A launch,
refusal of another install, and manual recovery using signed B without clearing saved drafts
or native updater state.

These scenarios cover native download failure and interruption before staging completes.
They do not prove recovery from arbitrary ShipIt replacement failures, interruption after
`update-downloaded`, or historical schema migration. The private A build uses the same source
with version `0.0.0`; the first later published-to-published upgrade needs separate evidence.

Keep the `macos-native-update-*` artifacts with the release review. Local harness tests and
simulated controller tests pass, but the three hosted native scenarios have not run. Signed
tag approval, the `release-signing` reviewer, and draft-asset verification remain required
before publication. See [update recovery](update-recovery.md) for current local behavior.

## Candidate attachment checks

`node scripts/verify-release-candidate.mjs identity` requires a stable, nonzero desktop
version matching the tag and a checkout matching the workflow commit. The signing job
also verifies that the signed tag points to that commit. Version `0.0.0` is reserved for
private upgrade fixtures; an existing published tag must not be reused.

The attachment job downloads candidates and acceptance reports from the same workflow run
into separate directories. The verifier checks all five installer files, both native
platform manifests, and all three signed macOS scenario receipts before copying an explicit
allowlist into a fresh output directory. It checks the copied hashes again, then writes
the combined checksum list and release manifest. Missing, extra, tampered, symlinked, stale,
or failed inputs stop attachment. Windows and Linux checks use the reusable native workflow
with read-only repository access and receive no Apple signing secrets.

`nativeChecksPassed: true` records that the installed-app harness and its cleanup passed.
It does not complete `installerAcceptance`, which remains `pending` with the account/session
limits in each report and the release manifest. Windows signing is deferred, Windows/Linux
updates remain manual, and same-source `0.0.0` fixtures do not prove historical migration.
The combined release workflow first ran on an approved tag for v0.0.12 (run 38465731604).
Helper tests verify the attachment checks, not installed-app behavior. Review the remaining gates in
[native-platforms.md](native-platforms.md) before publication.
