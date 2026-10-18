# Conversation fidelity acceptance, 2026-10-18 (preparation)

The acceptance receipt for tracker [#273](https://github.com/TypeSafeAI/modex/issues/273) and its
gate [#281](https://github.com/TypeSafeAI/modex/issues/281) (CF-8). **The gate is not passed.** This
receipt records what is verified, how, and every gate still open. A green mock or fixture test is not
recorded as live-provider or human acceptance.

## Candidate

No integrated candidate is pinned yet: CF-2 (#275, PR #286) and CF-3 (#276) have not landed, and
several children have parts still open. Each row names the build it was checked on.

## Children

| Child | Landed | State |
| --- | --- | --- |
| CF-1 #274: identity, phases, outcomes | #282 → `7780093` | Done; closed |
| CF-2 #275: Claude Stop and cleanup | PR #286, green, waiting to update over CF-4 | Owned by another session |
| CF-3 #276: human requests | In progress, stacked on PR #286 | Not landed |
| CF-4 #277: typed turns, Markdown | #284 → `8e26534` (typed turns); Markdown slice is PR #283 | Partial |
| CF-5 #278: evidence | #287 → `d3711c6` (first part) | Partial |
| CF-6 #279: journal and clients | #285 → `fb76aac` (CF-1 half) | Partial; request half waits for CF-3 |
| CF-7 #280: plans and Notes | #289 → `f6976df` (first part) | Partial; question cards wait for CF-3 |

## Integration matrix

| Requirement | Evidence | State |
| --- | --- | --- |
| Golden path: request → plan → approval → real edit → check → answer → Save to Notes → Open → restart restores, nothing re-runs | `e2e/conversation-fidelity.spec.ts` "golden path", against the real app, main process and `claude -p` adapter with a fake Claude CLI. Asserts file bytes, execution counts `{edits: 1, checksStarted: 1, checksFinished: 1}` before and after restart, plan statuses, outcomes, note revision 1 → 2 on the same page, and identical `thread:items` after restart | Verified with a fixture CLI, not a live provider |
| A plan or clarifying question answered during the path | — | Open: needs CF-3 |
| Paired-client reconnect in the path | CF-6 unit tests (journal replay, the phone's full and delta snapshots); `journal-resume.test.ts` | Verified in unit tests; not yet inside the golden fixture |
| Denial: file unchanged, nothing runs | "a denial leaves the file as it was and runs nothing": bytes unchanged, counts `{}` | Verified (fixture) |
| Command failure | "a failing check is a failed command": the tool is failed, and the plan step stays in progress | Verified (fixture) |
| Unknown outcome | CF-1 and CF-6 unit tests: a dropped stream; work left running at a restart | Verified (unit) |
| Stop while executing | "Stop while a check runs": stopped, the check never reports, nothing retried | Verified (fixture); CF-2 refines Stop |
| Request withdrawal; simultaneous desktop and phone answers; reconnect after a decision send | — | Open: needs CF-3 |
| Old snapshot migration | `test/conversation-migration.test.ts` | Verified (unit) |
| Journal off | The golden fixture runs with the journal off, the default | Verified (fixture) |
| Expired cursor | Existing `event-journal.test.ts` resume and reload cases | Verified (unit, existing) |
| Stale Note revision | `task-context.test.ts`: a note edited since is kept and the new record becomes a new note | Verified (unit) |
| Missing artifact | — | Open: CF-5's owned-artifact actions |
| Outcomes, reasoning and provenance match recorded events | CF-1 fixture tests on Claude Code 2.1.302 and codex-cli 0.163.0 captures; CF-5 evidence tests | Verified on captures, not live |
| Themes at 900×600 | `e2e/typed-turns.spec.ts`: Graphite, Jev and OpenCoven, no sideways scroll | Partial: no wider reference viewport, no committed references |
| Keyboard and reduced motion | Existing `app.spec.ts` accessibility test; the new elements add no animation | Partial; human VoiceOver open |
| Long transcript and streaming measurement | CF-5: a 3 MiB Codex stream from 584 ms to 76 ms in a unit test | Open: no named-environment measurement |
| Live Codex and Claude acceptance | Captures only (2026-10-18, Haiku 5.5 and gpt-6-astra, benign tasks) | Open: needs authorized live runs through the app |
| Human VoiceOver | — | Open: human |
| Fresh `pnpm build`, `typecheck`, `test`, `test:e2e` on a pinned candidate | Per-PR results in #282, #284, #285, #287, #289 | Open until a candidate is pinned |

## Commands and results for this preparation

On `cf8-fidelity`, on `main` at `f6976df` (CF-7 landed), macOS (Apple Silicon), Node v24.18.1, pnpm 10.34.5:

- `pnpm build` (all apps): passed.
- `npx playwright test e2e/conversation-fidelity.spec.ts e2e/task-to-notes.spec.ts`: 6 of 6 passed (44 s).

These are acceptance tests of behaviour CF-1 through CF-7 already built, so they had no red phase.

## Next

1. Land CF-2 (#286) and CF-3. Then add the question, withdrawal, simultaneous-answer and
   reconnect-after-decision variants to the golden fixture.
2. Pin a candidate SHA and run fresh full checks on it.
3. Run authorized live Codex and Claude smoke tasks through the app, and record versions, models and
   limits.
4. Get human keyboard and VoiceOver acceptance, commit reference captures, and measure a long
   transcript on a named machine.
EOF
cd /Users/buns/Documents/GitHub/TypeSafeAI/modex/.worktrees/cf8-fidelity && git status --short