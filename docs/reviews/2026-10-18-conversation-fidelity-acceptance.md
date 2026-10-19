# Conversation fidelity acceptance, 2026-10-18 (preparation)

The acceptance receipt for tracker [#273](https://github.com/TypeSafeAI/modex/issues/273) and its
gate [#281](https://github.com/TypeSafeAI/modex/issues/281) (CF-8). **The gate is not passed.** This
receipt records what is verified, how, and every gate still open. A green mock or fixture test is not
recorded as live-provider or human acceptance.

## Candidate

Every child's slice for this gate has landed, so the fixture rows below run on `main`. No candidate
is pinned yet, because the live-provider and human gates are still open. Each row names the build it
was checked on.

## Children

| Child | Landed | State |
| --- | --- | --- |
| CF-1 #274: identity, phases, outcomes | #282 → `7780093` | Done; closed |
| CF-2 #275: Claude Stop and cleanup | #286 → `6db0818` | Landed |
| CF-3 #276: human requests | #293 → `57e7607` | Landed; a live Codex question capture is open |
| CF-4 #277: typed turns, Markdown | #284 → `8e26534` (typed turns); #283 → `a4039b2` (Markdown) | Partial: remaining Markdown checks |
| CF-5 #278: evidence | #287 → `d3711c6` (first part) | Partial |
| CF-6 #279: journal and clients | #285 → `fb76aac` (CF-1 half); #308 → `d625eda` (request half) | Landed; phone question answers are open |
| CF-7 #280: plans and Notes | #289 → `f6976df` (first part); #312 → `f4cd67f` (clarifications) | Landed; verified steps are open |

## Integration matrix

| Requirement | Evidence | State |
| --- | --- | --- |
| Golden path: request → plan → approval → real edit → check → answer → Save to Notes → Open → restart restores, nothing re-runs | `e2e/conversation-fidelity.spec.ts` "golden path", against the real app, main process and `claude -p` adapter with a fake Claude CLI. Asserts file bytes, execution counts `{edits: 1, checksStarted: 1, checksFinished: 1}` before and after restart, plan statuses, outcomes, note revision 1 → 2 on the same page, and identical `thread:items` after restart | Verified with a fixture CLI, not a live provider |
| A plan or clarifying question answered during the path | "a clarifying question in the path", with a codex-cli 0.163.0-shaped fixture: answered on its card, the CLI reads one decision, then a real edit and check, Save to Notes with the clarification, and a restart where the card is inert and counts stay `{decisions: 1, edits: 1, checksStarted: 1, checksFinished: 1}`. `e2e/plan-clarification.spec.ts` adds a plan revision, a secret answer kept out of every file, and a stopped clarification saved as not answered | Verified (fixture) |
| Paired-client reconnect in the path | The phone, journal on: "a phone that reconnects after the decision was sent" below. A paired desktop: `test/request-journal.test.ts`, over TLS with a real journal | Verified (fixture for the phone, unit for a paired desktop) |
| Denial: file unchanged, nothing runs | "a denial leaves the file as it was and runs nothing": bytes unchanged, counts `{}` | Verified (fixture) |
| Command failure | "a failing check is a failed command": the tool is failed, and the plan step stays in progress | Verified (fixture) |
| Unknown outcome | CF-1 and CF-6 unit tests: a dropped stream; work left running at a restart | Verified (unit) |
| Stop while executing | "Stop while a check runs": stopped, the check never reports, nothing retried | Verified (fixture); CF-2 refines Stop |
| Native request withdrawal | "a native withdrawal": Claude's `control_cancel_request` closes the card as withdrawn, no answer reaches the CLI (`{}`), a late answer is refused, the file is unchanged | Verified (fixture) |
| Simultaneous desktop and phone answers | "the desktop and the phone answer at once", over the bridge and the companion's HTTPS: exactly one is accepted, the CLI reads one decision, the card names who gave it, the loser gets `already-resolved` or a 409, and the file matches the winner | Verified (fixture) |
| Reconnect after a decision send | "a phone that reconnects after the decision was sent", journal on: its delta shows the card answered by the desktop and sent, its late answer is a 409, and counts stay at one | Verified (fixture) |
| Old snapshot migration | `test/conversation-migration.test.ts` | Verified (unit) |
| Journal off | The golden fixture runs with the journal off, the default | Verified (fixture) |
| Expired cursor | Existing `event-journal.test.ts` resume and reload cases | Verified (unit, existing) |
| Stale Note revision | `task-context.test.ts`: a note edited since is kept and the new record becomes a new note | Verified (unit) |
| Missing artifact | — | Open: CF-5's owned-artifact actions |
| Outcomes, reasoning and provenance match recorded events | CF-1 fixture tests on Claude Code 2.1.302 and codex-cli 0.163.0 captures; CF-5 evidence tests | Verified on captures, not live |
| Themes and viewports | `e2e/conversation-fidelity.spec.ts` captures waiting, live, failed, completed and restored in Graphite, Jev and OpenCoven, at 900×600 and 1440×900, with no sideways scroll; `e2e/typed-turns.spec.ts` covers a typed turn in each theme at 900×600. 33 references are committed in [`screenshots/conversation-fidelity/`](../screenshots/conversation-fidelity/manifest.json) | Verified (fixture captures); human visual review open |
| Keyboard and reduced motion | Existing `app.spec.ts` accessibility test; the new elements add no animation | Partial; human VoiceOver open |
| Long transcript and streaming measurement | `e2e/transcript-measure.spec.ts` on a named Mac, before (`89c98f2`) and after; see [Measurements](#measurements-on-a-named-mac) | Verified on one machine; not a hardware-independent latency claim |
| Live Codex and Claude acceptance | Captures only (2026-10-18, Haiku 5.5 and gpt-6-astra, benign tasks) | Open: needs authorized live runs through the app |
| Human VoiceOver | — | Open: human |
| Fresh `pnpm build`, `typecheck`, `test`, `test:e2e` on a pinned candidate | Per-PR results in #282, #284, #285, #287, #289 | Open until a candidate is pinned |

## Commands and results for this preparation

On `cf8-fidelity`, on `main` at `f6976df` (CF-7 landed), macOS (Apple Silicon), Node v24.18.1, pnpm 10.34.5:

- `pnpm build` (all apps): passed.
- `npx playwright test e2e/conversation-fidelity.spec.ts e2e/task-to-notes.spec.ts`: 6 of 6 passed (44 s).

These are acceptance tests of behaviour CF-1 through CF-7 already built, so they had no red phase.

## Next

1. Pin a candidate SHA and run fresh full checks on it.
2. Run authorized live Codex and Claude smoke tasks through the app, and record versions, models and
   limits.
3. Get human keyboard and VoiceOver acceptance.

## Measurements on a named Mac

`e2e/transcript-measure.spec.ts`, run through the real app with `MODEX_MEASURE=<file>`. Five runs of
each build, interleaved, on 2026-10-18 between 15:05 and 15:15 UTC.

- **Machine:** MacBook Pro `Mac15,9`, Apple M3 Max (16 cores), 48 GB, macOS 26.7.1 (25G241),
  Electron 44.4.5, Node v24.18.1. Other sessions were running: the 1-minute load average was 52–58
  throughout.
- **Before:** `89c98f2`, `main` just before CF-1 (#282).
- **After:** this branch: `main` at `db0bbfd` plus the settle fix below.

**Opening a long transcript.** A saved 200-turn, 1,400-item Codex-shaped transcript (3.0 MB), timed
in the renderer from the click on its row until its last answer is in view. A cold open is the
thread's first load in that process; a repeat open reuses the window's copy.

| | Before | After |
| --- | --- | --- |
| Cold open, median (range) | 69 ms (67–89) | 73 ms (66–88) |
| Repeat open, median | 53 ms | 57 ms |
| `thread:items` round trip | 6–7 ms | 6–7 ms |
| Item events main sends on open | 0 | 0 |

**Streaming a 3 MiB command log.** A fixture Codex app-server sends 48 deltas of 64 KiB, 10 ms
apart, through the real backend, runner and IPC.

| | Before | After |
| --- | --- | --- |
| Bytes main sends the window | 80.2 MB | 0.66 MB |
| Largest single event | 3.1 MB | 262 KB |
| Main CPU, first item to idle, median (range) | 344 ms (277–363) | 240 ms (221–274) |
| First item to idle, median | 766 ms | 676 ms |
| Send to answer shown, median (range) | 1.86 s (1.41–1.93) | 1.30 s (1.16–1.87) |
| Renderer long tasks (over 50 ms) | 0 | 0 |

The byte counts are the same on any machine; the times are this Mac's under this load. The spec asserts
only the machine-independent bounds: no streamed event carries more than the 256 KB preview, and opening
a saved thread resends none of its items. The "before" build fails the first bound, as expected.

## Defects these checks found

Each one has a failing test first, then the fix, in the PR that added these checks.

- **Every thread resent all its items on first load** (CF-6, #279, since #285). Main compared the
  items it had settled with a second parse of the same file, so every item looked changed. It rewrote
  the file and sent one `item_update` per item to the window, the journal and paired clients. On the
  1,400-item transcript the cold open took 115–141 ms instead of about 70 ms. Bisected between
  `8e26534` (69–75 ms) and `fb76aac` (122–128 ms). `test/conversation-migration.test.ts` now asserts that
  a thread with nothing to settle sends nothing and keeps its file.
- **An approval card scrolled sideways at 900×600** (CF-3 surface, #276). With the Review pane open the
  transcript column is 319 px, and a long path plus the action row pushed Deny 160 px out of view. The
  question now wraps anywhere and the actions wrap.
- **The phone could not act on a thread started on the Mac** (companion, since #181 in v0.0.12; fixed in
  CF-6's request half, #279). A thread created from a Mac draft keeps the full UUID its draft reserved,
  but the companion's thread routes took only 8 hex characters, so answering, sending, setting the policy
  or archiving from the phone got a 404. The simultaneous-answer and reconnect variants found it;
  `test/companion.test.ts` failed first with a 404 for a UUID thread.
- **The typed-turns theme test checked Graphite three times** (CF-4, #277). It set the theme with
  `settings:update`, which the window applies only on its next refresh. Specs now switch themes through
  Settings (`setTheme` in `e2e/support.ts`) and wait for the window to show it.
