# CR-4 overview implementation

**Status (2026-10-30): delivered** in #393 (`6c40547`), integrated through #404 and shipped in v0.4.0. Evidence: [CR-4 review](../../reviews/2026-10-23-cr4-overview.md). Original-reference comparison and human accessibility remain open on #323.

Implement the accepted #320/#323 design in the existing Code Review host. Use its account-scoped Reader, read models, Markdown renderer, tokens and unavailable capabilities. No GitHub writes or foreign-code execution.

1. Add red model tests for stable, deterministic activity pagination, failed-page completeness, strict external preview destinations and ambiguous/cyclic stack data. Implement pure presentation helpers.
2. Replace the overview placeholder with title, metadata, Markdown description, activity filter/timeline, paginated reads, compact checks/reviewers/changes/stack sidebar and provenance-labelled deployments. Reuse Reader cancellation and revision scopes; retain nodes during refresh and session scroll across navigation. Expose explicit action slots, leaving unavailable capabilities honest.
3. Implement a bounded inferred stack read from GitHub REST branch relationships, documenting the exact source and refusing ambiguous/cyclic ordering. Test the real service with synthetic transport.
4. Add Electron R1/R2 tests through main's fixture handler for pagination, refresh, malicious text/links, keyboard expanders, narrow layout and scroll clearance. Review saved screenshots separately from original-reference fidelity.
5. Run pnpm build, pnpm test and pnpm test:e2e; record exact evidence and limitations in docs/reviews and docs/status.md. Independently review the diff, sign commits, push and open a reviewable PR. Do not merge.

## Review focus

A delayed page must not land under a different PR/account; failed refreshes must not imply empty activity; old revision checks must remain incomplete; comment links must never become provider status; ambiguous branch relations must not become a numbered stack. Missing original reference assets leave visual fidelity unproven.
