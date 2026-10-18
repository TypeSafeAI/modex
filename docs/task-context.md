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

`taskRecord` (`shared/task-context.ts`) summarises one turn: the request, the latest plan, the files
its patch tools changed, the commands it ran with outcome and exit code, the final answer, and what
is not settled. Not settled means commands that did not succeed and plan steps not reported done.
`taskMarkdown` renders the record as portable Markdown that ends with a backlink to the thread.

It leaves out reasoning, command output, and any path outside the project. Files inside the project
are listed relative to the thread's working directory; files outside it are counted, not named.

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

- Clarification through question cards waits for the human-request lifecycle
  ([#276](https://github.com/TypeSafeAI/modex/issues/276)).
- Verified steps, and marking earlier verification stale. Verification needs a check's observed
  result tied to the code revision the step changed.
- An on-demand context map of relevant files and tests beyond those the turn changed.
- Reopening a saved note as a read-only task view.
