# Task plans and records

A coding request's plan, as the CLI reported it, and a record of the turn you can save to the
project's notes. This is the first part of [#280](https://github.com/TypeSafeAI/modex/issues/280)
(CF-7 of tracker [#273](https://github.com/TypeSafeAI/modex/issues/273)). It builds on the
[conversation-event contract](conversation-events.md) and [conversation evidence](conversation-evidence.md).

Everything here is drawn from transcript items, and says no more than they do. A step the CLI
marked completed is "reported done": what the CLI said, not a check Modex ran.

## Plans

| CLI | Native plan | Step statuses |
| --- | --- | --- |
| codex-cli 0.163.0 | `turn/plan/updated`: `plan: [{ step, status }]` and an optional `explanation` | `pending`, `inProgress`, `completed` |
| Claude Code 2.1.302 | the `TodoWrite` tool: `todos: [{ content, status, activeForm }]` | `pending`, `in_progress`, `completed` |

Both become a `plan.update` observation with `from` set to `codex-plan` or `claude-todo`. The
statuses map to `pending`, `in-progress` and `completed`; a status Modex does not know becomes
`unknown`. Each update replaces the whole plan, and the transcript keeps one `plan` item per turn,
counting its revisions. Codex gives steps no ids, so a step is its position in the latest revision.
Codex's experimental plan-mode `plan` items and `item/plan/delta` are not read.

The plan card lists each step with its status: Not started, In progress, Reported done or Status
unknown. It also shows where the plan came from and its revision. A plan never folds away under the
turn header. When the turn ends, the card keeps the last statuses the CLI reported, and the plan's
outcome is the turn's.

## The task record

`taskRecord` (`shared/task-context.ts`) summarises one turn: the request, the questions the CLI asked
and their answers, the latest plan, the files its patch tools changed, the commands it ran with
outcome and exit code, the final answer, and what is not settled. Not settled means commands that did
not succeed, plan steps not reported done, and clarifications nobody answered or whose answer Modex
could not confirm the CLI received.
`taskMarkdown` renders the record as portable Markdown that ends with a backlink to the thread.

It leaves out reasoning, command output, and any path outside the project. Files inside the project
are listed relative to the thread's working directory; files outside it are counted, not named.

## Verification

The turn's record says whether a check verified the turn's latest change (`verification` in
`shared/task-context.ts`). It works in transcript order and says no more than the commands
reported.

- **A check** is a test, build, typecheck or lint command:
  - a package script named `test`, `test:*`, `build`, `typecheck`, `lint`, `check` or `verify`, run
    through npm, pnpm, yarn or bun (including `--filter` and `exec`);
  - `node --test`, `python -m pytest`;
  - `pytest`, `vitest`, `jest`, `mocha`, `tsc`, `eslint`, `mypy` and `playwright test`;
  - `cargo test/build/check/clippy`, `go test/build/vet`, `swift test/build`, `make test/check/build`,
    `gradle`, `mvn`, `dotnet` and `xcodebuild`.

  The command is read inside `sh`/`bash`/`zsh -c '…'`, with quotes respected. Anything else is not
  a check, so an exit-zero `echo ok` verifies nothing, and neither does the model saying "tests pass".
- **A check passes** only with outcome `succeeded` and exit code 0. Claude Code reports no exit code,
  and its failed commands come through as failed, so a succeeded Claude check passes. A success with
  a nonzero code fails. A success with an explicit "no exit code" is unknown.
- **A check goes stale** when something that may change files runs after it:
  - a patch tool that was not denied;
  - a command that is neither a check nor known to be read-only (`ls`, `cat`, `grep`, `git status`,
    `git diff`, `sed -n`, …). A redirect (`>`) counts as writing. Modex cannot see what an unknown
    command wrote, so it never claims verification across one.
- **The turn reads:**
  - **verified** when every check after its last change passed;
  - **failed** when one of them failed or was denied;
  - **not verified**, in three cases: a check after the last change did not say how it ended, every
    check ran before a later change, or no check ran after the turn's changes.

  A turn that changed nothing and ran no check has nothing to verify and shows nothing.

The finished turn's footer shows this beside Save to Notes, for example "Verified: `pnpm test` passed
after the last change", or "Not verified: `pnpm test` ran before a later change". A check shows as
the script its shell ran, with the exact command on hover. The note gets a **Verification** section
that lists every check, marking stale ones "ran before a later change". Anything short of verified
also goes under **Not settled**. A failing check that a later fix and a passing check superseded is
not listed as unsettled.

**Plan steps are not marked verified.** Neither CLI links a check to a plan step, so a step keeps the
status the CLI reported ("Reported done"), and verification belongs to the turn's latest change.
Verification covers this turn only: a later turn's edits do not change a note already saved.

## Context map

The record also lists the project files the turn touched (`taskContext` in `shared/task-context.ts`),
as the CLI reported them. Nothing is indexed, searched for or inferred: no dependency is guessed.

| Relation | Claude Code | codex-cli 0.163.0 | Offline engine |
| --- | --- | --- | --- |
| changed | `Edit`, `MultiEdit`, `Write`, `NotebookEdit` (`file_path`) | `fileChange` items (`apply_patch`) | `write_file`, `apply_patch` |
| read | `Read` (`file_path`) | Codex's own parse of a command: `commandActions` `read` (`path`) | `read_file` (`path`) |
| searched | `Grep`, `Glob`, `LS` (`path`) | `commandActions` `search` and `listFiles` (`path`) | `list_dir` (`path`) |

- **What counts.** A denied or failed tool touched nothing. A command the CLI did not parse (a `cat`
  through Claude's Bash, an `unknown` Codex action) is not counted as a read.
- **Paths.** They are relative to the thread's working directory. Paths outside it are counted,
  never named.
- **Order.** Changed files come first, then read, then searched, each in the order the turn first
  touched them. A file lists each relation once.

A finished turn's footer has **Files touched · N** when there is anything to show. Opening it lists at
most 20, then "and N more", then how many were outside the project. The note gets a **Files the turn
touched** section with the same limit. The record keeps every file.

## Clarifications

A CLI that needs to ask before it plans or acts asks through the [question card](human-requests.md):
Codex's `item/tool/requestUserInput`, with a control for each question. In codex-cli 0.163.0, Codex
offers the tool in native plan collaboration mode with default settings. A separate through-app
capture enabled the opt-in `default_mode_request_user_input` flag successfully. Modex's Plan mode
still uses an ordinary turn (evidence and limits in
[human-requests.md](human-requests.md#codex-codex-cli-01630-app-server)). The answer reaches the CLI
once, and the plan carries on from it. Claude Code 2.1.302 sends Modex no structured questions.

The record lists every question the turn asked, in order, with the answer as its card shows it:

- an answered question gives its answer, and a secret one reads "(hidden)";
- an unanswered one reads "not answered", with why it closed: the agent withdrew it, the turn was
  stopped, or the turn ended first;
- an answer Modex could not confirm the CLI received says so (see
  [across replay and reconnect](human-requests.md#across-replay-and-reconnect)).

Nothing is filled in that the card does not hold.

## Save to Notes

Under each finished turn, **Save to Notes** (`task:save-note`, `ThreadRunner.saveTaskNote`) writes the
record as a note in the thread's project notes, through the notes store with a human actor. Nothing
saves on its own, and an agent cannot use this.

- **Saving again** updates the same note. The thread remembers each turn's note and the revision it
  saved, in the main-owned `taskNotes` field.
- **An edited note is kept.** If the note was edited since, the edit stays and this version becomes a
  new note marked "saved again".
- **A missing note is replaced.** If the note was deleted or trashed, a new one is written.
- **Saving never reruns** anything, and never reads beyond the transcript.

## Not done yet

- Linking a check to the plan step it verifies. Neither CLI reports that link.
- Model-proposed or user-confirmed context relations. Every relation Modex shows is one the CLI
  reported; none is suggested.
- Reopening a saved note as a read-only task view.
