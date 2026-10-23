# CF-7 Claude plans: decision needed from Val

**Date:** 2026-10-22 · **Issue:** [#280](https://github.com/TypeSafeAI/modex/issues/280) · **`main`:** `ec7be57`

**Status:** decided. Val picked option 3 now, then option 1 after a capture, on 2026-10-23.

## The question

Modex shows a Claude turn's plan by reading the `TodoWrite` tool ([task-context.md](../task-context.md#plans)).
Claude Code no longer offers `TodoWrite` to Modex, so Claude turns show no plan. What should Modex do?

## What the CLI offers

Each run below used Modex's own arguments (`ClaudeBackend.args`: `-p --input-format stream-json
--output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio`,
plus `--permission-mode`). Each run sent one message and was stopped as soon as the CLI printed
its `system`/`init` event, before any model call. The tool list comes from that event.

| Claude Code | Launch | Plan tools in `init` |
| --- | --- | --- |
| 2.1.308 | Modex args, `manual` (2026-10-22, earlier live capture) | none (25 tools; only `Task`, `TaskStop`) |
| 2.1.309 | Modex args, `acceptEdits` and `plan` | none (28 tools; only `Task`, `TaskStop`) |
| 2.1.309 | the same, with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` (or `true`) | `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` (32 tools) |
| 2.1.309 | `CLAUDE_CODE_ENABLE_TASKS=1`, alone or with the variable above | none |

No launch tried brings back `TodoWrite`. `CLAUDE_CODE_ENABLE_TODO_TOOLS` is not documented;
its name and behaviour come from the 2.1.309 binary and the runs above, and it may change
without notice. Two earlier attempts on 2.1.308 also gave no todo tool: `--tools TodoWrite`
(no tools at all) and the default tools minus the writers.

The task tools' shapes, from their schemas in the 2.1.309 binary:

- `TaskCreate`: `subject`, `description`, optional `activeForm`; its result gives the task `id`.
- `TaskUpdate`: `taskId`, plus optional `subject`, `description`, `activeForm`, `status`
  (`pending`, `in_progress`, `completed`, or `deleted`), `blocks`/`blockedBy`, `owner` and
  free-form `metadata` written by the model.
- `TaskGet` / `TaskList`: read the list back.

Unlike `TodoWrite`, which sends the whole list on every call, each task call changes one task.
Modex would have to build the plan from the sequence of calls and their results.

## Options

1. **Read `TaskCreate`/`TaskUpdate` when the CLI happens to offer them.** Rebuild the plan from
   the calls (create adds a step with its id, update changes its status or text, `deleted`
   removes it), with `from: "claude-task"`. Keep reading `TodoWrite` for older versions. Today
   this shows nothing, because Modex's launch does not offer the tools. Cost: one parser and
   fixtures, which need a live capture of a turn that actually uses the tools.
2. **Launch Claude with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, plus option 1.** Claude turns get a
   plan again. Cost: it depends on an undocumented variable, and it changes what the model is
   offered. That is a behaviour change on every Claude turn, not only a display change.
3. **Say "Claude reported no plan".** Do not read or enable anything new. A finished Claude turn
   without a plan says so in its record and footer, so an empty plan is not mistaken for a
   missing feature. Cost: Claude turns have no plan view.

## Recommendation

**Option 3 now, option 1 when it can be captured.** Option 3 is honest and costs almost nothing.
Option 1 is safe because it reads only what the CLI reports, but it needs a real capture first,
and nothing would exercise it until a launch offers the tools. Do option 2 only if Val accepts
depending on an undocumented variable; if so, capture a live turn first and record the version.

## Val's answer

- [x] Option 3, then option 1 after a capture (recommended). Val, 2026-10-23, in the CF-7 close-out session.
- [ ] Option 1 only
- [ ] Option 2 (enable the variable) with option 1
- [ ] Option 3 only
- [ ] Other:
