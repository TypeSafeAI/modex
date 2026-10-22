# CF-7 step linking: decision needed from Val

**Date:** 2026-10-22 · **Issue:** [#280](https://github.com/TypeSafeAI/modex/issues/280) · **`main`:** `0e674e7`

**Status:** waiting for Val's answer. Nothing is implemented.

## The question

#280 asks for plan steps shown next to the checks that verified them ("Verified requires the relevant
check's observed result tied to the corresponding code/plan revision"). Should Modex link a check to
the plan step it verifies?

## What the CLIs report

| CLI | Plan step | Check (command) | Link between them |
| --- | --- | --- | --- |
| codex-cli 0.163.0 | `turn/plan/updated`: `plan: [{ step, status }]`, optional `explanation`. No id; a step is its position, and positions can shift between revisions. | `commandExecution` item: `id, command, cwd, commandActions, status, exitCode, aggregatedOutput, durationMs, processId, source, scriptPath, pluginId` | none |
| Claude Code 2.1.308 | `TodoWrite`: `todos: [{ content, status, activeForm }]`, with no id. Also `TaskCreate`/`TaskUpdate`: a task id, subject, description, status, `blocks`/`blockedBy`, owner and free-form `metadata`. | `Bash` tool call: `command`, plus the tool result | none |

Sources: the Codex schema comes from `codex app-server generate-json-schema` (`TurnPlanUpdatedNotification`,
`ThreadItem`), produced offline with no model call. The Claude Code fields come from the tool descriptions
in the installed 2.1.308 binary. Modex reads `TodoWrite` today; it does not read `TaskCreate`/`TaskUpdate`.

Neither CLI puts a step reference on a command, or a command reference on a step. Claude's
`TaskUpdate.metadata` is written by the model, so a tool-call id there would be the model's claim. It is
not an observed link, and the same goes for an "I ran the tests for step 3" sentence.

## Why inference is not acceptable

The only ways to link a check to a step today are guesses:

- **Timing.** "The check ran while step N was in progress." Plan updates arrive after the fact. Codex
  coalesces them, Claude often marks several todos at once, and more than one step can be in progress.
- **Text matching.** "Step 'Run the tests' and the command `pnpm test` match." This is a heuristic
  over prose.
- **Model metadata.** Claude `TaskUpdate.metadata` is what the model chose to write.

Each would put a "verified" mark on a step that no observation supports. That breaks the rule the
shipped work rests on ([docs/task-context.md](../task-context.md)): *"Nothing is indexed, searched for
or inferred"*, and *"A step the CLI marked completed is 'reported done': what the CLI said, not a check
Modex ran."* Verification today belongs to the turn's latest change and is honest. A per-step version
would be precise-looking and wrong.

## Recommendation

**Retire step linking from CF-7**, for this reason: neither CLI ties a check to a step, and inferring
the tie would break "nothing is inferred". Steps keep "Reported done". The turn-level verification
line (`#351`, AC3) stays the verified signal. Then mark the step-linking item in #280 as retired, not
open.

**What would reopen it:** a native signal that the CLI's runtime sets, not the model. Either of these
would do:

1. **Codex:** stable ids on `TurnPlanStep`, and a `planStepId` (or similar) on `commandExecution` /
   `fileChange` items, set by the app-server for the step that was active when it ran the item.
2. **Claude Code:** the harness stamps the active task id (`TaskCreate` id) on each `tool_use` it
   executes, or `TaskUpdate` gains a harness-filled list of the tool calls made under that task.

If either appears, Modex could read it as an observed relation, with "verified" still requiring the
check's own passing result after the step's last change. Until then, nothing is built.

## Val's answer

- [ ] Retire step linking (recommended)
- [ ] Keep it open, waiting for the native signal above
- [ ] Other:
