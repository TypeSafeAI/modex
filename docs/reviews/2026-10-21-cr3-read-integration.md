# CR-3 read-service integration, 2026-10-21

This is authenticated navigation evidence for #322, not completion of Code Review Gate A.

## Candidate and boundary

- Renderer repair: `65e86ddd5ce05265c11fbfb0ac66761410badabb`, based on #346
  `8883428645e16ab7eab053cff561a3181041aec7`.
- Producer: #354 `4dd5bb59afd7d55f5c05d5580c7a1d8bb4648698`, including #349.
- These sources merged without conflicts. The shared `mergePages` helper is identical on both
  sides. The final integration commit and required CI are recorded on the integration PR.
- The built Electron app used a disposable app home, without `--demo` or `MODEX_E2E`.
  `localStorage["modex.codeReview"] = "on"` enabled the development surface. No IPC handler,
  transport, or GitHub reply was mocked for this probe.
- The existing authenticated GitHub CLI performed read-only requests. No coding turn, GitHub
  mutation, remote checkout, private screenshot or private content export was performed.

## Observed through the real app

The probe exited 0 after checking:

1. Authenticated inbox loading and a `repo:TypeSafeAI/modex` search, with displayed authored rows
   belonging to that public repository.
2. Public PR #349 and #348 resolved from their links; the selected identity and overview-derived
   changes totals appeared through the actual service boundary.
3. Back and Forward restored the selected PR. Changes and split views responded through their
   actual controls.
4. A pin survived renderer reload and reopened the correct PR after renderer reload.
5. A nonexistent public PR produced an explicit resolve error.
6. A separate disposable home with an empty `GH_CONFIG_DIR` and token environment variables
   removed showed signed-out status and disabled search. The user's GitHub configuration was
   not changed or logged out.

The executable probe and sanitized results are retained outside disposable worktrees in
`Codex/artifacts/modex-cr3-integration/`. The probe emits check names and success/failure, not PR
content or credentials. Build and typecheck passed before this run.

## Repair regression evidence

Electron regressions first reproduced a group-level stale read appearing fresh and a repeated
PR crossing the first-page boundary. The repaired navigation suite passed all 11 tests. A later
review found that retrying an earlier page unsuccessfully, then loading a later page, hid the
failure. A twelfth regression reproduced that sequence before the per-cursor error repair.
The renderer now keeps stale, partial and unavailable notices per page, with Retry bound to that
page; row identity is deduplicated across the first and subsequent pages.

The complete renderer-repair candidate above passed build/typecheck, 1,902 unit tests (16 skips),
and full E2E: 375 desktop passes, six opt-in skips, and seven site passes. These numbers belong to
that pre-integration candidate. Fresh combined-candidate full results are recorded in the PR.

## Remaining acceptance

Account-switch races and independently stale/partial pages remain deterministic service/IPC and
renderer-fixture evidence; this run did not switch to a second real GitHub account or interrupt
the host network. Original R1–R4 reference comparison and human keyboard/VoiceOver acceptance
remain open. Overview/activity content (#323), remote diff content (#324), native AI review
(#325) and GitHub writes (#326) are not supplied by the workspace host. No complete Gate A,
release, provider-turn or live-write claim follows from this navigation check.
