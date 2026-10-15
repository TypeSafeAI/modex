# Event journal

The event journal is part of Routines Phase 0. The
[routines spec](specs/2026-10-11-modex-routines-spec.md) gives the background. The journal records
every thread event with a durable cursor, so a client can later ask for exactly what it missed
after sleep or a reconnect.

## Turning it on

It is off by default. Start Modex with `MODEX_EVENT_JOURNAL=1`, and it writes
`~/.modex/app/events.sqlite` (`$MODEX_HOME/app/events.sqlite`). `state.json` and the per-thread
files stay authoritative: nothing reads the journal to decide app state, so deleting the file
loses only journal history.

If the journal can't open or a write fails, Modex logs the error and turns the journal off for
that run. Turns and the state files are unaffected.

## What it records

It records each `ThreadEvent` that main sends to the window and to a paired companion: `item`,
`item_update`, `status` and `thread`. Storage is SQLite through `node:sqlite`, with no native
module and WAL journaling.

| Column | Meaning |
| --- | --- |
| `seq` | The cursor. It only grows and is never reused, including across restarts. |
| `at` | When the row was written. |
| `thread_id` | The thread. |
| `type` | The event type. |
| `event` | The event as JSON. |

Writes are batched every 250 ms and flushed when Modex quits. Within one batch:

- later updates to the same item merge into that item's pending row;
- the newest `status` or `thread` event for a thread replaces the earlier one.

A merged row applies exactly as the separate events would have. So a streamed reply costs about
one row per batch instead of one per token, and replay is unchanged.

## Reading it

`EventJournal.since(cursor, { threadId, limit })` returns the events after a cursor, oldest first,
in pages of at most 10,000. `replayItems(entries, threadId)` rebuilds a transcript the way the
runner applies events. Two tests check that a real session replays exactly to its saved transcript:
`test/event-journal.test.ts`, using the scripted runner, and `e2e/event-journal.spec.ts`, using the
app with the flag on.

## Not yet

These are needed before Phase 0's exit tests are complete:

- A resume endpoint, so the desktop window and the iPhone companion fetch events after their last
  cursor instead of reloading state.
- The paired desktop-and-phone sleep test with no gaps or duplicates.
- A retention policy. The journal grows without bound while the flag is on.

## Notes for the resume endpoint

The journal's current behavior already settles four points:

- **The cursor excludes what the client has.** A row is written once and never changed: merging
  happens only in the pending batch, and `since()` flushes that batch before it reads. So a client
  that keeps the highest `seq` it applied and asks for `since(seq)` misses nothing and gets
  nothing twice.
- **A snapshot needs a matching cursor.** A client that starts from a full state load takes
  `latest()` and the snapshot in one synchronous step, with no `await` between them. An event
  emitted after that step has a higher `seq`. An event whose change the snapshot already shows
  may still arrive once more, and the next point makes that harmless.
- **Applying an event twice must change nothing.** An `item_update` patch carries whole field
  values, so applying it again leaves the item unchanged. An `item` event must be applied as an
  upsert by item id. `replayItems` appends because it always starts from an empty transcript.
- **Retention needs a reload answer.** Once old rows are pruned, a cursor below the oldest kept
  row must get "reload state" rather than a partial page.
