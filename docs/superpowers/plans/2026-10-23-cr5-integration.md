# CR-5 integration and delivery plan

**Goal:** Deliver the specified CR-5 remote diff behavior in a signed, review-ready PR, coordinated with #393, without merging or releasing.

**Spec:** #324 and the user's explicit CR-5 goal; `docs/design/code-review.md`, controls C63–C79. The existing CR-5 implementation and its evidence are input artifacts, not fresh acceptance proof.

**Architecture:** Preserve the pure patch/page models, existing Reader scope checks, and pure Diff presentation. Integrate CR-4 overview callbacks with CR-5 Changes in PrPane; retain both CSS sections. Use no local filesystem or mutation handler for remote content.

## Constraints and rulings

- Session `01a16970-0e09-73a1-9c1b-cdcf9bbc43f8` owns `cr5-integration` from origin/main `203a3505bfa46b67ea4cb47254ece26ac0f2da88`. The separately claimed `cr5-remote-diffs` and `cr4-overview` worktrees remain untouched.
- Input CR-5 commits: `e22575a90740ebd8987cd65e13fbdb14095c9864`, `0fd82e148d0efe4d6ac85f71c7e108302ace73ce`; CR-4: `52375d4fcba130904ff0a34769bd2107b76f8322` (#393). All integration edits occur here; publish with the CR-4 dependency explicit.
- Ruling: execute the already specified issue design and implementation plan inline; preserve existing implementations rather than duplicate them. New repairs require a failing regression first.
- Ruling: the earlier ownership question only gates taking over the other session's branch. Independent owned integration is authorized and preserves that claim.
- No merge, release, default-flag change, Viewed decision, or claim of human acceptance. Missing original references remain explicit.

## Tasks and verification

- [x] Establish isolated ownership and reconcile live main, #393 and existing CR-5 commits. Post the shared-file coordination checkpoint on #393.
- [x] Add an actual-control Electron regression requiring populated overview and remote diffs together; observe failure against the standalone CR-5 renderer. Resolve PrPane/CSS integration, then run renderer typecheck, focused patch/page/overview tests and Electron remote/local/navigation/overview/IPC journeys.
- [x] Inspect the R4-size and narrow captures, measure 1,000-file/3 MiB fixtures, and record request/DOM/heap/latency evidence plus criterion-level limits. Compare the original R4 if available; otherwise disclose the missing source.
- [x] Run full `pnpm build`, `pnpm test`, and `pnpm test:e2e`, preserve first failures and artifacts, and repair concrete failures without weakening assertions.
- [ ] Obtain a fresh whole-branch review, address important findings in one regression-tested pass, update evidence/status, sign all new commits and create a review-ready PR. Verify remote signatures, checks and scope before claiming delivery. No merge or release.

## Review focus

- Combined callbacks must preserve overview activity/checks and remote diff state across split/tab navigation.
- Head/account/PR changes must discard delayed file/context replies and make anchors outdated.
- Binary, omitted, truncated, and oversized data must keep accurate provider counts and disclose missing coverage.
- Local Changes selection and confirmed/cancelled Discard must remain unchanged.
- Large fixtures must bound retained text, pages, requests, parsed content, and mounted DOM independently.

## Execution ledger

- Fresh base build and parser/page model tests passed (12/12). The old final gate handle is missing; no live-run or full-pass claim is carried forward.
- The public signatures of both input CR-5 commits verify. New signing currently fails because the local encrypted SSH key is unavailable to this session's agent; no unsigned commits were created. Continue all reversible implementation and verification before requesting a local unlock.

- Integration RED: the populated split regression failed on its absent overview heading against standalone CR-5. GREEN: combined renderer passed it with actual R4 heading/description plus remote sections. Build/typecheck and 18 pure model tests passed.
- First combined Electron run: 60 passed, one IPC endpoint-allowlist failure. Diagnosis isolated three exact CR-4 read endpoints; only those fixture-scoped GET destinations were added, retaining the strict unexpected-endpoint assertion. The same production IPC journey then passed. First artifacts are preserved externally.

- Fresh integrated review found syntax-span amplification and missing context character admission. Added file-wide 2,048-fragment remote token preparation/plain-text fallback and a shared 64 Ki-character context budget/refund. Actual token-dense RED mounted 800,117 nodes; new model tests pass and all 63 focused Electron cases passed after the fix. Context negative control and the new aggregate/refund scenario are being verified before final full gates.

- Both corrected context admission regressions fail when admission is deliberately bypassed, and both pass after restoration; the dense-line regression also passes (113 pane nodes for four 400,000-character source lines, down from 800,117). Aggregate context admission and collapse/refund are verified. No negative-control product changes remain.
- Full build passed on candidate tree `48a611df21e1df34e7c9e6cfead45892739b72b7`; full unit/E2E chain is live in session 40784. Preserve and poll that handle before any new test run.
- Authenticated read-only main-service smoke on #393 read all 15 files, parsed actual patches, built an anchor and fetched exact-head remote context whose first line matched the patch. It left the checkout unchanged. This is live service evidence, separate from synthetic Electron evidence, and does not qualify every provider combination or race.

- Final chain 40784 exited 0 on tree `48a611df21e1df34e7c9e6cfead45892739b72b7`: build passed; 2,039 tests passed / 16 skipped; desktop E2E 428 passed / seven skipped; site E2E 7/7. All product/test inputs still match the tested tree. Final observations: 1,000-file selection 69 ms, 13,224 nodes, ten reads/four bodies; 3 MiB no code mounted; dense patches 113 nodes. Full artifacts and logs are preserved externally.
- Final delivery gate: default SSH agent still reports no identities; the matching public key is registered with GitHub, but direct signing requires a local unlock. No unsigned commit, PR, merge or release was created. Keep this goal active; the owned dirty worktree and recovery patches are preserved. Original R4 source remains unverified after nine indexed dimension candidates produced no approved checksum match.
