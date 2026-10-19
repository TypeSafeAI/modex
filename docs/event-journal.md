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
that run. Turns and the state files are unaffected. This covers a write that fails while a client is
reading, since reading flushes the pending batch. That client gets "reload state", and the journal
records nothing more. Paired desktops then reconnect without it and reload, and the phone gets full
transcripts.

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

The id also changes when a journal may be missing rows. While open, the journal records
`open = 1` in `meta`, and a clean close resets it. It reopens still marked open in two cases:
the process died with a batch unwritten, which can be up to 250 ms of events the state files
already hold, or a write failed. Either way it takes a new id, so every cursor issued before then
reloads instead of resuming past the gap. An ordinary quit keeps the id, so a relaunch still
resumes.

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
instead. A stream that falls 8 MB behind is dropped, and its client resumes from its cursor. A
desktop drops any single frame over 1 MB, and then reloads instead of resuming, because resuming
would replay the same frame into the same limit.

Thread events reach paired desktops up to 250 ms later while the journal is on: they arrive with
the batch that wrote them. The local window still gets each event as it happens. If the journal
stops, the host ends every stream, and each client reconnects without the journal and reloads.

**The iPhone companion.** The phone still polls `/v1/snapshot` every 2.5 seconds, which keeps its
thread list current. With the journal on, a snapshot for a selected thread includes
`journal: { id, cursor }`. The phone sends those back as `journal` and `after`. If the Mac can
resume them, `items` holds only that thread's items that changed after the cursor, marked
`delta: true`. The phone replaces each changed item by id and appends new ones. Changing threads,
reconnecting or forgetting the Mac drops the cursor, so the next snapshot is a full transcript.
An item of a kind this Mac doesn't know, such as one a newer Modex saved before a downgrade, goes to
the phone as an info notice. Its own fields aren't forwarded. It is never sent as `null`, which
would make the phone reject the whole snapshot.

`test/journal-resume.test.ts` is the paired sleep test. The scripted runner and a real journal run a
turn. A paired desktop over TLS and the phone's HTTP requests catch up. Both clients then sleep, a
second turn runs, and both wake. The desktop must resume without reloading and receive each item
exactly once. The phone must receive only the sleep's items, and both transcripts must match the
Mac's. `CompanionModelTests` checks the phone's merge.

The same file covers faults, through the real host, phone server and desktop client over TLS:
- a SIGKILL right after an approval is answered;
- a write that fails during a phone read;
- cursors ahead of the log, pruned, and from a deleted journal;
- the 4 MB replay limit;
- a frame over 1 MB;
- a batch delivered twice.

One mixed transcript must also look the same on every path:
- the saved files;
- the live projection and stream;
- a live journal and a fully batched one, each also replayed twice;
- the phone's snapshot plus its delta;
- a desktop that slept;
- a restarted runner.

Along the way it takes a duplicated answer, a late tool update, an old attempt's late text and a
withdrawn request, and it counts the CLI's runs and answers.

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
  resuming from it see the same thing. Nothing is run again. Only those items are sent, with only the
  fields that changed; a thread with nothing to settle sends nothing and is not rewritten.
- **The phone.** It gets `phase`, `outcome` and `reasoning` alongside the fields it already read.
  A phone that reads only a tool's title and status shows every finished tool as done, so a
  finished tool that did not succeed also says how it ended in its title: "· Failed", "· Denied",
  "· Stopped" or "· Status unavailable".

- **Approvals and questions.** A card carries who answered (`answeredBy`), whether the answer reached the
  CLI (`delivery`) and why an unanswered card closed (`withdrawn`), as whole field values like every other
  item field. Replay and resume show resolved and withdrawn cards inert and never send an answer. A secret
  answer is never written here. See [across replay and reconnect](human-requests.md#across-replay-and-reconnect).

## Compatibility and rollback

The schema is additive.
- **`events`:** unchanged since v0.1.0. Its columns are listed above.
- **`meta`:** a key/value table that v0.1.0 doesn't have. It holds these keys:
  - `id`: the journal's identity;
  - `pruned_through`: the highest cursor retention deleted;
  - `open`: `"1"` from open until a clean close.

**Older journals.** A v0.1.0 file, with an `events` table and nothing else, opens with every row
kept, gains an id, and replays unchanged. A v0.2.0 file keeps its id.

**Downgrading.** An older build can still read and append to a file this build wrote. Here is
what it doesn't do:
- v0.2.0 ignores `open`, so a crash it has keeps the id, and its own resume rules apply.
- v0.1.0 doesn't prune and has no cursors, so retention isn't enforced until this build opens the
  file again.
- v0.1.0's and v0.2.0's phone mapping has no case for kinds newer than themselves, such as `plan`
  (#289) and `question` (#293). It sends them as `null`, and the phone then rejects the snapshot
  until that thread's items are gone or Modex is upgraded again.

The journal is never authoritative, so deleting `events.sqlite` is always a safe rollback. It
loses only journal history, and every client reloads.

`test/conversation-migration.test.ts` builds a v0.1.0 file with that release's schema. It also
drives a file this build wrote with v0.1.0's and v0.2.0's own SQL.

## Retention

Rows older than 7 days are deleted, and so are the oldest rows past 250,000. Modex prunes when the
journal opens and every hour after. The highest pruned cursor is kept in `meta`, so a client below
it is told to reload, and cursors still never repeat. Deleting rows frees pages for reuse but does
not shrink the file.
