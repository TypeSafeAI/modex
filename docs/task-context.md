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
| Claude Code 2.1.302 and earlier | the `TodoWrite` tool: `todos: [{ content, status, activeForm }]` | `pending`, `in_progress`, `completed` |
| Claude Code 2.1.309, when it offers them | `TaskCreate` (`subject`) and `TaskUpdate` (`taskId`, `status`, `subject`) | `pending`, `in_progress`, `completed`; `deleted` removes the task |

Each becomes a `plan.update` observation with `from` set to `codex-plan`, `claude-todo` or `claude-tasks`. The
statuses map to `pending`, `in-progress` and `completed`; a status Modex does not know becomes
`unknown`. Each update replaces the whole plan, and the transcript keeps one `plan` item per turn,
counting its revisions. Codex gives steps no ids, so a step is its position in the latest revision.
In plan mode, which Modex's Plan mode uses on Codex since #385, Codex proposes its plan as a `plan`
item: text, with no step statuses. Modex shows it as Codex's message. The task record keeps it as
`proposedPlan`, and the note shows it under Plan as "Codex proposed this plan in plan mode".
`item/plan/delta` is not read.

Claude Code 2.1.308 and 2.1.309, launched with Modex's arguments, offer no `TodoWrite`. An
undocumented variable, `CLAUDE_CODE_ENABLE_TODO_TOOLS`, makes 2.1.309 offer `TaskCreate` and
`TaskUpdate` instead. Modex does not set it, but reads those tools whenever the CLI offers them, as
Val chose ([decision](reviews/2026-10-22-cf7-claude-plans-decision.md)). Each call changes one task,
and it counts only once the CLI's result confirms it. A created task's id is the number in "Task #N
created". An update to a task this turn did not create is not guessed at. A live 2.1.309 turn is
replayed in `test/claude-live-capture.test.ts` (`test/fixtures/claude-tasks-2.1.309.jsonl`). In it,
Claude loaded both tools through `ToolSearch`, created three tasks and updated them. When
`node check.js` failed, it left that task in progress, and the plan shows it that way.

A finished turn that changed files or ran commands, with no plan from its CLI, says so: its footer
and saved note read "Claude Code reported no plan for this turn" or "Codex reported no plan for this
turn". A proposed plan counts as a plan. A chat turn says nothing.

The codex-cli row is the generated schema's shape. In two live default-mode turns on 2026-10-23,
neither model sent `turn/plan/updated`: each said its plan tool was not available, so those turns
show no plan ([live captures](#live-codex-captures)).

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

  The command is read inside `sh`/`bash`/`zsh`/`dash` with exactly `-c` or `-lc` and one script,
  with quotes respected. Only check commands joined by `&&`, optionally preceded by directory
  changes, count as a check. Mixed commands, redirects, dynamic shell expansion, masked failures
  (`||`), pipelines, backgrounding, syntax-only shell modes and unsupported syntax do not provide
  an unambiguous check result. Anything else is not a check, so an exit-zero `echo ok` verifies nothing, and neither does the model saying "tests pass".
- **A check passes** only with outcome `succeeded` and exit code 0. Claude Code reports no exit code,
  and its failed commands come through as failed, so a succeeded Claude check passes. A success with
  a nonzero code fails. A success with an explicit "no exit code" is unknown.
- **A check goes stale** when something that may change files runs after it:
  - a patch tool that was not denied;
  - a command that is neither a check nor known to be read-only (`ls`, `cat`, `grep`, `git status`,
    numeric-print `sed -n`, …). Git status accepts only known display flags; general Git commands,
    `find`, `env`, sorting/output tools and `rg --pre` are conservatively treated as possible writes.
    A redirect (`>`) counts as writing. Modex cannot see what an unknown
    command wrote, so it never claims verification across one.
- **The turn reads:**
  - **verified** when every check after its last change passed;
  - **failed** when one of them failed or was denied;
  - **not verified**, in three cases: a check after the last change did not say how it ended, every
    check ran before a later change, or no check result confirms the latest changes.

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
- **Commands that may have changed files no CLI named.** A shell redirect through Claude's Bash or a
  Codex `perl -pi` edit can write a file that neither CLI reports. Such a command is listed as a
  command, once, under "These commands may have changed files that neither the CLI nor Modex named".
  Modex does not guess which files it wrote. The rule is the one that makes a check stale: a command
  that is neither a check nor known to be read-only, and was not denied or failed. Records saved before
  this list existed reopen without it. Added after the CF-7 close-out's live runs, where a redirect left
  a rewritten file listed only as `read` and a `perl -pi` edit left the note with no files at all.
- **Paths.** They are relative to the thread's working directory. Paths outside it are counted,
  never named.
- **Order.** Changed files come first, then read, then searched, each in the order the turn first
  touched them. A file lists each relation once.

A finished turn's footer has **Files touched · N** when there is anything to show. It reads
**N, maybe more** when a command may have changed other files, and **not listed** when only such
commands ran. Opening it lists at most 20 files, then "and N more", then how many were outside the
project, then those commands, shown as the script their shell ran with the exact command on hover.
The note and the read-only Task view get the same sections with the same limit. The record keeps
every file and command.

## Clarifications

A CLI that needs to ask before it plans or acts asks through the [question card](human-requests.md):
Codex's `item/tool/requestUserInput`, with a control for each question. In codex-cli 0.163.0, Codex
offers the tool in native plan collaboration mode with default settings, and Modex's Plan mode on
Codex runs in that mode, so a Plan turn can ask before it plans. Codex then answers with its proposed
plan, which Modex shows as the turn's answer. On an ordinary turn, Codex asks only with the opt-in
`default_mode_request_user_input` flag (evidence and limits in
[human-requests.md](human-requests.md#codex-codex-cli-01630-app-server)). The answer reaches the CLI
once, and the plan carries on from it. Claude Code 2.1.302 sends Modex no structured questions.

The record lists every question the turn asked, in order, with the answer as its card shows it:

- an answered question gives its answer, and a secret one reads "(hidden)";
- an unanswered one reads "not answered", with why it closed: the agent withdrew it, the turn was
  stopped, or the turn ended first;
- an answer Modex could not confirm the CLI received says so (see
  [across replay and reconnect](human-requests.md#across-replay-and-reconnect)).

Nothing is filled in that the card does not hold.

## Live Codex captures

Two codex-cli 0.163.0 app-server turns, captured on 2026-10-23 with Val's authorization. Both ran in a
disposable repo, in default collaboration mode, with `--enable default_mode_request_user_input`. Each
was asked to record a plan with its plan tool, ask one clarifying question, then edit and check. Both
captures are redacted and replayed through the Codex backend and the runner in
`test/codex-live-capture.test.ts`.

- **`gpt-6.1-sol`** (`test/fixtures/codex-plan-question-0.163.0.jsonl`). Codex said its plan tool
  was not available and sent no `turn/plan/updated`. It asked through `item/tool/requestUserInput`
  in the same shape as the 2026-10-20 capture, took the answer, edited `greeting.txt` and ran
  `node check.js` (exit 0). Replayed, the record has the clarification and its answer, the file and
  the command, and no plan. `node check.js` is not a known check, so the turn is not verified. Codex
  parsed every command as an `unknown` action, so none counts as a read. After its final message,
  Codex sent no `turn/completed` in the 600 s the probe waited, and the thread stayed `active`. The
  test ends that turn itself and says so.
- **`gpt-6.1-sol` in plan mode** (`test/fixtures/codex-plan-mode-0.163.0.jsonl`), with
  `collaborationMode: plan` on `turn/start` as Modex sends it. Asked to plan a greeting checked by
  `node check.js`, and to ask first whether it should be English or Spanish, Codex read the files,
  asked through `item/tool/requestUserInput`, took the answer and completed a `plan` item. It sent
  no `turn/plan/updated` and edited nothing. The thread went `idle`, but no `turn/completed` came
  in the 300 s the probe waited. Replayed, the record has the clarification and the proposed plan,
  and the turn does not say "no plan". Modex ends the turn after the quiet period.
- **`gpt-6-astra`**, the model from the user's Codex config (`test/fixtures/codex-async-question-0.163.0.jsonl`).
  No plan tool and no `requestUserInput`. The question came as an `agentMessage` with
  `delivery: "async"` and `questions: [{ title, options }]`, a shape the 0.163.0 schema calls
  `AsyncUserInputQuestion`. Codex then slept twice (`sleep` items, 60 000 ms) and completed the
  turn still waiting. Modex shows the question as Codex's message, with no card, since there is no
  request to answer, and shows no sleep as a tool.

The parser needed no change for either shape. What these turns show, and what Val decided:

- A Codex plan in a real turn has now been observed, in plan mode, as a proposed `plan` item. A
  `turn/plan/updated` step plan has not. Val asked for one more try. Two further
  `gpt-6.1-sol` turns asked directly for `update_plan`, without the question flag: one with default
  features, one with `--disable goals`. Both said the tool was not provided, did the work and sent
  `turn/completed`. That makes four live turns on this machine's Codex configuration with no plan
  tool, so the `turn/plan/updated` path is still tested only with schema-shaped fixtures. The
  plan-mode capture came later. These two
  turns add no new shape, so they are not fixtures.
- **Questions asked in a reply.** Codex `agentMessage.questions` are kept with the reply as `asks`.
  The reply shows each question with its options. They are not a request, so pressing an option
  sends it as the next message; only the latest reply's options are live, and only while no turn
  runs. The task record lists each one as "asked in a message: the answer is the next message",
  under Not settled.
- **A turn Codex never ends.** After Codex's final answer, or the plan it proposes in plan mode, with no command running and no request
  open, Modex waits five minutes (`CodexBackend.quietAfterFinalMs`) for `turn/completed`. Any later
  item resets the wait. Then it ends the turn as completed, with a notice that Codex did not report
  it finished, and sends `turn/interrupt` so Codex closes its side. A command that outlives the
  answer keeps the turn open. After Stop the quiet end never applies: a stopped turn waits for Codex to
  acknowledge the interrupt, as any stop does, and is never recorded as completed.

## Save to Notes

Under each finished turn, **Save to Notes** (`task:save-note`, `ThreadRunner.saveTaskNote`) writes the
record as a note in the thread's project notes, through the notes store with a human actor. Nothing
saves on its own, and an agent cannot use this.

- **Saving again** updates the same note. The thread remembers each turn's note and the revision it
  saved, in the main-owned `taskNotes` field.
- **An edited note is kept.** If the note was edited since, the edit stays and this version becomes a
  new note marked "saved again".
- **A note moved to another project is kept.** Save checks its current Notes project as well as its
  revision. A Finder move or containing-folder move may preserve the revision; in that case Save
  creates a replacement in the original project and associates the task with that replacement.
  Moving within the same project does not by itself break the association.
- **A missing note is replaced.** If the note was deleted or trashed, a new one is written.
- **Saving never reruns** anything, and never reads beyond the transcript.

## Reopening a saved note

A saved task note opens as the task it saved. In Notes, a task note has a **Task view** button
(`task:note`, `ThreadRunner.taskNote`). It shows the request, the clarifications, the plan, the files
the turn touched and its verification, as the save recorded them. It is read-only.

- **What it shows is the save's record, not the note's text.** Each save also keeps the structured
  record it rendered, in `notes/.modex/tasks/<page id>.json` (see [Notes folder](notes.md#layout)).
  Saving again replaces it. Editing the note never changes it, and the Markdown is never parsed
  back into a plan or a verification.
- **It says what happened to the note since:**
  - **edited after it was saved**, with the first version that changed its title or text, and by
    whom (you, outside Modex or an agent). A move's own version is not an edit;
  - **moved** from the notes of the project the task ran in to another project's notes (#363). A
    move within the project is not mentioned;
  - the task's project **no longer has linked notes**, the note is **in Trash**, or a later save
    of the task **went to another note**, with a link to it.
- **Opening it runs nothing.** It reads the record, the note's history and the notes tree. It does not
  start a turn, call either CLI, or write the note, its history or the thread. **Open thread** only
  shows the thread; continuing is a new message there.
- Notes saved before this change have no task view. Saving the turn again writes the record.

## Not done yet

- A Claude plan with Modex's own launch arguments: Claude Code 2.1.308 and later offer no plan tool
  unless the CLI is started with `CLAUDE_CODE_ENABLE_TODO_TOOLS`, which Modex does not set
  ([decision](reviews/2026-10-22-cf7-claude-plans-decision.md)).
- A Codex `turn/plan/updated` step plan from a real turn: no default-mode turn in the
  [live captures](#live-codex-captures) offered the plan tool, nor did the codex-cli 0.164.0
  (`gpt-6.1-sol`) turn in the [CF-7 close-out](reviews/2026-10-29-cf7-closeout/checkpoint.md).
- Model-proposed or user-confirmed context relations. Every relation Modex shows is one the CLI
  reported; none is suggested.

## Retired

- **Linking a check to the plan step it verifies.** Retired by Val on 2026-10-23. Neither CLI reports
  that link, and inferring it would break "nothing is inferred". Steps stay "Reported done", and the
  turn's verification line is the verified signal. A native link from the CLI would reopen it:
  [decision](reviews/2026-10-22-cf7-step-linking-decision.md).
