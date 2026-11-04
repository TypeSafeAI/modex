# Archive

Plans and specs that are finished or replaced, and status entries that no longer describe current work. Nothing here says what is true today: [status.md](../status.md) does, and the feature pages in `docs/` describe `main`. Boxes left unticked in an archived plan are historical. Each file's first lines say what happened to it.

Move a plan or spec here in the PR that delivers or retires it, with one state line at the top, and update what links to it. Plans still being executed live in `docs/superpowers/plans/` (created when one exists). `docs/reviews/` stays where it is: it is dated evidence, and code and tests cite those paths.

## Plans

| Plan | State | Delivered by |
| --- | --- | --- |
| [WorkOS OAuth](plans/2026-10-08-workos-oauth.md) | Delivered | v0.0.9 |
| [Browser extensions](plans/2026-10-09-browser-extensions.md) | Delivered | #152, v0.0.11 |
| [Knowledge agents](plans/2026-10-09-knowledge-agents.md) | Delivered | #150, v0.0.10 |
| [Pages agents](plans/2026-10-09-pages-agents.md) | Delivered | #150, v0.0.10 |
| [Desktop roadmap](plans/2026-10-11-desktop-roadmap.md) | Delivered, except Cloud tasks, which [status](../status.md#next) keeps out of scope | v0.0.11 to v0.1.0 |
| [Worktree hygiene](plans/2026-10-11-worktree-hygiene.md) | Delivered | #171 |
| [Release candidates](plans/2026-10-12-release-candidates.md) | Delivered | #186 |
| [Sticky Auto routing](plans/2026-10-12-sticky-auto-routing.md) | Delivered | #180, #183, v0.0.11 |
| [Images and Plugins](plans/2026-10-15-images-plugins.md) | Delivered | v0.1.0 |
| [CF-7 context map](plans/2026-10-20-cf7-context-map.md) | Delivered | #355, v0.4.0 |
| [CF-7 verification](plans/2026-10-20-cf7-verification.md) | Delivered | #351 |
| [CR-4 overview](plans/2026-10-23-cr4-overview.md) | Delivered | #393, v0.4.0 |
| [CR-5 integration](plans/2026-10-23-cr5-integration.md) | Delivered | #404, v0.4.0 |
| [CR-5 remote diffs](plans/2026-10-23-cr5-remote-diffs.md) | Superseded by CR-5 integration | #404 |
| [CR-6 isolation](plans/2026-10-23-cr6-isolation.md) | Delivered | #396, #422, v0.4.0 |
| [CR-7 intents](plans/2026-10-23-cr7-intents.md) | Delivered | #404, #410, #416, v0.4.0 |

## Specs

| Spec | State |
| --- | --- |
| [Sticky Auto routing](specs/2026-10-12-sticky-auto-routing-spec.md) | Delivered in v0.0.11 |

## Status history

[Status history](status-history.md) holds the entries moved out of `status.md` on 2026-11-04, word for word.

## Not archived, and why

- [Routines spec](../specs/2026-10-11-modex-routines-spec.md): Phase 1 shipped; Phase 2 is blocked on the approval gate decision, and Phase 3 is not started.
- [Approval rules spec](../specs/2026-10-01-modex-jev-approval-rules-spec.md): shipped with the gate off; turning it on is blocked on its acceptance decision.
- [Mac Store preview ledger](../mac-store-preview-plan.md): blocked on parity, real-CLI and fresh-user acceptance and App Review.
- [Gemini](../gemini-feasibility.md) and [Grok](../grok-feasibility.md) feasibility: live deferral decisions.
