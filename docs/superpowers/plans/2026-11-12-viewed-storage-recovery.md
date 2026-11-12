# Viewed storage recovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this one-task repair inline, with a final independent review.

**Goal:** Preserve local Viewed session marks across failed storage writes.

**Architecture:** Keep a pending document per storage object only after a write fails; clear it after the next successful write. Existing validation and eviction remain authoritative.

**Tech Stack:** TypeScript, Node test runner, Electron Playwright, pnpm 10.34.5.

**Spec:** docs/superpowers/specs/2026-11-12-viewed-storage-recovery-design.md

## Global constraints

Preserve local-only behavior, account/repository/PR/revision isolation, 200 PRs and 3000 paths. Do not edit owner branches, enable Code Review, run live inference or release.

## Review focus

Storage becoming writable again must retain pending changes and release the fallback. A different storage object must not inherit unsaved marks. Persisted marks must stay unmarked across later failed writes. Head/base changes must not resurrect old revision marks. Normal successful storage reads must still observe external changes.

## Task 1: Retain failed Viewed writes

- [x] Run the existing workspace tests on clean main as baseline.
- [x] Add failing production-helper tests for mark A, mark B, unmark A, later toggle, reload helper reads, denied reads, stale persisted marks, isolation and recovery. Expected: exact literal arrays; failures must show lost session state.
- [x] In apps/desktop/src/renderer/code-review/viewed.ts, preserve the existing loadViewed and setViewed signatures and store only failed writes in a WeakMap keyed by Storage. Expected: focused tests pass with existing normal-storage/eviction tests unchanged.
- [x] Add an Electron regression that makes only Viewed storage writes fail and verifies two marks and an unmark through actual controls without GitHub writes. Preserve its RED and GREEN outputs.
- [x] Run pnpm build, pnpm typecheck, pnpm test and pnpm test:e2e, retain first failures/skips and update docs/status.md plus a dated receipt.
- [ ] Make signed commits, obtain one independent final review, apply any Important/Critical corrections in one RED-to-GREEN pass, then preserve recovery and publish a reviewable PR. Protected delivery requires fresh hosted/queue checks and actual merge proof.

**Interfaces:** Existing loadViewed(storage, key, revision): string[] and setViewed(storage, key, revision, path, viewed): string[] remain unchanged; the view continues using the same calls.

## Validation status

Build/typecheck and full units passed. The first canonical desktop E2E failed522/17/1 on an existing draft-input case; that first failure remains unexplained and preserved. The unchanged affected actions/diff suite subsequently passed50/50, with separate site8/web4 passes. The one independent review found no Critical/Important code issue; the interim receipt discrepancy is corrected. Publication is draft only; full current-head hosted qualification and actual protected delivery remain required.
