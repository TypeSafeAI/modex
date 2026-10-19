# Conversation fidelity

What Modex shows about a coding turn, where each fact comes from, and what it does not claim. It is
the user-facing summary of tracker [#273](https://github.com/TypeSafeAI/modex/issues/273). The
contracts behind it are [conversation events](conversation-events.md),
[evidence](conversation-evidence.md), [task plans and records](task-context.md) and the
[event journal](event-journal.md). The acceptance matrix and its open gates are in
[the acceptance receipt](reviews/2026-10-18-conversation-fidelity-acceptance.md).

Coding still runs only through `codex app-server` and `claude -p`. Nothing described here executes,
replays or re-sends anything by being shown, reloaded or reconnected.

## Supported

| Feature | Codex (app-server, codex-cli 0.163.0) | Claude (`claude -p`, Claude Code 2.1.302) |
| --- | --- | --- |
| Message identity and phase | Native item ids; `commentary` and `final_answer` phases | Message id and block index; no phase (unspecified) |
| Final answer | The latest attempt's `final` message | The latest attempt's last reply |
| Reasoning | Summary parts; reasoning text kept apart; empty reasoning is "not shared" | Thinking text when `thinking_display` is `summarized` (summary) or other (provider text); signature-only or redacted is "not shared" |
| Tool outcome | From native status: succeeded, failed, denied (declined), unknown | Succeeded, failed, or denied when Modex refused it |
| Exit code | Reported | Not reported |
| Citations | Memory citations | None; links in the reply are labelled as the model's |
| Plan | `turn/plan/updated` | `TodoWrite` |
| Questions | A card for each `item/tool/requestUserInput` (experimental); its answers in the task record | None: the CLI sends Modex no structured questions |
| Approvals | Answered once, from the Mac or the phone; the card says who answered and whether the CLI received it | The same |
| Save to Notes | Yes | Yes |
| Stop | Native interrupt | Process stop (CF-2, [#275](https://github.com/TypeSafeAI/modex/issues/275), refines this) |

## Fallbacks

- **History from before these changes** reads unchanged. It keeps the old last-reply heuristic and
  gains no invented provenance.
- **A value a CLI does not report** stays unspecified, unknown or not shared. Modex never guesses
  one.
- **Work a dead process left running** becomes unknown everywhere it is shown, not running and not
  failed, and is not run again.
- **A phone that predates these fields** shows a tool's outcome in its title, and a plan as a line of
  text.
- **Journal off,** the default, keeps the earlier reload behaviour. Journal on replays the same items
  as the transcript.

## Privacy limits

- **Opaque reasoning** (signatures, redacted thinking) is never read, stored or shown.
- **Task records** leave out reasoning, command output and paths outside the project.
- **Streamer Mode** masks what the window shows. It does not sanitize the clipboard, accessibility
  text, images or arbitrary secrets in transcripts. Copy and Save to Notes write what the transcript
  holds.

## Migration and rollback

Every new item field is optional and additive. An older build reading a newer transcript ignores the
fields it does not know and shows the item as before. A plan item shows as text on older phones; an
older desktop ignores it. Nothing migrates state files in place. The journal stores events
unchanged, so rolling back to an older build leaves its replay working.

## Reference captures

[`screenshots/conversation-fidelity/`](screenshots/conversation-fidelity/manifest.json) holds 33
references, and its manifest records each one's state, theme, viewport, scale, source build and hash.

- **Fidelity states.** `e2e/conversation-fidelity.spec.ts` captures a turn waiting for approval,
  running a check, failed, completed and restored after a restart, in Graphite, Jev and OpenCoven, at
  the 900×600 minimum and at 1440×900. They come from the real app with a fixture Claude CLI.
- **Typed turn.** `e2e/typed-turns.spec.ts` captures a typed turn in each theme at 900×600, from
  items sent to the window over the mock engine.

None of them is a provider screenshot or a pixel baseline. Each capture checks only that nothing
scrolls sideways. To regenerate them, run both specs after `pnpm build` with
`MODEX_SCREENSHOTS=<dir>`.

## Performance

`e2e/transcript-measure.spec.ts` opens a 1,400-item transcript and streams a 3 MiB command log
through the app. With `MODEX_MEASURE=<file>` it writes the timings and the machine they ran on. The
receipt compares one Mac before and after these changes. The spec asserts two bounds that hold on any
machine: no streamed update carries more than the 256 KB preview, and opening a saved thread resends
none of its items.
