# Workspace and Companion polish verification

Date: 2026-10-07. Consolidated from `dev-preview` onto `origin/main` at `4e9ff90`.

The desktop welcome presents Open Project beside explanatory work-mode cards and adapts
from a 320px viewport to a wide desktop pane. The logo tile has a neutral theme surface;
the shared BrandMark colors only the artwork purple in Coven.

The Companion groups threads into project cards, including projects with no threads.
Project actions preselect the correct project. A single identifiable sheet request keeps
that selection in sync with presentation. The new-thread composer stays above the keyboard;
context controls and pairing forms scroll independently when space is limited.

Disconnected workspaces retain their last snapshot and expose Scan pairing code and Try
again. Creation and send controls disable while offline. Rescanning the same certificate
identity retains unsent new-task and per-thread drafts; a different Mac clears them.
Polling publishes only changed snapshot or connection values, keeping idle workspaces and
open menu actions stable while real content changes and connection recovery still update.

Packaged desktop demo startup resolves its script within the ASAR bundle. Missing mock
scripts offer settings recovery instead of instructing users to install a coding CLI.

## Verification

- Full monorepo build, desktop typecheck, and 329 unit checks passed.
- Desktop/browser E2E: 122 passed. Website E2E: 7 passed.
- Welcome screenshots inspected at 320px and 1440px; browser checks also cover 375, 768,
  1024, and 1920px without horizontal overflow.
- Native Release configuration: 31 unit tests passed on iPhone 16 Pro / iOS 26.5.
- Native Release E2E: paired flow and offline demo flow both passed. Coverage includes
  empty-project selection, thread creation, skills, approvals, follow-ups, pairing retention,
  a fixture outage, retry/rescan cancellation, recovery, and forgetting the Mac.
- Review found same-Mac rescan draft loss; the added regression failed before the fix and
  passed afterward. Native E2E exposed stale project selection; the unchanged assertion
  passed after replacing split presentation state with an identifiable sheet request.
- Hosted UI captures exposed replaced menu accessibility elements during idle polling.
  A regression reproduced three redundant publications for an unchanged poll and passed
  after suppressing equal values. Same-ID content changes, repeated failures, and recovery
  with an unchanged snapshot are covered without weakening timeouts or stale-response guards.
- Developer ID release rehearsal passed strict app/nested-code/DMG signatures, hardened
  runtime, entitlements, architecture, icon, ZIP and DMG integrity checks. Notarization was
  not completed: release credential loading timed out in 1Password. This candidate is not
  a published release and retains the current 0.0.8 version for local verification.

Packaged application E2E results are recorded separately for the installed 0.0.8 app and
this candidate, so tests for unreleased UI changes do not redefine the installed version's
contract.

## Acceptance limits

Simulator automation does not prove physical-camera QR scanning, real-device network
changes, or human VoiceOver acceptance. No new App Store/TestFlight submission or public
GitHub release is implied by this local candidate verification.
