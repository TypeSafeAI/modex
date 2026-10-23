# CR-5 remote diffs implementation plan

**Goal:** Complete #324 against the existing CR-1/2/3 read contracts, ending with a signed reviewable PR without merging.

**Architecture:** Keep a pure bounded patch and anchor model beside the remote view. Use the existing Reader for every remote read and cancellation. Reuse pure Changes presentation only; no local filesystem or mutation handler enters the remote view.

**Spec:** #324, its refreshed execution prompt, and docs/design/code-review.md (C63–C79).

**Constraints:** Every file and line identity includes account, repository, PR and exact base/head revision. Context requests are bounded to 500 lines by the contract; the view will request 40 lines per action. Explicit binary/provider/size/incomplete states retain provider counts. Viewed remains unavailable. No golden acceptance, merge or release.

## Tasks

- [ ] Add failing pure parser/anchor tests, then implement multiple hunks, both line gutters, empty/rename/add/delete/no-newline, hostile paths, incomplete data and bounded parsing. Run focused tests and existing local Changes tests.
- [ ] Add remote grouped sections and hierarchical filtering/navigation in PrPane. Lazy-mount file bodies, preserve selection and collapsed state, wrap/highlight options, copy path and validated GitHub fallback. Add actual-control Electron tests before implementation.
- [ ] Add exact-revision context expansion with cancel/retry and outdated anchors, page reads, visible coverage and head/account/PR race tests.
- [ ] Measure 1,000 files and a synthetic 3 MiB patch on the named local environment. Enforce DOM/request bounds and record latency/memory observations; inspect R4 and narrow layouts and keyboard focus.
- [ ] Run pnpm build, pnpm test and pnpm test:e2e; review the full diff, update docs/status.md and docs/reviews with criterion-level evidence, sign commits and open a PR. Do not merge.

## Review focus

- Renamed files need base anchors using previousPath and head anchors using path.
- Context between hunks must not fabricate alignment where the sides have different lengths.
- A reply scope can match while the payload revision or context path is wrong; validate both.
- Hidden or collapsed bodies must not eagerly parse every large patch.
- Pagination failure must keep earlier files and distinguish loaded files from provider totals.

## Execution ledger

- Started from origin/main 68860a0c20ddf5792e16984b6151c556037f46b0 in owned worktree cr5-remote-diffs. GraphQL unavailable due quota; REST open-PR read succeeded with no CR-5 overlap.
- Ruling: execute the supplied detailed issue plan inline under the user's instruction to continue autonomously; no new product design approval is needed for the specified scope.

- Model/workspace tests passed 19/19; focused Electron diff/local Changes run passed 31/31. Zero-count hunk normalization and roving keyboard gutter entry were added after targeted failures. Return-navigation tests required bounded account-owned view memory and correct scroll-listener attachment.
- Full build and unit gates passed (2,034 tests; 16 opt-in skips). Renderer typecheck passed. Full E2E is live in session 71387, logging to /tmp/modex-cr5-full-e2e.log. Raw focused artifacts are preserved in /Users/buns/Documents/ModexEvidence/cr5-remote-diffs-2026-10-23/.
- Original R4 is unavailable in exact-name and image/date Spotlight searches. Fixture R4/narrow captures were inspected, but original-reference fidelity and CR-4 overview integration remain unverified.
