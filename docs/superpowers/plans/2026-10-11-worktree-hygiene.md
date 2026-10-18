# Worktree hygiene implementation plan

**Status (2026-10-18): delivered** in #171 on 2026-10-11. The procedure is
[worktree-hygiene.md](../../worktree-hygiene.md).

**Goal:** Run daily local pruning automatically, but only for explicitly released,
clean, inactive work whose exact commit is proven merged and recoverably archived.

**Architecture:** Keep the existing `scripts/worktree.sh` entry point. A dependency-free
Node command owns shared lifecycle records and an exclusive maintenance lock in the
Git common directory. Inventory and deletion use fresh Git/GitHub REST evidence.
A user LaunchAgent runs an installed, versioned copy outside disposable worktrees.
Remote branches, the primary checkout, active work, and ambiguous state are preserved.

**Verification:** Use real temporary Git repositories and bundles. Inject only external
GitHub/process observations in unit tests; production CLI has no safety-bypass flags.
Build and repository tests must pass before any signed commit. Review the destructive
paths independently before enabling the local schedule.

## 1. Prove preservation and eligibility

- [x] Add `scripts/test/worktree-maintenance.test.mjs` with real-repository fixtures.
- [x] Demonstrate the existing `remove` command deletes an unmerged clean worktree.
- [x] Cover primary/default, active/unreleased, dirty/untracked, ignored user files,
  locked/missing/outside-managed, active process, open PR, API/fetch failure, exact
  SHA mismatch, and mismatched squash-patch cases.
- [x] Implement `scripts/lib/worktree-maintenance.mjs`: validate paths/refs, inventory,
  claim/release records, fresh remote/default-branch discovery and GitHub REST PR proof.

## 2. Archive, revalidate, remove

- [x] Write failing tests for direct merges, exact squash merges, archive corruption,
  HEAD changes after audit, lock contention, and checked-out branch preservation.
- [x] Create unique archive refs and a self-contained bundle outside removal targets.
  Verify the bundle, restore every ref into a temporary bare repository, compare exact
  tips, and run `git fsck --full` before allowing deletion.
- [x] Recheck all gates immediately before `git worktree remove` (never force), then
  delete the unchanged local branch with an expected-SHA comparison. Persist outcomes
  and restoration commands; retain archives. Any uncertainty preserves the candidate.

## 3. Enforce the procedure at the existing entry point

- [x] Implement `scripts/worktree-maintenance.mjs` and route `scripts/worktree.sh`
  through it without changing Modex's `new <name>` / `remove <name>` output contract.
- [x] `new` claims ownership; `check` rejects released work; `claim` resumes ownership.
  `release <branch> --expect-head <SHA>` marks an exact clean tip eligible for later
  pruning. Explicit `remove <name>` uses the same archive and merged-work guards.
- [x] Expose `audit` and `prune --apply`, machine-readable reports, and npm commands.
  Put maintenance regression tests in the normal `npm test` command.

## 4. Install the recurring local job

- [x] Add `scripts/lib/worktree-schedule.mjs` and tests for XML/path escaping, stable
  runtime copies, repository identity pinning, absolute executable paths, daily cadence,
  audit logs, install/status/uninstall, and refusal to run an unverified runtime.
- [x] Install a user LaunchAgent that runs local pruning daily and on login. Its runtime
  and reports live outside every worktree; no remote write or broad filesystem deletion.
- [x] After verification/review, install and run once on this repository. Preserve all
  legacy work without explicit release; report the actual retained/removed counts.

## 5. Document and deliver

- [x] Update `AGENTS.md`, `docs/worktree-hygiene.md`, and `docs/status.md` with ownership,
  release/claim commands, archive restore instructions, schedule controls, and limitations.
- [x] Run 75 maintenance tests, `npm run build && npm test`, and typecheck. Verify the
  schedule and its first live run (39 branches, 31 worktrees, zero removals/errors).
- [x] Obtain independent specification and code-quality review; fix all reproduced findings.
- [x] Finish configured desktop/site E2E: 163 desktop passes, 3 opt-in Knowledge skips,
  and 7 site passes. Required hosted CI enables the three integration cases.
- [x] Sign and verify the implementation commit after local checks and independent review.
- [ ] Land through the coordinated protected PR queue after required CI. Preserve the
  unrelated approval/provider branch.

## Progress

- User approved automatic pruning of eligible **local** work. Remote deletion is outside scope.
- Isolated `worktree-hygiene` worktree created from `fa4e665` using the repository helper.
- Existing script removes the worktree before checking merge proof and uses `branch -D`;
  replacing this order is required. Existing unknown/active worktrees must remain intact.
