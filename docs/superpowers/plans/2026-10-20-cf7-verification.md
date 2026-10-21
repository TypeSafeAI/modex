# CF-7 verification implementation plan

> **For agentic workers:** this plan is executed inline in the #273 tracker session (TDD, red first).
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Status, 2026-10-20:** done in #351 (`d1902d2`). The full e2e suite passed in CI, on the PR and in
the merge queue (run 39508701952). The local run stopped when the disk filled. Linking a check to the
plan step it verifies stays open on #280, because neither CLI reports that link.

**Goal:** a turn's task record says whether the turn's latest change is verified by a check that ran
after it, and never calls a step verified on the CLI's word, an unrelated command, or a check that a
later change made stale. This is CF-7 #280, its open criterion "A relevant passing check at the
recorded revision can support verification; failed/unrelated checks, missing results and later edits
cannot."

**Architecture:** a pure function in `apps/desktop/src/shared/task-context.ts` classifies the turn's
commands, in transcript order. `taskRecord` carries the result, `taskMarkdown` writes a Verification
section, and the turn footer (next to Save to Notes) shows one line.

**Tech stack:** TypeScript shared module, React renderer, `node --test`, Playwright.

**Decisions:**
- **A check** is a command whose program is a known test, build, typecheck or lint runner (`pnpm test`,
  `node --test`, `pytest`, `cargo test`, `tsc`, …), after unwrapping `sh/bash/zsh -c '…'`. Anything
  else is not a check. That includes an exit-zero `echo ok`.
- **A check passes** only with outcome `succeeded`, and an exit code of 0 or none reported. Claude Code
  reports no exit codes; its failed commands come through as failed.
- **Stale:** a check is stale when, after it ran:
  - a patch tool that was not denied ran; or
  - a command that is not a check and not known read-only ran. Modex cannot see what an unknown
    command wrote.
- **Turn state:**
  - `none`: no check ran;
  - `failed`: any current check failed or was denied;
  - `unknown`: any current check is interrupted or unknown;
  - `verified`: every current check passed;
  - `stale`: every check is stale.
- **Steps:** neither CLI links a check to a plan step, so steps keep the CLI's statuses ("Reported done").
  Verification belongs to the turn's latest change.

## Tasks

- [x] **Red:** unit tests in `apps/desktop/test/task-context.test.ts` for check classification, the
  five states, stale-by-edit, stale-by-unknown-command, read-only commands not staling, and the
  Markdown section plus "Not settled". Run them and watch them fail.
- [x] **Green:** `verification()` in `shared/task-context.ts`, plus `TaskRecord.verification` and
  `taskMarkdown`'s section.
- [x] **Red, then green:** the e2e test in `e2e/task-to-notes.spec.ts`. The footer line reads "Verified:
  `pnpm test` passed after the last change". A stale or failed check reads as such.
- [x] Update `docs/task-context.md` (replace "Not done yet: Verified steps…") and `docs/status.md`.
- [x] Run `pnpm build`, `pnpm typecheck`, the desktop unit suite and the e2e suite. Make signed
  commits and open a PR linked to #280 and #273.
