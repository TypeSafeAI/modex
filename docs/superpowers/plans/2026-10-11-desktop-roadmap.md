# Desktop Roadmap Implementation Plan

> Execute inline using the executing-plans skill; retain this ledger across sessions.

**Goal:** Ship interactive Canvas, signed automatic updates, and native Windows/Linux installers, then disposition deferred automations.

**Architecture:** Extend existing workspace/file access and isolated guest views for Canvas. Keep updater trust and installation in main. Preserve CLI execution and account boundaries while introducing native platform packaging.

**Tech Stack:** Electron, TypeScript, React, Node tests, Playwright, electron-builder, GitHub Actions.

## Requirements and delivery evidence

- [ ] Canvas HTML/SVG/Markdown interactions, refresh on file changes, full view; traversal/symlink isolation and no privileged guest access; unit and Electron E2E evidence; merged PR and released artifact.
- [ ] Authenticated signed update download/install; progress, retry and recovery; active-turn/unsaved-work protection; adversarial verification tests plus signed packaged installation acceptance; merged PR and release.
- [ ] Windows/Linux PTY, PATH, credential, packaging and updater audit; platform fixes; native CI installers and native acceptance receipts. Cross-builds do not close this requirement.
- [ ] Cloud tasks/automation remains deferred until local readiness; after readiness, CLI-compatible proposal and necessary product decisions.

## Initial live reconciliation, 2026-10-11

- main 6c00c52, latest existing release v0.0.10 per repository ledger.
- Open PRs 152 browser extensions, 157 attachments, 158 companion sockets, 160 iOS CI, 161 README. Open issues 109 networking and 159 attachments. Other session worktree queue-composer-audit exists; no ownership taken.
- Dedicated desktop-roadmap worktree created using scripts/worktree.sh; original worktrees preserved.
- Current roadmap names automatic installation and Windows/Linux installers as future work. Canvas request comes from original rails-canvas scope, not shipped resize handles.

## Stage 1: Canvas

- [x] Inspect shared workspace types, file validation, guest navigation/session policy, renderer tabs and test harness.
- [x] Write acceptance tests for an interactive HTML preview, SVG and Markdown rendering, external file edits, full view, missing/deleted files and privileged-resource rejection; run red.
- [x] Implement smallest conventional extension of existing workspace architecture with bounded authorized file reads and isolated previews.
- [ ] Run targeted unit/E2E, then build, typecheck, full unit/E2E. Record review and delivery evidence; signed commit, PR, protected merge.

## Stage 2: signed updates

- [ ] Inspect release signing/publication and updater mechanisms; choose publisher-authenticated metadata and artifact verification compatible with installed app trust.
- [ ] Cover untrusted/tampered artifacts, partial downloads, retries, active turns, draft persistence and installation/relaunch behavior.
- [ ] Implement, run signed packaged acceptance, document and deliver through protected PR and release process.

## Stage 3: native platforms

- [ ] Audit platform assumptions and available native runners/signing credentials without exposing secrets.
- [ ] Implement and test platform process lifecycle, login PATH, encrypted storage and packaging.
- [ ] Build installers on native runners and verify install/start/CLI/PTY/update/uninstall behavior with receipts.

## Stage 4: completion audit

- [ ] Match every requirement to authoritative runtime/test/PR/release evidence.
- [ ] Reconcile deferred Cloud/automation readiness and proposal.
- [ ] Retire only this session's delivered worktree; leave active goal for any missing requirement.

## Progress 2026-10-11

Canvas implementation and expanded focused acceptance passed (3 resource unit tests and 6
Electron E2E tests). Independent specification and code review findings were reproduced,
fixed and re-reviewed. Full build, unit and typecheck gates passed. Desktop E2E passed
167 cases with 3 opt-in live-runtime skips; all 7 site E2E cases passed after retrying a
port collision. See `docs/reviews/2026-10-11-desktop-roadmap-audit.md` for evidence, the
fixture cleanup repair, and updater/platform gaps from the independent audit.
No release or native-platform acceptance is claimed.
