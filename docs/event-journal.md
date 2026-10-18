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
in pages of at most 10,000. `replayItems(entries, threadId)` rebuilds a transcript the way clients
apply events: an `item` is an upsert by id, so a frame delivered twice changes nothing. Two tests check that a real session replays exactly to its saved transcript:
`test/event-journal.test.ts`, using the scripted runner, and `e2e/event-journal.spec.ts`, using the
app with the flag on.

Each journal file has its own id, kept in its `meta` table. A cursor means something only together
with that id: after the file is deleted, a new file starts over with a new id, so an old cursor
can't skip events.

## Resuming after sleep or a reconnect

`EventJournal.resume(id, cursor, { threadId })` answers a reconnecting client in one synchronous
step. It returns the newest cursor and either the events after the client's cursor or nothing,
which means "reload state". A client is told to reload when its cursor:

- came from another journal file;
- is older than what retention kept;
- is ahead of the journal;
- is more than 10,000 events behind.

**Paired desktops.** While the journal is on, the desktop host sends thread events to paired
desktops from the journal as each batch is written. Each SSE frame carries its cursor as `id:`. The
stream's first `connected` frame names the journal, the cursor the stream starts after, and whether
it resumed. A reconnecting desktop asks for `/events?journal=<id>&after=<cursor>`, and a client
only asks a host that named its journal, so older hosts never see the query. The host reads the
journal and registers the stream in the same synchronous step, so no batch falls between the
replay and the live events. The client drops any frame at or below its cursor.

On a resumed reconnect, the Store edition refreshes its thread list and the selected thread's
Changes, but keeps its loaded transcripts: the replay brings them up to date. When it can't resume,
it reloads everything as before. It also closes the stream when the Mac goes to sleep and reopens
it on wake, rather than waiting 45 seconds for a heartbeat timeout. A replay over 4 MB reloads
instead. A stream that falls 8 MB behind is dropped, and its client resumes from its cursor.

Thread events reach paired desktops up to 250 ms later while the journal is on: they arrive with
the batch that wrote them. The local window still gets each event as it happens. If the journal
stops, the host ends every stream, and each client reconnects without the journal and reloads.

**The iPhone companion.** The phone still polls `/v1/snapshot` every 2.5 seconds, which keeps its
thread list current. With the journal on, a snapshot for a selected thread includes
`journal: { id, cursor }`. The phone sends those back as `journal` and `after`. If the Mac can
resume them, `items` holds only that thread's items that changed after the cursor, marked
`delta: true`. The phone replaces each changed item by id and appends new ones. Changing threads,
reconnecting or forgetting the Mac drops the cursor, so the next snapshot is a full transcript.

`test/journal-resume.test.ts` is the paired sleep test. The scripted runner and a real journal run a
turn. A paired desktop over TLS and the phone's HTTP requests catch up. Both clients then sleep, a
second turn runs, and both wake. The desktop must resume without reloading and receive each item
exactly once. The phone must receive only the sleep's items, and both transcripts must match the
Mac's. `CompanionModelTests` checks the phone's merge.

These rules make that work:

- **A row never changes.** Merging happens only in the pending batch, and every read flushes that
  batch first. A client that keeps the highest cursor it applied misses nothing and gets nothing
  twice.
- **A snapshot needs a matching cursor.** A snapshot and its cursor are read with no `await`
  between them.
- **Applying an event twice changes nothing.** An `item_update` patch carries whole field values,
  and clients apply an `item` as an upsert by item id.

## Typed conversation state

Transcript items carry the fields of the [conversation-event contract](conversation-events.md):
`origin` (turn, attempt, runtime and native ids), `phase`, `reasoning` and `outcome`. They travel in
the same `item` and `item_update` events, as whole field values, so the journal stores, merges and
replays them unchanged.

- **No merging across items.** A batch merges updates only into the row of the same item id. Each
  attempt's items have their own ids, so a retry that reuses a native id never merges into the first
  attempt.
- **Converging views.** `test/event-journal.test.ts` replays a captured Codex turn through the
  runner with the journal on. Its transcript, the saved snapshot, the journal replay (also delivered
  twice) and the phone's full and delta snapshots agree on every item's id, text, phase and outcome.
- **Work left running at a restart.** A tool, message or reasoning row (or a sub-agent) that a
  process saw start but never end is settled when its thread next loads: `unknown`, spinner
  stopped. That change is saved and sent as `item_update` events, so the journal and every client
  resuming from it see the same thing. Nothing is run again.
- **The phone.** It gets `phase`, `outcome` and `reasoning` alongside the fields it already read.
  A phone that reads only a tool's title and status shows every finished tool as done, so a
  finished tool that did not succeed also says how it ended in its title: "· Failed", "· Denied",
  "· Stopped" or "· Status unavailable".

Approval and question state across replay waits for the human-request lifecycle (#276).

## Retention

Rows older than 7 days are deleted, and so are the oldest rows past 250,000. Modex prunes when the
journal opens and every hour after. The highest pruned cursor is kept in `meta`, so a client below
it is told to reload, and cursors still never repeat. Deleting rows frees pages for reuse but does
not shrink the file.
