# Routines: persistent agent work in Modex

Status: **direction accepted 2026-10-11** (decisions D1–D6 below). Phase 1 and most of
Phase 0 are on `main`, unreleased: the decision service (#257), the event journal (#206, #253)
and read-only routines (#267). Phase 0's approval gate decision is still open, and Phase 2
waits on it. Each phase lands in its own PR with its own tests and a `docs/status.md` update.

## Why this exists

On 2026-10-02 the maintainer commissioned a research report on giving Modex the mechanisms of
persistent agents, like OpenAI's Dots, using the open-source CopilotKit OpenDots template as an
implementation reference and Jev as a decision layer. The report is not published.

It recommends turning Modex into a persistent agent runtime over about 24 weeks. Several of its
first-priority items conflict with rules Modex states today. This specification reconciles the
two:
- a verdict on each proposal;
- the invariants every version must keep;
- an order of work that changes rules only where it must;
- the decisions that settle the conflicts.

The feature is called **routines**: a standing responsibility that Modex runs when a trigger
fires. "Dots" is OpenAI's product name and is used here only for the research.

## The report in brief

The report keeps what Modex already does well:
- coding turns through the Codex and Claude CLIs;
- worktrees;
- approvals;
- the typed Electron bridge;
- the offline mock engine;
- Jev's routing and approval judgments.

Underneath them it proposes a durable runtime with:
- agent profiles separate from threads;
- SQLite with an append-only event journal;
- jobs, runs and a scheduler with leases and fencing;
- capability grants and isolated container computers;
- one shared Jev decision service;
- a headless daemon;
- channel adapters (AG-UI, Slack and similar).

Its first beta: a persistent agent picks up a due trigger while the desktop app is closed,
works in isolation, pauses for approval, and resumes correctly after a restart.

## Modex rules that constrain it

| # | Modex rule | Where it is stated | Effect |
|---|---|---|---|
| R1 | Coding turns run only through the `claude` and `codex` CLIs; there is no API mode. | `AGENTS.md` | Compatible: both CLIs stay the executors. Any planning, summarizing or generating a routine needs is also a CLI turn, never an API call. |
| R2 | Jev answers typed questions for Auto routing and approval rules. It never runs a turn and never sees file contents. | `AGENTS.md` | The report's new decision types (trigger relevance, urgency, notification, memory, capability choice) fall outside this role. They stay out until D2 is revisited. |
| R3 | Outbound network use is an explicit list: Sign in with ChatGPT authentication, WorkOS identity, GitHub release metadata, and Jev. | `AGENTS.md` | Slack and Teams channels, an HTTP or AG-UI listener, and remote hosting each add a network surface. Each needs its own `AGENTS.md` entry and is off by default. |
| R4 | Scheduled automations were out of scope "until the local story is complete". | `docs/status.md`, Next | Blocked the report's first-priority scheduler. D1 now allows read-only routines (Phase 1) and defines "local story complete". |
| R5 | One worktree per session, created and claimed with `scripts/worktree.sh`, pruned only by its procedure, never the primary checkout. Modex's own worktree threads already follow this. | `AGENTS.md` | A routine that changes code claims its own worktree through the same script and never runs in the primary checkout. |
| R6 | `main` is protected: signed commits, the required CI check, PR flow, squash merge. | `AGENTS.md` | Unattended work may at most push a branch and open a PR, and only as a human-approved action. Merging stays with a person. |
| R7 | Approval rules ship with the gate off. The 2026-10-11 readiness evaluation recorded a no-go, and the chained-command and incomplete-command guards were still in review when this was written. | `docs/approval-rules.md`; PRs #163 and #174 | Unattended work cannot rely on rules to approve anything yet. Until the gate is on, every action that needs an approval waits for a person. |
| R8 | Modes map to each CLI's own policy. Chat and the Plan toggle are read-only (Codex read-only sandbox; Claude with edits disallowed or `plan`). | `README.md`, modes table | A read-only routine is possible today without new permission machinery. |
| R9 | The Mac App Store edition is a sandboxed client of a host Mac, with its own architecture and review gate. | `docs/status.md` | Routines run in the direct-download app, the host. The Store edition stays a client. |
| R10 | Native modules are a known risk; `node-pty` is still a pre-release. | `docs/status.md`, Known rough edges | Prefer storage with no native module. Checked on 2026-10-11: Modex's Electron 44.4.5 ships Node 24.21.0, and `node:sqlite` (`DatabaseSync`, WAL journal mode) works there with no rebuild. |
| R11 | `docs/status.md` changes in the same PR that changes what is shipped, in flight or next. | `AGENTS.md` | Every phase updates `docs/status.md` in its own PR. |

## Verdict on each proposal

| # | Report proposal | Verdict | Modex version |
|---|---|---|---|
| 1 | Headless runtime (daemon) with a runtime API | **Adapt** | The host already exists. Modex's main process serves the window, paired desktops, the Store edition and the iPhone companion. On macOS it keeps running after the last window closes (`window-all-closed` only quits on other platforms). Phase 1 relies on that; launch at login comes in Phase 3. A separate daemon is built only if the main process proves unable to stay up. |
| 2 | SQLite with WAL plus an append-only event journal | **Adapt, staged** | The journal comes first, not a full schema move. An append-only event log with a durable cursor lets the window, paired desktops and the phone catch up after sleep without per-feature catch-up code. It uses `node:sqlite`. `state.json` stays authoritative until shadow-write and replay checks pass, and no import ever deletes the old files. |
| 3 | Agent profiles separate from threads | **Adapt, later** | A routine is a saved record: name, instructions, project, mode, backend and model policy, and trigger. Each run creates an ordinary thread. No separate agent-identity UI until routines exist and are used. |
| 4 | Jobs, runs, scheduler, leases, fencing | **Adapt** (D1) | Modex is one process on one Mac, so leases guard against a crashed or restarted host, not competing machines. Keep the fence check when a run completes, and idempotency keys for anything external. First triggers are time-based only (once, or on an interval); event triggers come later. |
| 5 | Capability registry and plugin interface | **Defer** | Today's boundary is each CLI's own tools and MCP servers, plus Modex modes, approval rules and thread policy. Each phase gives routines a fixed capability profile instead of a new plugin interface. |
| 6 | Isolated persistent computers (containers) | **Reject for now** (D4) | Modex has no container dependency, is macOS-first, and has a sandboxed Store edition. Isolation instead: read-only mode in Phase 1; a claimed worktree plus the CLI's own sandbox in Phase 2; never full access. Revisit only if unattended work needs a browser or writes outside the repository. |
| 7 | One shared Jev decision service | **Adopt, narrowly** | Auto routing and approval judgments move behind one module with versioned question sets and stored receipts. No new decision types (D2). |
| 8 | Risk tiers; Jev may only escalate | **Adopt** | This is already the approval gate's design. It is an invariant below. |
| 9 | Artifacts and Spaces | **Adopt what exists** | Space pages edited through the Pages MCP already have revision checks, history and recovery. Routine output goes to a Space page in the routine project's notes (its folder in the notes folder, for example `<workspace>/<project>/Routines/`); there is no new artifacts store. |
| 10 | Explicit user memory | **Defer** | Space pages and knowledge maintenance cover durable context today. Memory needs its own privacy design. |
| 11 | Channels (Slack, Teams, GitHub) and an AG-UI adapter | **Defer** | Each is a new network surface (R3). The existing channel is the iPhone companion; it is used first for "routine finished" and "routine needs approval". |
| 12 | Remote persistent hosting | **Defer** | Paired-desktop hosting already has this shape. An always-on Mac as host is a deployment choice, not new architecture. |
| 13 | Multi-agent delegation, distributed coordination | **Reject for now** | The report itself ranks these lowest. |

## Phases

### Phase 0: no rule changes

- Settle approval readiness: land the guards, run the human acceptance checklist, and decide
  whether the approval gate turns on.
- **Decision service:** move Auto routing and approval rules behind one module, with versioned
  question sets and a stored receipt for each judgment. Behaviour does not change. *Progress
  (2026-10-15): landed as `routing/decisions.ts`; see
  [the decision service](../auto-routing.md#the-decision-service).*
- **Event journal:** record thread events in `node:sqlite` with a durable cursor, so existing
  clients resume after sleep or reconnect. Write to it alongside the existing storage, behind a
  flag; `state.json` and the per-thread files stay authoritative. *Progress: the journal, its flag
  (`MODEX_EVENT_JOURNAL=1`) and the replay exit test landed on 2026-10-14. The resume endpoint
  for paired desktops and the phone, retention, and the paired sleep test landed on 2026-10-15.
  See [event-journal.md](../event-journal.md).*
- **Exit tests:**
  - the existing unit and e2e suites pass unchanged;
  - replaying a recorded session from the journal matches its transcript;
  - a paired desktop and the phone resume after sleep without gaps or duplicates.

### Phase 1: read-only routines

*Progress (2026-10-15): landed; see [routines.md](../routines.md). Modex writes the page itself,
through the revision-checked page store the Pages MCP uses, because a read-only turn's Pages
tools are read-only. A power-save blocker (`prevent-app-suspension`) is held during each run,
and missed runs are checked on wake.*

- A routine runs **Chat or Plan** turns on a time trigger, in one named project, while the app
  is running (window open or not). It writes its result to a Space page through the Pages MCP.
- It needs no repository writes and no approvals.
- An **Activity** list shows each run: trigger, start and end, the thread, and the page
  revision it wrote.
- Missed runs (the Mac was asleep or the app quit) run **once** on wake, never as a burst.
- The iPhone companion is notified when a run finishes or fails.
- **Exit tests:**
  - with the window closed, the routine still runs, and reopening shows it in Activity;
  - killing the app mid-run leaves the run marked interrupted on restart, with no duplicate
    page revision;
  - a routine's turns are confirmed read-only on both CLIs.

### Phase 2: routines that change code

Phase 2 requires the approval gate decision from Phase 0.

- **Agent** mode only, in a worktree claimed through `scripts/worktree.sh` with the run as its
  owner. Never full access, never the primary checkout.
- Every approval waits for a person, on the Mac or the phone, unless the approval gate is on
  and a rule decides. Jev may only make an action more cautious.
- A routine may push a branch and open a PR only as an approved action. It never merges.
- **Exit test:** a due trigger starts a turn in a worktree; it pauses for approval; the approval
  comes from the phone; a PR opens; a restart in the middle recovers correctly.

### Phase 3: later, each with its own spec

Agent profiles in the UI, explicit memory, event triggers (which needs D2 revisited), launch
at login, and channels beyond the companion.

## Invariants

These hold in every phase:

1. Coding, planning and generation run only through the `claude` and `codex` CLIs.
2. Jev answers typed questions only. It never runs a turn and never writes commands or text.
   It may make a decision more cautious, never less.
3. **Saved settings are not permission.** A routine's configuration grants nothing. Every
   action is checked against the current rules and thread policy at the moment it happens.
4. **Learning grants no authority.** Routing preferences learned from use stay separate from
   permissions.
5. No unattended full-access turn, ever. No routine in the primary checkout.
6. Without a person, a routine never merges, force-pushes, rewrites history, changes
   credentials or spends money.
7. Every unattended action leaves a receipt a person can read later, in Activity and in the
   transcript.
8. A migration never deletes old data, and rollback stays possible for two releases.
9. Every new outbound network call is listed in `AGENTS.md` and is off by default.

## Decisions (accepted 2026-10-11)

| ID | Question | Decision |
|---|---|---|
| D1 | Scheduled work | Allow Phase 1 read-only routines. Other scheduled automation, and Codex Cloud tasks, stay out of scope. "Local story complete" means the approval gate decision is made and Phase 0's exit tests pass. |
| D2 | Jev's role | Unchanged: Auto routing and approval rules only. Revisit before event triggers (Phase 3), and amend `AGENTS.md` to name exactly which trigger metadata Jev would see. |
| D3 | Event journal storage | `node:sqlite`. No native module. |
| D4 | Isolation for routines that change code | A claimed worktree, the CLI's own sandbox, and human approvals. No container computers. |
| D5 | Background running | The app stays running with no window for Phase 1. Launch at login comes in Phase 3. No separate daemon. |
| D6 | Name | Routines. |

## Open questions

- Whether Codex app-server and Claude sessions resume reliably across app restarts for routine
  threads. To measure in Phase 0.
- How macOS sleep and App Nap affect timers in a windowless Electron process, and whether the
  host needs a power-save blocker during a run. To measure in Phase 1.
- Approval rules still see a partial list when an action names more than 20 paths, or one
  longer than 300 characters. This must be fixed before Phase 2.
