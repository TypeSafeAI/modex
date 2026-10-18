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

The CF-4 typed-turn spec captures a typed turn at 900×600 in Graphite, Jev and OpenCoven
(`MODEX_SCREENSHOTS=<dir>` keeps them). They are test captures from the mock engine and injected
items, not provider screenshots. No reference images are committed yet; the receipt lists that as
open.
