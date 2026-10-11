# Desktop roadmap reconciliation

Baseline: main `6c00c52d`, inspected 2026-10-11. This is an execution ledger, not a release receipt.

## Canvas

The workspace already had guest browser tabs and bounded source-file reads, but no Canvas.
New acceptance covers HTML interaction, relative CSS and document refresh, SVG, escaped
Markdown, full view, overlay hiding, file deletion/recovery and guest disposal.

- Initial Electron acceptance failed at the absent Canvas button.
- First implementation: 3 resource unit tests and 2 Electron E2E tests passed.
- Baseline full build succeeded; the subsequent baseline unit compilation included the newly
  added Canvas test and failed on its then-missing module. This is not a clean baseline unit result.
- Expanded Canvas acceptance: all 6 Electron E2E cases passed (1.3 minutes), including
  native guest mouse input and bounds, denied network/privileged navigation/popups,
  failed initial-open recovery, transient listing recovery and concurrent manual reload.
- Resource tests: 3 passed, including aliases into hidden files/directories and outside roots.
- Independent specification and code reviews found recovery, symlink and reload races;
  each was reproduced, repaired and re-reviewed. No remaining findings.
- Fresh `npm run build && npm test` passed: core 15, desktop 434 plus browser bridge 1,
  site 10, Store 9; zero failures. One existing opt-in OpenKnowledge live test was skipped.
- `npm run typecheck` passed all workspaces.
- Full desktop E2E: 167 passed in 8.9 minutes, with 3 existing opt-in real OpenKnowledge
  cases skipped. The website phase initially could not bind port 5187; after that listener
  exited, `npm run test:e2e -w @modex/site` passed all 7 tests in 17 seconds. No test or
  production changes were made to bypass the port collision. Packaged release acceptance
  remains required.

Full unit verification initially exposed an unchanged Knowledge fixture problem: an EPERM
from process-group cleanup skipped fixture HTTP-server closure and left the worker alive.
Live inspector evidence showed no pending service operation and the retained kill error.
The fixture now closes its owned server in finally, preserving the original failure. The
first full run also timed out in the existing packaged-demo test under concurrent machine
load. These failures are not recorded as passes; the fresh build/unit/typecheck gates and
both E2E phases subsequently passed, subject to the explicit live-runtime skips above.

### Offline visual evidence

Captured locally on macOS 26.7.1 (25G241), Graphite, en-US, 2× scale, from source
`6c00c52d372adc0f94c6dd667bcf97b671363248` plus this uncommitted Canvas patch. The standard
1380 × 880 viewport and a 900 × 720 narrow viewport were inspected. The synthetic project
is named Canvas demo; its local HTML includes an offline label and counter. No provider
credentials or live model turns were used.

- `npm run screenshot -w @modex/desktop -- --screenshot=/tmp/modex-roadmap-shots --demo-answer=yes`
  captured the standard approval and completed Changes states.
- `node apps/desktop/.probes/canvas-capture.mjs` captured Canvas overview, full-view and
  narrow states after loading completed and the native guest reported visible.
- Captures are in `/tmp/modex-roadmap-shots`; the `.probes` script is local scratch per
  repository convention. Pixels were inspected for private data and layout/clipping.
- Electron's host capture excludes the child WebContentsView. Each Canvas state therefore
  has separate host and `-guest.png` images; they are not composited or presented as a
  complete native-window screenshot. macOS `screencapture -l` returned “could not create
  image from window.” The E2E native-input and bounds checks are separate evidence, not
  a substitute for a human keyboard/VoiceOver review.

## Signed update installation

`engine/updates.ts` and `UpdateBanner.tsx` only offer GitHub release notifications.
No installer download/progress/recovery or publisher authentication exists in that service.
The current published v0.0.10 assets are DMG, ZIP, checksums and verification log; its
protected release run `37988118995` passed. The release pipeline signs annotated tags,
Developer ID binaries and notarized/stapled artifacts, but does not publish updater manifests.

Implementation must retain a main-owned state machine and stable/no-downgrade policy,
verify publisher authenticity and bytes before installation, persist pending downloads,
and integrate explicit restart with graceful shutdown. Active turns and approvals must
block installation before `runner.dispose()` stops them. Composer drafts are React state,
so they must be persisted or veto installation; Space already has an unsaved-edit veto.

Electron updater lifecycle can close windows before ordinary `before-quit` handlers;
use one shutdown coordinator and test vetoes on a packaged signed upgrade.
Source: https://www.electronjs.org/docs/latest/api/auto-updater

The repo pins electron-builder 26.15.3. Its matching updater supports download events and
Mac/Windows native signature verification. Do not copy unreleased v27 signed-manifest APIs.
Linux needs an explicit signed-manifest/artifact trust anchor or distribution trust; a hash
in unsigned metadata only checks consistency, not publisher identity.
Sources: https://www.electron.build/v26/docs/features/auto-update/ and
https://www.electron.build/docs/features/signed-update-manifests/

## Native Windows/Linux delivery

The repository has only macOS desktop and iPhone CI; REST reports no self-hosted runners.
GitHub-hosted native jobs can be added, but current code has no native acceptance receipts.
The release-signing environment has Apple/tag secret names and a required BunsDev reviewer;
Windows signing and Linux update trust provisioning are not evidenced.

| Boundary | Owner | Required work |
| --- | --- | --- |
| CLI discovery | `cli-path.ts`, `shell-env.ts`, backend health | Windows executable extensions/launch strategy; replace Unix login flags and `/bin/zsh` assumptions. |
| Process ownership | `terminal-process.ts`, `terminal-supervisor.c`, Codex backend | Native descendant-cleanup receipts; Windows taskkill and negative-PID fallbacks need actual acceptance. |
| Credentials | `secrets.ts`, `index.ts` | Generic SecretStore must reject Linux `basic_text`, as ChatGPT/WorkOS already do. |
| Build | desktop package scripts and terminal preparation | Replace Unix `cp`; provide native test fixtures rather than hiding failures with blanket skips. |
| Packaging | package/build configuration and release workflow | Native NSIS and Linux targets, ABI validation, install/start/CLI/PTY/upgrade/uninstall acceptance. |

Source for Linux storage limitation: https://www.electronjs.org/docs/latest/api/safe-storage

## Deferred automations

Cloud tasks and scheduling remain deferred until the three desktop deliverables meet their
local acceptance gates. The later proposal must specify CLI-owned execution, durable schedules,
timezone/DST/missed-run policy, isolated worktrees, credential availability, approvals,
cancellation and restart recovery. No unattended API execution mode is authorized.
