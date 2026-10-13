# Verified release candidates implementation plan

> Execute inline with the roadmap owner using the repository verification and landing procedure. PR #181 merged as 7c9229a; this follow-up is isolated in the release-candidates worktree.

**Goal:** Attach the exact tested macOS, Windows and Linux installers to a draft release while retaining all signing and native acceptance boundaries.

**Architecture:** Reuse the native platform workflow. Native reports bind their successful smoke checks to the candidate manifest; one dependency-free Node verifier checks release identity, exact artifact bytes and all acceptance receipts before producing an allowlisted upload directory. Publication remains a separate approved operation.

**Tech stack:** Node built-ins, node:test, GitHub Actions reusable workflows, existing native acceptance drivers.

## 1. Release identity and artifact verifier

Create `scripts/verify-release-candidate.mjs` and `scripts/test/release-candidate.test.mjs`.

- [x] Write failing tests for stable nonzero package version, exact `v${version}` tag, forty-character source SHA and numeric run ID. Use `releaseIdentity({ tag, version, sourceSha, runId })`.
- [x] Implement the strict identity function and run `node --test scripts/test/release-candidate.test.mjs`.
- [x] Write filesystem fixtures for five candidate installers: macOS arm64 DMG/ZIP, Windows x64 NSIS, Linux x64 AppImage/deb. Receipts must bind schema, platform/architecture, source SHA, run ID, version, byte size and SHA-256.
- [x] Test `verifyReleaseCandidate(directory, identity)` with real temporary files. Reject tampering, symlinks, extra/missing package files, baseline packages, stale source/run/version, missing/failed native receipts, and differing manifest/report artifact lists.
- [x] Implement verification and return the explicit five-file upload list. The macOS checksum list must contain exactly its DMG and ZIP. All three native macOS scenarios must report `passed: true` for the actual candidate ZIP and source/run.
- [x] Add a CLI identity mode and a collect mode. Collect copies only the verified allowlist into a new output directory and writes combined SHA256SUMS.txt and a release manifest; verify copied hashes before making output available. Existing output is refused. No upload occurs in this helper.

## 2. Native acceptance receipts

Modify `apps/desktop/scripts/accept-windows-package.mjs` and `apps/desktop/scripts/accept-linux-package.mjs`.

- [x] Include the already byte-verified `manifest` as `candidate` in each result.
- [x] After all acceptance and cleanup checks, set `nativeChecksPassed: !failure` before writing result.json. Preserve `installerAcceptance: pending`, `remaining`, failure details and existing assertions.
- [x] Ensure failed or incomplete reports are rejected by the verifier tests. Actual native execution remains required on the submitted source.

## 3. Reuse native jobs and attach a verified draft

Modify `.github/workflows/platform-cli.yml` and `.github/workflows/release.yml`.

- [x] Add `workflow_call` to the native workflow; retain native hosts, read-only permissions, all tests, baseline isolation and existing artifact names.
- [x] Validate tag/package identity after signed-tag verification, before the candidate build; do not apply it inside the deliberate private A0.0.0 fixture rebuild.
- [x] Call the native workflow from Release with read-only contents permission.
- [x] Make attachment depend on macOS signing, all three macOS native scenarios and both native platform jobs.
- [x] Download candidates and receipts into separate fixed directories. Run the verifier using the checked-out desktop version and GITHUB_REF_NAME/GITHUB_SHA/GITHUB_RUN_ID. Upload only its verified output after refusing public release or existing asset replacement.
- [x] Run `actionlint -shellcheck=` and focused verifier/native-package tests. Record inherited shellcheck warnings separately.

## 4. Evidence and delivery

- [x] Update release-signing/native-platform/status docs with actual behavior and remaining account/session/history gates.
- [x] Run full build, workspace typechecks and npm test before signed commit/push; run E2E if application/UI code changes.
- [x] Deliver this follow-up through its own PR after #181: #186 merged as `3add7ef`. Earlier source/test evidence and dirty follow-up remain preserved.
- [x] Reconcile the separately owned #184 release: v0.0.11 published from `fb267e7` without the updater; #190 retains integrated verification separately. The next release needs its own version and exact source, preserving those published artifacts and records. No tag, signing approval, or publication is implied by source preparation.

Windows signing stays deferred and Windows/Linux updates remain manual. Private same-source upgrade fixtures do not prove historical migrations. Cloud/automation remains deferred pending local readiness.

## Local verification

On the updater integration at `3d43103` plus this release follow-up, the monorepo build
and workspace typechecks passed. The full unit suite passed 1,387 tests with 15 skips;
29 focused release/native-manifest tests also passed. All 638 source hashes held during
the build and unit phases. Workflow syntax passed `actionlint -shellcheck=`; enabling
ShellCheck reports the pre-existing SC2046 keychain-list warning. No application/UI code
changed, so the prior updater UI acceptance remains scoped to its recorded source.

Independent read-only review found no blocking correctness or security issue. Its stale
macOS-only workflow paragraph was corrected. The modified native report producers passed hosted CI at `5189b57`; their manifests
and all three downloaded installer hashes were verified. The combined release workflow
still needs an approved signed tag. No signed tag, native macOS acceptance run, draft upload, or publication occurred.

The prospective integration with the independently verified approval, beta-documentation,
and worktree-maintenance recovery source (`7e461bf`) passed a fresh full build, workspace
typechecks, and 1,405 unit tests with 15 skips. All 639 source hashes held during the runs;
all observed owned process identities were absent afterward. The 329 application, core,
E2E, site/store and listed build-input paths match the approval revision `87368ec`, whose
271 desktop and seven site E2E cases passed separately. This is source-equivalence evidence,
not a new UI run. Reconcile the actual protected main commits before pushing this integration.
