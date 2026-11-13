# CR-8 access revocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove accessible-to-revoked reads and unsafe context-path refusal through Electron, including later offline fallback and a held context response.

**Architecture:** Extend the existing synthetic gh boundary with opt-in network failure and exercise the real renderer/IPC/read service. Production behavior is unchanged unless the new tests demonstrate a defect.

**Tech Stack:** pinned pnpm 10.34.5, TypeScript, Electron, Playwright, existing WORLD_GH fixture.

**Spec:** docs/superpowers/specs/2026-11-12-cr8-access-revocation-design.md

## Global Constraints

- Main is protected; use this session-owned helper-created worktree and signed commits.
- Keep synthetic gh identity stable; no real inference, token, GitHub write, policy/default/release change or owner-worktree adoption.
- All rendered prose paragraphs occupy one source line; preserve first failures, skips and exact source identities.
- Full #327 acceptance requires all clauses and protected delivery, not this slice alone.

## Review Focus

- A forbidden/not-found/gone answer must invalidate the affected PR across all six read variants; table cases cover 403/404/410.
- A delayed context response must not restore content after denial; the held-response case covers this.
- Revocation must not erase another repository's same-account offline fallback; each table case covers the unrelated PR.
- Diagnostics must not enter the renderer or replies, and reads must start no provider or mutation; every case checks these effects.
- Unsafe context paths must be refused by the actual IPC handler before transport; the path case includes one valid positive control and eight malformed inputs.

### Task 1: Integrated revocation transitions

**Files:**
- Modify: `apps/desktop/e2e/code-review-regressions.spec.ts`
- Modify: `apps/desktop/test/fixtures/code-review-gh-world.ts`
- Create: `docs/reviews/2026-11-12-cr8-access-revocation.md`
- Modify: `docs/status.md`

**Interfaces:**
- Consumes: existing `launchWithGh`, `Harness.world`, `Harness.release`, production `code-review:read`, `CodeReviewRequest` and `CodeReviewReply`.
- Produces: optional `GhWorld.offline?: boolean`, default false; five integration cases proving the contract. No new production interface.

- [x] **Step 1: Establish baseline.** Run helper check and fresh build; verify all non-document tracked inputs match the just-qualified main514 baseline (2,570 unit passes, 36 skips), then run the original regression file.

Run: `pnpm build` and `pnpm --filter @modex/desktop exec playwright test e2e/code-review-regressions.spec.ts`.
Expected: both terminal zero; all original regression cases pass.

- [x] **Step 2: Add tests first.** For each status 403/404/410, prime a visible synthetic private body plus ready overview/resolve/context/activity/checks/files reads, prime field-guide#73, check that offline mode yields its stale/offline fallback, restore network, revoke the lending PR, use the real inbox Refresh action, require an error and absent private body, then require every revoked sibling read unavailable during offline mode. Add a held context case: begin a real context read, observe its gh request, revoke via overview, release it and require unavailable with no private payload. Assert no provider starts, no writes and no leaked synthetic diagnostic marker.

Run: focused `playwright test ... --grep 'revoked access' --retries=0`.
Expected: first failure at the offline positive control while the requested fixture capability is absent; preserve this RED, not a production-defect claim.

- [x] **Step 3: Add the fixture capability.** Add `offline?: boolean` to GhWorld; after reading the world, API requests other than `user` log normally, print a fixed network diagnostic and exit 1 before any HTTP answer when offline. Existing behavior remains the default. Run the four focused revocation cases; investigate any genuine product failure with systematic debugging before repair.

Expected: four passes on the real Electron/IPC service; a product failure remains open until reproduced and repaired.

- [x] **Step 4: Prove test sensitivity.** Preserve exact production bytes, temporarily map ordinary 403 to offline in `httpFailure`, rebuild desktop main and run only the 403 case. Require a failure from stale/visible private content instead of unavailability. Restore the exact original bytes even on failure, rebuild and run the full regression file. Save mutation, RED and restored GREEN identities separately; no mutation enters a commit.

Expected: deliberate negative control fails; restored production source and the full regression file pass.

- [x] **Step 4b: Cover the remaining unsafe-path IPC gap.** Add one Electron case with a valid context positive control, then literal absolute/traversal/dot/empty/control/bidi/zero-width/lone-surrogate paths. Require the real IPC handler to reject every unsafe request before any new gh call, with zero provider starts or writes. This covers the second known integrated gap in the same #327 clause; no production behavior change.

Run: `playwright test ... --grep 'unsafe context paths' --retries=0`.
Expected: one pass; if a product defect appears, preserve its failure and repair only after a meaningful RED.

- [x] **Step 5: Qualify and record.** Run `pnpm build && pnpm test` and `pnpm test:e2e`, retaining logs and all first failures/skips. Write the dated receipt and status entry at literal tested scope, without ticking the full adversarial clause. Commit the complete slice with SSH signing; the final whole-branch review follows task completion as required by executing-plans.

Expected: applicable checks terminal zero and receipt names exact versions/revisions/results/limits; no claim of live/human acceptance or protected delivery before its own evidence.

## Final whole-branch review

After Task 1 completion, request one fresh read-only review of the entire signed branch range using the plan/spec, exact receipts and all ledger rulings. Re-grade findings by their actual effects; fix Important/Critical findings in one coalesced RED-to-GREEN pass with applicable green suites, defer Minors explicitly and do not request a second review. Hand over every ruling/cost and deferred Minor before preserving/moving only this plan’s own skill workspace. Source hosted checks, the protected queue and full literal criterion acceptance remain separate gates.

## Observed hosted-failure follow-up

The original test-only revocation slice remains as specified above. Its first hosted run exposed an existing atomic file-scan race; subsequent complete local validation exposed a global popup-locator ambiguity and a real title-bar rename-command defect. This authorized follow-up closes private test-app writers before unchanged privacy scans, follows the keyboard control's actual details-card association and consumes a Rename command only on the mounted chat title. A direct original-source regression proves the later-chat editing defect; the new command-counter guard repairs it without changing Code Review activation or provider policy.

One independent follow-up review found no Critical or Important defect. Both Minor coverage suggestions were implemented: exact saved title/provenance preservation across blur and fresh menu/double-click/Enter editing on the later keyed title. Fresh current-main build/typecheck, 2,579 units with 36 skips, 529 desktop cases with 17 skips, eight site cases and four web cases pass. The separate installed Claude Code 2.1.323 boundary run passes four ordinary checks and two intentional expected-failure controls. First failures, the stale-build diagnostic mistake, scope limits and exact evidence are retained in the dated review receipt. Fresh source-hosted checks and actual protected delivery remain gates; no full adversarial or whole-issue acceptance is inferred from this plan update.
