# Local-model refresh preservation

## Candidate and scope

The `model-refresh-preservation` candidate starts from protected main `0e4e2126737874bb6604e9dece6334aa789f7c34`, including #502's model search and #501's Code Review decision record. This change adds two canonical Electron cases and an observer fixture; production application source is unchanged. It covers delayed metadata preservation under #381, without claiming the complete S2 or AC3 clauses, real-model qualification, ordinary product admission, paired-client provenance or human acceptance.

The fixture requires a disposable `modex-e2e-home-*` directory under the system temporary directory, scripted E2E mode and a mock default backend. It reuses the existing local-model workflow bootstrap. Discovery and coding observers call the original methods with their original receivers and return their results. The tests use bounded local metadata servers and request no coding turns.

## Reproducible cases

- `local-model-preservation.spec.ts` holds Alpha's metadata response while switching between a cloud thread with a staged image and a separately pinned Beta thread. It verifies exact multiline drafts, staged PNG bytes, unchanged target/revision, search query/focus/selection and composer selection after metadata delivery. Both transcripts remain empty and sampled coding dispatch counters remain zero.
- `local-model-profile-revision.spec.ts` holds metadata while editing an unsaved connection form, then checks the form's raw values, focus and selected text after delivery. A second held request is bound to its exact main-owned request ID. Saving a replacement endpoint increments the connection revision; the old request completes as stale and the old thread target remains pinned to its original revision, with unavailable-server provenance and its draft retained.

The second case explicitly records whether the old HTTP response was already destroyed at release. Cancellation followed by a stale main completion is distinct from rejection of a delivered late body. The absence of the stale model ID is asserted at a checked point, not as an exhaustive future guarantee. Metadata logs contain method/path/auth-presence observations, not account credentials or file contents.

## First failures and setup correction

The first canonical run passed the cross-thread case but failed the profile field's post-refresh selection assertion: the caret was at `{start:15,end:15}` instead of `{start:0,end:3}`. A diagnostic run added the same assertion immediately before releasing metadata and failed there with the identical range. The keyboard setup had not established the intended selection, so these failures do not demonstrate refresh-driven product selection loss.

The correction establishes the profile field's range with `setSelectionRange(0, 3)` after focusing it. The pre-release and post-delivery assertions remain unchanged. The search case separately retains real keyboard selection and navigation coverage. No production repair or relaxed deadline was introduced. Both failed runs, source snapshots, traces and receipts are retained outside the worktree before subsequent Playwright runs can replace their output.

## Verification and delivery

The corrected targeted command `pnpm exec playwright test e2e/local-model-preservation.spec.ts e2e/local-model-profile-revision.spec.ts` passed both cases in 3.8 seconds with no skips or observed retries. Both receipts report passed state and returned application close. Five generated artifact files were copied outside the worktree and byte-verified. Source hashes and original process handles are retained in the external closeout checkpoint.

Independent read-only review found no Critical, Important or Minor findings in the three test/fixture files and independently verified all 17 archived files across the first canonical failure, pre-release control failure and corrected passing run. Programmatic profile selection does not qualify native Home-key behavior. Root build and typechecks passed. Full root units passed with 2,478 passes, 36 skips and zero failures or cancellations (2,514 total); full Electron/site E2E qualification is in progress. This candidate has not been committed, pushed or delivered through the protected queue. No issue checkbox advances on these targeted results alone. #381 still needs the full grouping/qualification/reachability/state-preservation requirements, native compatibility-test controls and evidence states, supported paired provenance, and applicable keyboard/minimum-window/human evidence.

#502 itself is already delivered as protected main `bf497f72b07b2c283a90b5aaa7dfa84f57e3cf39`; its exact reviewed tree and queue results are recorded in the [model-search review](2026-11-12-model-search.md). This candidate's later tests are separate evidence, not retroactive source-head qualification for #502.
