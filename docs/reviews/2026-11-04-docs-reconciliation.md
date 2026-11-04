# Docs and plans reconciliation, 2026-11-04

Steward cycle ([#290](https://github.com/TypeSafeAI/modex/issues/290)) against `main` at `a4f2f70`, covering `32f1cb4..a4f2f70`. Val asked for goals and internal docs to be brought up to date and old plans archived; that request answers cycle 21's question 1, whether `status.md` could be collapsed.

## What moved

- 16 plans moved from `docs/superpowers/plans/` to `docs/archive/plans/`. All were already delivered or superseded, by their own state lines.
- The sticky Auto routing spec moved to `docs/archive/specs/`.
- `status.md` went from 534 to about 250 lines. Landed "In flight" entries and the v0.4.0 and review-repair sections moved word for word to [status history](../archive/status-history.md). Nothing was deleted.
- Links to moved files were updated, including two in release reviews. No other review text changed.

## Facts corrected against code

| Doc | Was | Is | Evidence |
| --- | --- | --- | --- |
| README, `llms.txt`, discovery README, auto-routing, conversation fidelity, analytics, routines, two specs, Gemini feasibility | Claude and Codex only | Four CLIs | `shared/types.ts:21`, `engine/runner.ts:168-169`, #432 |
| README | Approval gate waits on "the v0.0.5 release prerequisite" | Validation and human acceptance | v0.0.5 shipped 2026-10-03; approval rules spec |
| Conversation fidelity | Claude Stop is a process stop | Native interrupt, then SIGTERM | `backends/claude.ts:357-362` |
| Human requests | Plan mode is a prompt prefix | Dated to before native Plan mode | `backends/codex.ts:358-365` |
| iPhone Companion guide | Version 0.3.0 (build 8) | 0.4.0 (build 9) | `apps/ios/ModexCompanion/project.yml:22-23` |
| Landing page design, status | Static fallback is v0.3.0, "the last published release" | v0.4.0 | `apps/site/release.json:2` |
| Status, release signing | Merge with `gh-merge-when-green.sh` | Merge queue; the script accepts only BunsDev/river-oaks | The script's own repository check |
| Status checklist table | Next actions named landed work (#472, the CF-3 regressions, the sign-out test) | Current next actions | #472, #487, #490 |

The routines spec's recorded decisions were left alone, with a dated note beside them.

## Issue boxes re-checked

Applied to the issues on this date, with the 2026-11-01 [reconciliation](2026-11-01-issue-checkbox-reconciliation.md) rules: on-main evidence must meet the full text, and human or live rows stay unticked.

| Box | Evidence |
| --- | --- |
| #326 "Reconcile the resulting comment/review/merge state" | The record's only gaps are closed: `code-review-actions.spec.ts:67` (draft hidden after sign-out and for another account, #490) and `docs/reviews/code-review-token-check.py` (#472) |
| #327 "Build an acceptance matrix" | [Matrix](2026-11-01-cr8-acceptance-matrix.md), #472 |
| #327 "Produce an evidence matrix" | Same page's separate evidence columns and named open gates, #472 |
| #327 "Document staged enablement" | Same page, "Staged enablement and rollback", #472, #490 |

Left unticked on purpose:
- #276's two boxes: focus after answering is in open #489.
- #327's budget box and AC5: gates exist (#490), but nothing on record shows Val agreed the numbers.
- #327 AC6: the matrix is not final.
- #322, #323: re-check after #492 lands, since it edits those rows.

## Left open

- Open PRs that look overtaken: #481, #484 and #485 (carried by #490) and #486 (replaced by #488). Not closed, because they belong to their owners.
- `apps/site/release.json` still says v0.4.0 while v0.4.1 is published. This belongs to the release owner.
- `docs/reviews/2026-10-22-cf8-integrated-candidate.md:210` links a manifest that no longer exists. It is dated evidence, so it stays.
- The two sample image paths in `docs/notes.md:79-80` and the one in the v0.1.0 review are examples, not links.
- The #290 steward prompts still cite the merge script and `~/.claude/CLAUDE.md`, and that file does not exist on this Mac.
