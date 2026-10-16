# Routines

A routine is a standing job that Modex runs when its time trigger fires: a read-only Chat or Plan
turn in one project, whose reply becomes a Space page in that project's notes. This is Phase 1 of
the [routines spec](specs/2026-10-11-modex-routines-spec.md). Routines that change code are Phase 2
and wait for the approval gate decision.

## Making one

Open **Routines** from the rail and choose **New routine**:

- **Name**, **Project** and **Instructions**: what to look into and report.
- **Mode**: Chat or Plan. Both are read-only. There is no Agent or Full access choice.
- **Provider** and **Model**: the default provider and its default model unless you pick one.
  Auto routing never applies to a routine's turn, even when Auto is the default.
- **When**: once at a time, or every N minutes, hours or days from a start time. The shortest
  repeat is 5 minutes. Days are local calendar days, so a 9:00 routine stays at 9:00 across a
  daylight-saving change.

Each routine can be paused, resumed, edited, deleted or run now. Deleting a routine stops its run in
progress. Its past runs stay in Activity, and its page stays in Space.

## What a run does

1. Modex checks the routine as it is at that moment. A saved routine grants nothing, so a routine
   that somehow isn't Chat or Plan, or whose project is gone, fails without starting a turn.
2. It creates an ordinary thread named after the routine, in the project checkout, in Chat. Plan is
   switched on when the routine asks for it. The thread opens with a notice that says which routine
   ran it, why it ran, and that it is read-only.
3. It sends the instructions as one turn. While the turn runs, every approval the CLI asks for is
   refused, because nobody is there to answer. Each refusal is an answered card in the transcript
   with the receipt "Routine run: approvals are refused while it runs unattended". After the run,
   the thread behaves like any other, and its approvals go to you.
4. When the turn ends with a reply, Modex writes that reply to the routine's Space page and adds a
   notice to the transcript with the page title and revision.

The page lives in the project's notes, in a `Routines` folder (for example
`<workspace>/<project>/Routines/Nightly review.md`). The first run creates it. Each later run saves
it as a new revision, with the routine as the actor and `Routine run <id>` as the summary, so Space
history shows every run. Modex writes the page itself, through the same revision-checked page store
the Pages MCP uses, because a read-only turn can't write notes.

A turn that fails, or ends with no reply, is a failed run, and no page is written. A turn stopped
before it finished, from the Mac or the phone, is an interrupted run: what it had streamed is not
saved. A run still working after 30 minutes is marked failed at once. Modex then stops its turn,
and stops it again 10 seconds later if the CLI ignored the first stop.

### Read-only on both CLIs

| Routine mode | Claude Code | Codex |
| --- | --- | --- |
| Chat | `--permission-mode manual --disallowedTools Edit Write NotebookEdit` | `untrusted` approvals, `read-only` sandbox, no network |
| Plan | `--permission-mode plan` | the same read-only sandbox, with the plan prompt |

`test/routines.test.ts` runs routines through the runner on both CLIs. It checks each turn's real
options against these mappings, and that every approval was refused.

## When runs happen

Routines run while Modex is running, with a window open or not. On macOS, Modex keeps running after
its last window closes. Launch at login comes in Phase 3.

- Modex checks for due routines every 30 seconds, at the exact due time when that comes sooner, and
  whenever the Mac wakes.
- A due time that passed while the Mac slept or Modex was closed runs **once** when Modex notices,
  and Activity labels it *Missed, run on wake*. However many due times passed, it is one run. The
  next due time is the next one on the schedule after now. A due time that only waited for the
  routine's previous run to finish runs right after it, labelled Scheduled.
- The next due time moves on before a run starts, so a crash during a run never repeats it.
- While a run works, Modex holds a power-save blocker (`prevent-app-suspension`), so App Nap can't
  suspend a windowless Modex mid-run. It does not keep the Mac awake.

## Activity

The Routines view lists every run, newest first. Each entry shows:

- the routine;
- the trigger: Scheduled, *Missed, run on wake*, or Run now, with the due time;
- the start and end;
- the status: Running, Completed, Failed or Interrupted, with the reason;
- the thread, which you can open;
- the page revision the run wrote, which opens in Space.

Modex keeps the latest 200 runs.

## Quitting and crashes

- **Quitting during a run** ends it interrupted ("Modex quit while this run was working") before the
  turn stops. It writes no page.
- **A crash or kill during a run** leaves it marked running in `app/routines.json`. The next start
  marks it interrupted and never re-runs it.
- **A run whose page was written just before the crash** is found by its run id in the page history
  and recorded as completed with that revision. A run never writes the same page twice.
- **The fence.** Only the process that started a run may finish it. A routine deleted mid-run, a
  Modex quitting, or the time limit takes the run away, and a reply that arrives afterwards writes
  nothing.
- **A routine moved to another project mid-run.** The run writes its page in the project it worked
  in. The routine's next run starts a page in its new project.
- **Notes that can't be read at startup** leave a run that was left running marked interrupted.
  Every other routine still runs.

## The iPhone companion

The phone's snapshot lists the last 10 runs that ended, each with its routine name, status, end time
and thread, and names a routine's threads. It never carries the instructions or the page. When the
phone sees runs that ended since it last looked, it shows one banner, such as "Routine “Nightly
review” finished.", with a link to the thread. Runs that ended while the phone was away are
announced together, in one line. The first look at a newly paired Mac only remembers where it is,
so pairing never replays old runs.

There are no push notifications: the phone learns about runs when it is open and polling.

## Storage

`app/routines.json` holds the routines and the latest 200 runs, replaced atomically on each change.
If it can't be read, Modex leaves it as it is and the Routines view says so. Nothing is written over
it.

## Not in Phase 1

- Routines that change code (Phase 2).
- Event triggers, launch at login, agent profiles and channels beyond the companion (Phase 3).
