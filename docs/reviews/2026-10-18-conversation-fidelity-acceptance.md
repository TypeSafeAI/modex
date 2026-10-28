# Conversation fidelity acceptance, 2026-10-18 (preparation)

The acceptance receipt for tracker [#273](https://github.com/TypeSafeAI/modex/issues/273) and its
gate [#281](https://github.com/TypeSafeAI/modex/issues/281) (CF-8). **The gate is not passed.** This
receipt records what is verified, how, and every gate still open. A green mock or fixture test is not
recorded as live-provider or human acceptance.

## Candidate

**Historical candidate, 2026-10-20 06:04–06:25 UTC: `37406ee`** (#333). It included the slices
landed at that time, including #332, #335 (superseding #316) and #333 (superseding #295).
#336 had not landed yet. Later fixes and live checks are not covered by this candidate run;
use [status](../status.md) for current delivery state and repin before claiming a final gate.
The live Codex and human gates were open at this timestamp. Later Codex evidence is recorded
in the integration matrix below; human VoiceOver acceptance remains open.

**Integrated candidate, 2026-10-28: `b643617`.** Its first pass, live gates and matrix are in
[the section at the end](#integrated-candidate-2026-10-28-b643617). The tables between here and there
are the earlier records and are unchanged.

Run first pass, with no reruns, in a fresh worktree on an Apple M3 Max (48 GiB), macOS 26.7.1,
Node 24.18.1 and pnpm 10.34.5, from 06:04Z to 06:25Z. Load averages ran from about 4 to 34.

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passed |
| `pnpm build` | passed |
| `pnpm typecheck` | passed |
| `pnpm run test:worktrees` | 109/109 |
| `pnpm --filter @modex/core test` | 16/16 |
| `pnpm --filter @modex/desktop test` | 1,697 passed, 16 skipped of 1,713; second stage 21/21 |
| `pnpm --filter @modex/site test` | 10/10 |
| `pnpm --filter @modex/store-desktop test` | 16/16 |
| `pnpm --filter @modex/desktop test:e2e` | **363 passed, 6 skipped, 0 failed** (14.0 min) |
| `pnpm --filter @modex/site test:e2e` | 7/7 |
| iPhone UI, as `Scripts/test-e2e.sh` (iPhone 16 Pro, iOS 26.5, Xcode 26.6): `CompanionFlowTests` | 23/23 |
| iPhone UI, as `Scripts/test-e2e.sh`: `DemoWorkspaceTests` | 20/20 |

All six skipped e2e tests are opt-in, and none is a platform skip on macOS:
- `claude-live-stop`, 1 test (`MODEX_CLAUDE_LIVE=1`);
- `live-smoke`, 2 tests (`MODEX_LIVE_SMOKE=1`, recorded in [the live smoke review](2026-10-19-live-smoke.md));
- `knowledge`, 3 tests (`MODEX_TEST_OPEN_KNOWLEDGE=1`).

Each row below still names the build it was checked on.

## Children at the original integration snapshot

This table records the original slice receipts, not current issue closure. See [status](../status.md)
and the linked issues for later delivery.

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
| Missing artifact | `test/attachment-commands.test.ts`: "an attachment whose file was deleted cannot be opened, and nothing is revealed", supplied by #328 (merged as `b71e89e`); reconfirmed in the 2026-10-26 full unit run | Verified (unit); not live-provider or human acceptance |
| Outcomes, reasoning and provenance match recorded events | CF-1 fixture tests on Claude Code 2.1.302 and codex-cli 0.163.0 captures; CF-5 evidence tests | Verified on captures, not live |
| Themes and viewports | `e2e/conversation-fidelity.spec.ts` captures waiting, live, failed, completed and restored in Graphite, Jev and OpenCoven, at 900×600 and 1440×900, with no sideways scroll; `e2e/typed-turns.spec.ts` covers a typed turn in each theme at 900×600. 33 references are committed in [`screenshots/conversation-fidelity/`](../screenshots/conversation-fidelity/manifest.json) | Verified (fixture captures); human visual review open |
| Keyboard and reduced motion | Existing `app.spec.ts` accessibility test; the new elements add no animation | Partial; human VoiceOver open |
| Long transcript and streaming measurement | `e2e/transcript-measure.spec.ts` on a named Mac, before (`89c98f2`) and after; see [Measurements](#measurements-on-a-named-mac) | Verified on one machine; not a hardware-independent latency claim |
| Live Codex and Claude acceptance | [Live smoke, 2026-10-19](2026-10-19-live-smoke.md), `e2e/live-smoke.spec.ts` through the app. **Claude Code 2.1.304 (Haiku):** a real edit and check, the final answer, and Stop mid-command (interrupted; the file was never written). **codex-cli 0.163.0:** on 2026-10-19 the account refused the turn (`usage_limit_exceeded`); Modex showed `rate_limited` with the CLI's words and ran nothing. On 2026-10-20, with credits, the edit and check passed with a `final` answer, but **Stop left the command running** in a Codex background terminal (the file was written 30 s later). With the background-terminal fix, all three steps passed: Stop ended the command, and the file was never written. The web search ran but is not structured yet (CF-5) | Claude and Codex verified live, Codex with the Stop fix; CF-5's structured web search is still open |
| Human VoiceOver | [Keyboard and VoiceOver checklist](2026-10-20-keyboard-voiceover/checklist.md), with a seeded offline scenario. Its probes found four places where keyboard focus fell onto the page body: an answered approval, a folded turn, Stop, and Jump to latest. All four are fixed in #342 | Open: human, using the checklist on a build with #342 and #352 |
| Fresh `pnpm build`, `typecheck`, `test`, `test:e2e` on a pinned candidate | [Candidate](#candidate) `37406ee` on 2026-10-20: everything passed first pass. Desktop e2e 363 passed and 6 opt-in skips; the iPhone UI classes passed 23/23 and 20/20 | Historical result on `37406ee`; later slices require a new pinned run |

## Commands and results for this preparation

On `cf8-fidelity`, on `main` at `f6976df` (CF-7 landed), macOS (Apple Silicon), Node v24.18.1, pnpm 10.34.5:

- `pnpm build` (all apps): passed.
- `npx playwright test e2e/conversation-fidelity.spec.ts e2e/task-to-notes.spec.ts`: 6 of 6 passed (44 s).

These are acceptance tests of behaviour CF-1 through CF-7 already built, so they had no red phase.

## Next

1. Repin the final integrated candidate after the remaining slices land and run fresh full checks.
2. Retain the recorded live-provider receipts; repeat authorized smoke tasks on the final candidate
   where later changes affect those paths, recording versions, models and limits.
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


## Missing-artifact matrix correction — 2026-10-26

The missing-artifact row above was stale after #328 landed. Its deleted-attachment test passed again in the CR-7 integration repair's full unit run (2,163 passed, 22 skipped, zero failed); the test and attachment implementation match `main` at `deb373a3e34ddf890e7db9e2597c3e21ec6aa49c`. This corrects the unit-evidence classification only. The historical candidate receipts, unrun live rows and human acceptance decisions remain unchanged.


## Integrated candidate, 2026-10-28: `b643617`

**Candidate:** `main` at `b64361750983068160fe95293192ccea03000f88` (#422, 2026-10-28 10:25 UTC), in the
worktree `cf8-candidate-oct28`, cut from `origin/main` with `scripts/worktree.sh new`. It includes every
CF-1 to CF-7 slice named on #273 and #276–#280, among them #394 (CF-7: Claude's task tools and Codex's
proposed plan, merged 2026-10-24 as `70123b9`) and the CF-4 close-out from #371, which landed through #404
(`e3527f4`, 2026-10-24; #371 itself was closed as superseded). Nothing that affects the matrix was
excluded: the open PRs at this time (#417, #419, #420, #423–#426) are local-model, Code Review and docs
work outside this scope, and #420 is the docs record of the CF-3 rows for this gate.

**Earlier candidates as history.** The 2026-10-22 candidates `0e674e7` and `ec7be57` were run in the
`cf8-integrated-oct22` worktree and never pushed. Their receipts and reports are carried forward unchanged:
[`0e674e7`](2026-10-22-cf8-integrated-candidate.md) with its [commands](2026-10-22-cf8-command-results.json),
[live Claude report](2026-10-22-cf8-live-claude.json) and [measurement](2026-10-22-cf8-transcript-measure.json), and
[`ec7be57`](2026-10-22-cf8-ec7be57-candidate.md) with its [commands](2026-10-22-cf8-ec7be57-command-results.json),
[live Claude report](2026-10-22-cf8-ec7be57-live-claude.json) and [measurement](2026-10-22-cf8-ec7be57-transcript-measure.json).
Their 33 candidate captures and raw logs stay outside the tree, in that worktree's staged
`docs/screenshots/conversation-fidelity/2026-10-22-candidate/` and in
`~/.codex/attachments/cf8-integrated-oct22-evidence/` and `…/cf8-integrated-ec7be57-evidence/`. Their live Claude
probe (Claude Code 2.1.309) passed the edit, check, Notes, restart and Stop steps and failed on its own
expectation of a structured plan, which Claude Code 2.1.308 and later no longer offer Modex; the probe below
expects what Modex shows instead. Those results are evidence for those SHAs only.

### First pass

Run once, in order, with no reruns, by `apps/desktop/.probes/cf8-first-pass-b643617.py` (git-ignored). Each
row records its exact command, start and end, exit code and HEAD in
`~/.claude/task-evidence/cf8-2026-10-28/first-pass/results.jsonl`, with one log per command beside it.

**Machine:** Apple M5 Max, 128 GiB, macOS 27.0.1, Node v24.22.0, pnpm 10.34.5, Xcode 27.1 (27A9275). Disk
free before the worktree: 6.4 TiB. Other sessions were running: the 1-minute load average was 14 at the
start and reached 158 during the typecheck.

| Command | Start–end (UTC) | Result |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | 11:50:34–11:50:38 | passed (the worktree helper had already installed; not a cold install) |
| `pnpm build` | 11:50:38–11:51:43 | passed |
| `pnpm typecheck` | 11:51:43–11:52:47 | passed |
| `pnpm test` | 11:52:47–11:57:57 | passed, exit 0: worktree scripts 117/117; core 16/16; **desktop 2,011 passed, 17 skipped, 0 failed, 0 cancelled of 2,028**, second stage 21 passed, 6 skipped of 27; site 10/10; store-desktop 16/16 |
| `pnpm test:e2e` | 11:57:57–12:21:08 | passed, exit 0: **desktop 470 passed, 7 skipped, 0 failed of 477** (22.7 min); site 7/7 |
| iPhone UI, as `Scripts/test-e2e.sh` | 12:21:08–12:27:01 | passed, exit 0: `CompanionFlowTests` **23/23** (135.8 s), `DemoWorkspaceTests` **20/20** (162.4 s) |

Skips, all platform or opt-in, none a failure:
- desktop unit, first stage (17): 16 Windows-only cases (recovery writes, npm and `.bin` shims, CLI job and PTY
  descendant cleanup, admission) and the pinned Open Knowledge case;
- desktop unit, second stage (6): the native CLI isolation proofs (`code-review-isolation.native.test.mjs`), opt-in;
- desktop e2e (7): `claude-live-stop` (1, `MODEX_CLAUDE_LIVE=1`), `live-smoke` (3, `MODEX_LIVE_SMOKE=1`) and
  `knowledge` (3, `MODEX_TEST_OPEN_KNOWLEDGE=1`).

The iPhone script's default destination (iPhone 16 Pro, iOS 26.5) is not installed on this Mac. As CI does,
the run named a simulator by UDID: a dedicated `modex-cf8-oct28` (iPhone 17, iOS 27.0,
`8EDBC0B8-8D29-4A5F-B1DA-7A5EDF561788`), booted before the build, with its own derived data. This is
simulator evidence; it says nothing about a physical iPhone.

### Live gates on the candidate

Both run through the real app, main process and native adapter with
`apps/desktop/.probes/live-golden-b643617.spec.ts` (git-ignored, derived from `e2e/live-smoke.spec.ts`), in Chat
mode so the CLI asks before it edits or runs, in a disposable repository with `greeting.txt` = `hello`. The
steps: request → plan, when the CLI offers a plan tool → approve each card → a real edit → the check
`grep -q 'hello, live' greeting.txt` → final answer → Save to Notes → Open → quit and relaunch → the same
items and note, the file unchanged → then, in a new thread, Stop two seconds into an approved 30-second
command, and 31 seconds later the file it would have written does not exist.

**Plan expectation.** Claude Code 2.1.308 and later offer Modex no `TodoWrite`, and Modex does not set
`CLAUDE_CODE_ENABLE_TODO_TOOLS` ([task-context](../task-context.md#plans), Val's option 1). The probe
therefore accepts a plan item only when the transcript holds confirmed `TaskCreate`/`TaskUpdate` (or
`TodoWrite`) calls; otherwise it requires the footer and the saved note to read "Claude Code reported no plan
for this turn". Codex outside plan mode has never sent `turn/plan/updated` live, so the same rule applies
with Codex's words. The prompt asks for a plan only "if you have a task-list or todo planning tool
available", and not to search for one.

**Attempts.** The probe's first two starts are kept as history in `~/.claude/task-evidence/cf8-2026-10-28/`:
`live-claude-20261028T122751Z-probe-script-error` failed in the probe itself before any CLI launched (an ESM
`__dirname`), and `live-claude-20261028T122947Z-note-path-assertion` completed the Claude turn (one approval, the
edit and the check succeeded, no plan) and then failed on a probe assertion that the saved note never names the
project directory: Claude had written the directory in full into its own `sed` command, and the note records the
command's text. That assertion now records the fact instead. Neither attempt is a Modex failure; the third start is
the result below. Each start spent one Claude turn.

#### Claude Code 2.1.312 (`claude -p`, Haiku, Chat mode): passed, 2026-10-28 12:31–12:32 UTC

`live-claude-20261028T123121Z/report.claude.json`, exit 0, 1.0 min.

| Step | Observed |
| --- | --- |
| Request and approval | Claude read the file, then called `Edit`, which **failed**: "No such tool available: Edit. Edit is disabled for this session". That is Chat mode, which launches the CLI with `--disallowedTools Edit Write NotebookEdit`; Modex recorded the call as `failed`, not as succeeded. Claude then asked to run `sed -i '' 's/hello/hello, live/' …/greeting.txt`; **one approval card**, approved in the window. |
| Real edit and check | The `sed` command succeeded and the file reads `hello, live`. `$ grep -q 'hello, live' greeting.txt` succeeded. No exit code, as Claude Code reports none. |
| Final answer | The last assistant item has phase `unspecified` (Claude Code reports no phase). Two reasoning items, outcome `succeeded`. No failure card. |
| Plan | **No plan tool was offered or called:** zero plan items, zero `TaskCreate`/`TaskUpdate`/`TodoWrite` calls. The footer read "Claude Code reported no plan for this turn", and the saved note's Plan section says the same. This is the expected result on Claude Code 2.1.308 and later. |
| Save to Notes, Open, restart | Saved as a `Task:` note, revision 1, naming `greeting.txt` and the `grep -q` check; the note did not name the project directory. Open showed "From modex thread …". After quit and relaunch, `thread:items` was identical, the note identical, and `greeting.txt` unchanged. |
| Stop mid-command | Approved `python3 -c "import time; time.sleep(30); open('live-stop.txt', 'w')"`; Stop two seconds in. The thread was idle **809 ms** after Stop, the call ended `done` with outcome `interrupted`, the notice reads "Stopped.", no failure card. 31 s later `live-stop.txt` did not exist. |

#### codex-cli 0.164.0 (`codex app-server`, ChatGPT account, `gpt-6.1-sol`, Chat mode): passed, 2026-10-28 12:33–12:34 UTC

`live-codex-20261028T123300Z/report.codex.json`, exit 0, 1.3 min, first start. The model is the CLI's configured
default; Codex's own rollouts for the two threads record `model: gpt-6.1-sol`, collaboration mode `default`,
approval policy `untrusted` and a read-only sandbox. `default_mode_request_user_input` was off and `unified_exec` on.

| Step | Observed |
| --- | --- |
| Request and approvals | A commentary message (`nativePhase: commentary`) and a reasoning item, then `apply_patch` on `greeting.txt` succeeded after **the first approval card**; the check asked a **second card**. Two approvals, both in the window. |
| Real edit and check | The file reads `hello, live`. `$ grep -q 'hello, live' greeting.txt` succeeded with **exit code 0**, which Codex reports. |
| Final answer | The last assistant item has phase `final` (`nativePhase: final_answer`). No failure card. |
| Plan | **No `turn/plan/updated` arrived:** zero plan items, and the rollouts hold no plan rows. The footer read "Codex reported no plan for this turn", and the saved note's Plan section says the same. This matches the live captures on `task-context.md`: outside plan mode, Codex has not offered its plan tool. |
| Save to Notes, Open, restart | Saved as a `Task:` note, revision 1, naming `greeting.txt` and the check; the note did not name the project directory. Open showed "From modex thread …". After quit and relaunch, `thread:items` was identical, the note identical, and `greeting.txt` unchanged. |
| Stop mid-command | Approved the 30-second `python3` command; Stop two seconds in. The thread was idle **118 ms** after Stop, the call ended `done` with outcome `interrupted`, the notice reads "Stopped.", no failure card. 31 s later `live-stop.txt` did not exist: the background-terminal fix from the 2026-10-20 live smoke holds on 0.164.0. |

Neither CLI reached a live structured question or a live step plan in these turns, and neither was asked to: the
CF-3 question rows are Val's (below), and a live `turn/plan/updated` stays on the "Not done yet" list in
[task-context](../task-context.md#not-done-yet). What both runs do show is the full golden path, approvals included,
and a Stop that ends the command, on the candidate.

### Matrix on `b643617`

Every row names the kind of evidence it has on this candidate: fixture, unit, live or human. A fixture or
unit pass is not live-provider or human acceptance. The fixture and unit rows ran inside the first pass above.

| Requirement | Evidence on `b643617` | State |
| --- | --- | --- |
| Golden path: request → plan → approval → real edit → check → answer → Save to Notes → Open → restart restores, nothing re-runs | `e2e/conversation-fidelity.spec.ts` "golden path" with the fixture Claude CLI, in the 470 passed; live Claude and Codex above | Verified (fixture); live: see above |
| A plan or clarifying question answered during the path | "a clarifying question in the path" and `e2e/plan-clarification.spec.ts`, in the 470 passed; `e2e/codex-native-plan.spec.ts` for Codex's plan mode | Verified (fixture) |
| Paired-client reconnect in the path | "a phone that reconnects after the decision was sent" (fixture, journal on); `test/request-journal.test.ts` and `test/question-replay.test.ts` (unit, real TLS) | Verified (fixture, unit) |
| Denial: file unchanged, nothing runs | "a denial leaves the file as it was and runs nothing" | Verified (fixture) |
| Command failure | "a failing check is a failed command" | Verified (fixture) |
| Unknown outcome | CF-1 and CF-6 unit tests: a dropped stream; work left running at a restart (`test/conversation-migration.test.ts`) | Verified (unit) |
| Stop while executing | "Stop while a check runs" (fixture); live Claude and Codex Stop above | Verified (fixture); live: see above |
| Native request withdrawal | "a native withdrawal" | Verified (fixture) |
| Simultaneous desktop and phone answers | "the desktop and the phone answer at once" | Verified (fixture) |
| Reconnect after a decision send | "a phone that reconnects after the decision was sent", journal on | Verified (fixture) |
| Old snapshot migration | `test/conversation-migration.test.ts`, including v0.3.0 history and older paired desktops | Verified (unit) |
| Journal off | The golden fixture runs with the journal off, the default | Verified (fixture) |
| Expired cursor | `test/event-journal.test.ts` resume and reload cases; `test/question-replay.test.ts` 8 MB slow-stream drop | Verified (unit) |
| Stale Note revision | `test/task-context.test.ts`: a note edited since is kept, and a note moved across projects (#363) | Verified (unit) |
| Missing artifact | `test/attachment-commands.test.ts` "an attachment whose file was deleted cannot be opened, and nothing is revealed" (#328): **passed in this first pass** (log line 240 of `test.log`) | Verified (unit); not live or human |
| Outcomes, reasoning and provenance match recorded events | CF-1 fixture tests on Claude Code 2.1.302 and codex-cli 0.163.0 captures; CF-5 evidence tests; CF-7 live captures replayed in `test/claude-live-capture.test.ts` (2.1.309 task tools) and `test/codex-live-capture.test.ts` (`gpt-6.1-sol` plan mode) | Verified on captures; live outcomes recorded above |
| Themes and viewports | `e2e/conversation-fidelity.spec.ts` captures and `e2e/typed-turns.spec.ts`, in the 470 passed; the CF-4 close-out's reference-viewport captures (#404) | Verified (fixture captures); human visual review: Val |
| Keyboard and reduced motion | `e2e/app.spec.ts` accessibility, `e2e/keyboard-answers.spec.ts` (#342, #352), the CF-4 close-out's named table and code scroll regions and reduced-motion coverage (#404), in the 470 passed | Verified (fixture); human: Val, rows A1–A8, B1–B7, C1–C5 |
| Long transcript and streaming measurement | `e2e/transcript-measure.spec.ts`, in the 470 passed: no streamed event over the 256 KB preview, no items resent on open; the CF-4 first-open budget passed in the same run: five fresh launches of the 200-turn transcript opened in 246.5, 248.4, 242.5, 257.3 and 240.5 ms, median **246.5 ms ≤ 500 ms** | Verified (fixture, machine-independent bounds); the [named-Mac measurements](#measurements-on-a-named-mac) are the historical comparison |
| Live Codex and Claude acceptance | This section's live gates | See above |
| Human keyboard and VoiceOver | [Checklist](2026-10-20-keyboard-voiceover/checklist.md) A1–A8, B1–B7 and C1–C5 on the seeded build from this candidate (below) | **Open: Val.** No row is recorded here until Val reports it |
| CF-3 native question, human | [Steps](2026-10-22-cf3-question-acceptance.md) D1–D5, V1–V3 and P1–P6; #420 holds the prepared run on `6c9000f`; between `6c9000f` and `b643617` only #421 (Companion tests) and #422 (the Code Review agent) landed, and neither touches the question broker, the cards, the Companion app or an ordinary Claude or Codex turn (#422 adds a separate confined launch path to `claude.ts` that a review run alone uses) | **Open: Val.** P rows also wait on Companion 0.4.0 (9) reaching TestFlight |
| CF-6 gates beyond the tests | [CF-6 gates](2026-10-22-cf6-gates.md): live Codex and Claude with the journal on passed on 2026-10-22; the 8 MB drop and power-loss proxies are unit tests in this first pass | Verified (live 2026-10-22, unit); **deferred by Val in writing on 2026-10-23:** a real power cut, the Windows and Linux app sessions ("accepted the CI suites") and the physical iPhone ("Defer it, close #279", on #279) |
| Fresh `pnpm build`, `typecheck`, `test`, `test:e2e` on a pinned candidate | [First pass](#first-pass) above, all first pass, all passed | Verified on `b643617` |

### Human review build

The seeded offline scenario from the [checklist](2026-10-20-keyboard-voiceover/checklist.md) was launched from this
candidate on 2026-10-28 at about 12:40 UTC, for Val:

```sh
# from .worktrees/cf8-candidate-oct28/apps/desktop, built at b643617
node ../../docs/reviews/2026-10-20-keyboard-voiceover/seed.mjs /tmp/modex-voiceover-b643617
MODEX_HOME=/tmp/modex-voiceover-b643617/home npx electron .
```

It uses the scripted engine, a disposable home and repository, and spends no CLI usage. The build carries #342,
#352 and the CF-4 close-out (#404), so rows A1–A8, B1–B7 and C1–C5 all apply. The CF-3 rows D1–D5, V1–V3 and
P1–P6 use the Mac build and disposable project that #420 records (built from `6c9000f`; the question path is
unchanged on `b643617`, see the matrix), with Plan mode on a Codex thread. Results are added here exactly as Val
reports them, through a docs-only signed PR. **No human row is recorded as passed here.**

### What is open on this candidate

| Row | Owner | Next action |
| --- | --- | --- |
| Keyboard A1–A8 and VoiceOver B1–B7 | Val | Run the seeded build above and post the filled tables on #281 |
| Markdown C1–C5 | Val | Same build, the **Markdown review** thread, 900×600 with Review open, three themes, Reduce Motion for C3 |
| CF-3 D1–D5, V1–V3 | Val | The #420 Mac build, Plan mode on a Codex thread; post on #276 and #281 |
| CF-3 P1–P6 | Val | Upload Companion 0.4.0 (9) to TestFlight first; P6 needs an older Companion at hand |

Everything else in the matrix has fixture, unit or live evidence on `b643617`, or Val's written deferral. #281 closes
when these rows have Val's result or written deferral. No tag, release, merge-queue entry or policy default
changes with this receipt.
