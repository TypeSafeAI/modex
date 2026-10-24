# CR-4 overview evidence — 2026-10-23

Scope: [#323](https://github.com/TypeSafeAI/modex/issues/323), building on the accepted CR-1/2/3 contracts. Worktree `cr4-overview`, based on `68860a0c20ddf5792e16984b6151c556037f46b0`. This records implementation and validation separately from original-reference, human accessibility and merge acceptance.

Signed implementation checkpoint: `485391a6c6ebbd6b2e9c83a1a41b744e3e135a6d`. Its ED25519 signature was verified locally against the public key registered on GitHub as Buns Mac commit signing.

## Implementation

The existing workspace now renders PR metadata, a safe Markdown description, Changes summary, filterable paginated activity, grouped commits, comment menus, compact expandable checks, reviewers, inferred stacks and provider deployment cards. All writes remain unavailable through the shared capabilities; CR-7 receives explicit callback slots. The PR-question composer remains CR-6's. Reads use existing account/PR Reader slots and revision scopes; no GitHub writes, checkout, provider inference or foreign-code execution was added.

Activity refresh and retry retain provisional pages, follow reachable cursors in order and fence obsolete responses by generation. Eligible transient failures retain earlier rows as stale evidence; revoked visibility/account data is discarded. Complete activity requires every reachable page to be fresh and complete. Stack ordering uses a bounded complete list of same-repository open PRs and equal base/head branches, refusing branching, cycles, missing roots and capped reads. Current-head deployments use fixed GitHub deployment/status GET endpoints; commenter URLs remain labelled comment content.

## Verification

- `pnpm build && pnpm test`: the first repository-wide run passed with 2,020 passes and 16 skips (117 worktree, 16 core, 1,840 desktop compiled, 21 desktop script, 10 site and 16 Store passes). One repetition after the reviewer-requested retry-path fix failed in six existing terminal-cleanup cases (bash/zsh job control, cleanup retry, close/dispose of HUP-resistant commands and PTY release). The same terminal file then passed all 9 cases in isolation. The failure is retained in `cr4-final-unit.log`, with isolated evidence in `cr4-terminal-isolated.log`; no root cause is claimed. The non-overlapping full rerun after Electron completed passed with the same 2,020 passes and 16 skips (`cr4-nonoverlap-unit.log`). This establishes a final passing full command without erasing the earlier six failures or claiming their root cause.
- `pnpm --filter @modex/desktop typecheck`: passed on the final source (`cr4-final-typecheck.log`).
- `pnpm --filter @modex/desktop exec playwright test e2e/code-review-overview.spec.ts --workers=1`: 9 passed, including the final retry-path regression. All tests use deterministic synthetic content through main's real IPC channel with a replaced fixture handler; they do not establish authenticated renderer behavior.
- `pnpm test:e2e`: exit 0; 400 desktop cases passed, 7 opt-in cases skipped, and all 7 site cases passed (`cr4-final-e2e.log`). An earlier broad run was deliberately interrupted after finding an alternate retry path requiring a source fix; it is not a passing full-suite result.
- Independent review identified mixed-generation completeness, transient row loss, partial-page traversal and retry-path coherence defects; each was fixed and the refresh defects reproduced red before passing. The review also identified missing compact controls and a fixture-only deployment path; both were implemented.

The first model/UI failures and the obsolete stack-placeholder assertion are retained separately from later passing runs. A narrow-test resize-helper argument error and temporary test TypeScript errors were corrected; no failing run is represented as a pass.

## Acceptance mapping

| Criterion | Evidence | Remaining scope |
| --- | --- | --- |
| AC1: same PR reaches top overview and scrolled activity | Electron fixture tests, normal/activity captures | Original R1/R2 comparison remains unverified |
| AC2: pagination, refresh and isolation | Model deduplication/completeness tests; delayed page, partial refresh, page retry, focus/scroll and cross-PR Electron tests; existing Reader/account tests | Live account switching was not exercised |
| AC3: truthful stale/unknown/provenance | Stale/unavailable Electron variants; existing checks contract; service stack ambiguity/cycle tests; provider deployment and denied-enrichment tests | Broader provider/repository examples remain outside this smoke |
| AC4: hostile content and safe navigation | Actual Markdown renderer with script/HTML/image/unsafe-link fixtures; strict destination unit tests; fixed main GET paths; no preview embedding | No live untrusted PR code was executed |
| AC5: readable normal/narrow content and focus clearance | 1766×1057 and 900×600 CSS captures at DPR 2; keyboard expanders and final Comment focus tests; bottom clearance; independent main/sidebar scrolling | Human VoiceOver acceptance remains open; CR-6's future floating composer is not yet present |
| AC6: honest write controls | Shared capability reasons and explicit unavailable edit/reviewer/comment controls | No write/action acceptance is claimed |

## Authenticated service smoke

A separate read-only probe used the production `CodeReviewService` and `ghTransport` with BunsDev on github.com against TypeSafeAI/modex PR334, head `5106c0d8e56d4ea3f72d37c1b1afe45f9d30a57e`. Overview, activity and 13 checks were ready; one successful current-head provider deployment with a destination was read through the real deployment/status endpoints. Activity returned complete coverage for 35 timeline objects plus opening/deployment enrichment. The closed PR's stack correctly returned unavailable rather than inventing an open-PR ordering. The probe records fixed endpoint names and sanitized counts/statuses only; no PR bodies, credentials or private content are published. This is service evidence, separate from fixture-driven Electron UI evidence.

## Rendered evidence and limits

Synthetic captures and raw command receipts are saved outside the worktree at `/Users/buns/.codex/artifacts/modex-cr4-overview/2026-10-23/`. `normal.png` and `activity.png` use 1766×1057 CSS px at DPR 2 (3532×2114 raster); `narrow-hostile.png` uses 900×600 CSS px at DPR 2. `stale.png` and `page-error.png` cover degraded reads. Normal, activity, narrow, stale and page-error captures were inspected; degraded reads remain visibly distinct and their retry controls stay reachable. The normal text/sidebar insets were adjusted against the accepted numeric geometry. No screenshot golden was refreshed.

Original R1/R2 files were absent from the design manifest's Desktop paths on this date. Their absence blocks an original-reference fidelity claim, not fixture or read-service evidence. Human keyboard/VoiceOver acceptance, authenticated Electron rendering, broader live stacks and CR-6/7 behavior remain separate gates. This work does not authorize merge, release or deployment.


## Final handoff

All required local commands passed on the implementation source `485391a6c6ebbd6b2e9c83a1a41b744e3e135a6d`; subsequent commits update evidence only. Environment: Mac17,6, macOS 26.7.1, Node v24.22.0, pnpm 10.34.5, Electron 44.4.5 and Playwright 1.63.0. The final independent retry review reported no remaining important findings. Local validation is separate from hosted PR CI and the still-open reference/human gates above. The owned worktree stays in place for review; no merge or release is authorized.
